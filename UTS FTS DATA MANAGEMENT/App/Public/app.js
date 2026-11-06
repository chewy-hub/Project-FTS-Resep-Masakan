// Antarmuka pencarian resep. Semua pencarian dijalankan PostgreSQL lewat /api/*.
const EXAMPLES = ['chicken garlic soup', 'chocolate cake', '"fried chicken" -spicy', 'vegetarian pasta'];

const $ = (id) => document.getElementById(id);
const rupiahStyle = new Intl.NumberFormat('id-ID');
const fmtInt = (n) => rupiahStyle.format(n);
const fmtMs = (x) => x.toFixed(1).replace('.', ',');
const fmtMs2 = (x) => x.toFixed(2).replace('.', ',');

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

let currentQuery = '';

async function api(path, params = {}) {
  const url = new URL(path, window.location.origin);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Server membalas status ${res.status}`);
  return body;
}

const showError = (el, err) => {
  el.innerHTML = `<p class="galat">Tidak bisa mengambil data: ${esc(err.message)}. ` +
    'Periksa bahwa PostgreSQL berjalan dan kolom search_vector sudah dibuat.</p>';
};

// ------------------------------------------------------------ tab
const tabs = ['hasil', 'cara', 'performa'];

function selectTab(name) {
  tabs.forEach((t) => {
    const active = t === name;
    $(`tab-${t}`).setAttribute('aria-selected', String(active));
    $(`tab-${t}`).tabIndex = active ? 0 : -1;
    $(`panel-${t}`).hidden = !active;
  });
  if (name === 'cara') loadTokens();
}

tabs.forEach((t) => {
  $(`tab-${t}`).addEventListener('click', () => selectTab(t));
  $(`tab-${t}`).addEventListener('keydown', (e) => {
    const i = tabs.indexOf(t);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      selectTab(next);
      $(`tab-${next}`).focus();
    }
  });
});

// ------------------------------------------------------------ pengaturan
const settings = () => ({
  limit: $('limit').value,
  minRating: $('minRating').value,
  rank: $('rank').value,
  ratingWeight: $('ratingWeight').value,
  useIndex: $('useIndex').checked,
});

$('ratingWeight').addEventListener('input', () => {
  $('ratingWeightOut').textContent = Number($('ratingWeight').value).toFixed(1).replace('.', ',');
});

// ------------------------------------------------------------ hasil
function renderResult(r) {
  let bahan = r.ingredients;
  if (bahan.length > 140) bahan = `${bahan.slice(0, 140).replace(/,[^,]*$/, '')}, ...`;
  const rating = r.rating === null ? 'belum ada rating' : `rating ${r.rating.toFixed(1).replace('.', ',')}`;
  // name dan description sudah di-escape server, hanya <mark> yang tersisa.
  return `<article class="hasil">
    <div class="baris">
      <h3 class="nama">${r.name}</h3>
      <span class="skor">skor ${r.score.toFixed(2)}</span>
    </div>
    <div class="meta">${esc(r.category || 'Tanpa kategori')}, ${rating}</div>
    <p class="cuplikan">${r.description}</p>
    <p class="bahan">Bahan: ${esc(bahan)}</p>
  </article>`;
}

async function search(q) {
  q = q.trim();
  currentQuery = q;
  $('q').value = q;
  selectTab('hasil');
  if (!q) {
    $('ringkas').textContent = '';
    return;
  }
  $('ringkas').textContent = 'Mencari...';
  try {
    const data = await api('/api/search', { q, ...settings() });
    if (!data.rows.length) {
      $('ringkas').textContent = '';
      $('hasil').innerHTML =
        '<p class="kosong">Tidak ada resep yang cocok. Coba kata lain, atau turunkan rating minimum di pengaturan.</p>';
      return;
    }
    const kondisi = data.useIndex ? 'dengan index' : 'tanpa index';
    $('ringkas').textContent =
      `${fmtInt(data.hits)} resep cocok. Menampilkan ${data.rows.length} teratas, ` +
      `diurutkan dalam ${fmtMs(data.ms)} ms (${kondisi}).`;
    $('hasil').innerHTML = data.rows.map(renderResult).join('');
  } catch (err) {
    $('ringkas').textContent = '';
    showError($('hasil'), err);
  }
}

$('form-cari').addEventListener('submit', (e) => {
  e.preventDefault();
  search($('q').value);
});

$('contoh').innerHTML = EXAMPLES.map((e) => `<button type="button">${esc(e)}</button>`).join('');
$('contoh').addEventListener('click', (e) => {
  if (e.target.tagName === 'BUTTON') search(e.target.textContent);
});

// ------------------------------------------------------------ cara kerja
async function loadTokens() {
  const el = $('cara');
  if (!currentQuery) {
    el.innerHTML = '<p class="kosong">Cari sesuatu dulu. Di sini terlihat bagaimana kata pencarian diproses sebelum dicocokkan.</p>';
    return;
  }
  el.innerHTML = '<p class="kosong">Memuat...</p>';
  try {
    const d = await api('/api/tokens', { q: currentQuery });
    const baris = d.tokens
      .map((t) => `<tr><td>${esc(t.token)}</td><td>${esc(t.alias)}</td>` +
        `<td>${t.lexemes.length ? esc(t.lexemes.join(', ')) : '(dibuang, stop word)'}</td></tr>`)
      .join('');
    el.innerHTML = `
      <p class="langkah">1. Tokenization dan normalization</p>
      <p class="ket">Kata pencarian dipecah, huruf dikecilkan, stop words dibuang, lalu di-stem.</p>
      <div class="gulir"><table>
        <thead><tr><th>Kata asli</th><th>Jenis token</th><th>Lexeme</th></tr></thead>
        <tbody>${baris}</tbody>
      </table></div>
      <p class="langkah">2. tsquery yang dipakai untuk mencocokkan</p>
      ${d.tsquery
        ? `<pre><code>${esc(d.tsquery)}</code></pre><p class="ket">Dicocokkan dengan kolom search_vector memakai operator @@.</p>`
        : '<p class="galat">Semua kata di pencarian ini adalah stop words, jadi tidak ada yang bisa dicocokkan.</p>'}
      <p class="langkah">3. Query yang dijalankan</p>
      <pre><code>${esc(d.sql)}</code></pre>`;
  } catch (err) {
    showError(el, err);
  }
}

// ------------------------------------------------------------ performa
async function loadInfo() {
  try {
    const info = await api('/api/info');
    $('sub').textContent = `${fmtInt(info.total)} Pencarian resep Food.com `;
    $('daftar-index').innerHTML = `<table>
      <thead><tr><th>Nama index</th><th>Ukuran</th><th>Definisi</th></tr></thead>
      <tbody>${info.indexes
        .map((i) => `<tr><td>${esc(i.nama)}</td><td>${esc(i.ukuran)}</td><td><code>${esc(i.definisi)}</code></td></tr>`)
        .join('')}</tbody></table>`;
  } catch (err) {
    $('sub').textContent = 'Tidak bisa terhubung ke database.';
    showError($('hasil'), err);
  }
}

$('tombol-bandingkan').addEventListener('click', async () => {
  const out = $('performa');
  if (!currentQuery) {
    out.innerHTML = '<p class="kosong">Cari sesuatu dulu, lalu jalankan perbandingan untuk kata itu.</p>';
    return;
  }
  const btn = $('tombol-bandingkan');
  btn.disabled = true;
  btn.textContent = 'Mengukur 3 kali untuk tiap kondisi...';
  try {
    const { hasil } = await api('/api/explain', { q: currentQuery });
    const maks = Math.max(...hasil.map((h) => h.rata));
    const tabel = hasil
      .map((h) => `<tr><td>${esc(h.kondisi)}</td>
        ${h.waktu.map((w) => `<td class="angka">${fmtMs2(w)}</td>`).join('')}
        <td class="angka">${fmtMs2(h.rata)}</td><td>${esc(h.metode)}</td></tr>`)
      .join('');
    const batang = hasil
      .map((h, i) => `<div class="batang"><span>${esc(h.kondisi)}</span>
        <span class="isi ${i === 0 ? 'lambat' : ''}" style="width:${Math.max(1, (h.rata / maks) * 100)}%"></span>
        <span class="nilai">${fmtMs2(h.rata)} ms</span></div>`)
      .join('');
    const [tanpa, dengan] = hasil;
    const kali = dengan.rata > 0 ? `<p>Dengan index, query ini sekitar <strong>${(tanpa.rata / dengan.rata).toFixed(1).replace('.', ',')} kali</strong> lebih cepat.</p>` : '';
    out.innerHTML = `
      <div class="gulir"><table>
        <thead><tr><th>Kondisi</th><th class="angka">Percobaan 1 (ms)</th><th class="angka">Percobaan 2 (ms)</th>
          <th class="angka">Percobaan 3 (ms)</th><th class="angka">Rata-rata (ms)</th><th>Metode scan</th></tr></thead>
        <tbody>${tabel}</tbody>
      </table></div>
      ${batang}
      ${kali}
      <p class="ket">Percobaan pertama biasanya paling lambat karena data baru dibaca dari disk.
        Jika kedua kondisi memakai metode scan yang sama, berarti belum ada index (GIN atau GiST) pada search_vector.</p>`;
  } catch (err) {
    showError(out, err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Bandingkan sekarang';
  }
});

loadInfo();

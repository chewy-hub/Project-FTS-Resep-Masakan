// Cari resep: server Express untuk PostgreSQL Full-Text Search.
// Jalankan dari folder App:  npm install  lalu  npm start
require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.PGPASSWORD) {
  console.error('PGPASSWORD belum diisi. Salin .env.example menjadi .env lalu isi password PostgreSQL.');
  process.exit(1);
}

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'recipes_fts',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
});

// Penanda sementara untuk highlight. Teks di-escape dulu, baru penanda
// diganti jadi <mark>, supaya teks resep tidak bisa menyisipkan HTML.
const HL_START = 'ZZHLSTARTZZ';
const HL_END = 'ZZHLENDZZ';
const OPT_NAME = `StartSel=${HL_START}, StopSel=${HL_END}`;
const OPT_DESC = `${OPT_NAME}, MaxWords=30, MinWords=12`;

const RANK_FUNCS = { ts_rank_cd: 'ts_rank_cd', ts_rank: 'ts_rank' };

const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const highlight = (s) =>
  escapeHtml(s).split(HL_START).join('<mark>').split(HL_END).join('</mark>');

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

// Satu query dalam satu transaksi. Kalau useIndex=false, planner dilarang
// memakai index selama transaksi ini saja (index tidak dihapus).
async function run(sql, params = [], useIndex = true) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!useIndex) {
      await client.query('SET LOCAL enable_indexscan = off');
      await client.query('SET LOCAL enable_bitmapscan = off');
      await client.query('SET LOCAL enable_indexonlyscan = off');
    }
    const t0 = process.hrtime.bigint();
    const res = await client.query(sql, params);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    await client.query('COMMIT');
    return { rows: res.rows, ms };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const buildSearchSql = (rankFn) => `
WITH q AS (SELECT websearch_to_tsquery('english', $1::text) AS tsq),
top AS (
    SELECT r.recipe_id, r.name, r.description, r.category, r.ingredients, r.rating,
           ${rankFn}(r.search_vector, q.tsq, 32)
             * (1 + $4::float8 * coalesce(r.rating, 0)::float8 / 5.0) AS skor
    FROM recipes r, q
    WHERE r.search_vector @@ q.tsq
      AND coalesce(r.rating, 0) >= $2::numeric
    ORDER BY skor DESC
    LIMIT $3::int
)
SELECT t.recipe_id, t.name, t.category, t.rating::float8 AS rating, t.skor, t.ingredients,
       ts_headline('english', t.name, q.tsq, $5::text) AS name_hl,
       ts_headline('english', coalesce(t.description, ''), q.tsq, $6::text) AS desc_hl
FROM top t, q
ORDER BY t.skor DESC`;

const COUNT_SQL = `
SELECT count(*)::int AS n
FROM recipes r, websearch_to_tsquery('english', $1::text) AS tsq
WHERE r.search_vector @@ tsq
  AND coalesce(r.rating, 0) >= $2::numeric`;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
};

const readQuery = (req) => String(req.query.q ?? '').trim().slice(0, 200);

// Info dataset dan daftar index
app.get('/api/info', wrap(async (req, res) => {
  const total = (await run('SELECT count(*)::int AS n FROM recipes')).rows[0].n;
  const indexes = (await run(
    `SELECT indexname AS nama,
            pg_size_pretty(pg_relation_size(quote_ident(indexname)::regclass)) AS ukuran,
            indexdef AS definisi
     FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'recipes'
     ORDER BY indexname`
  )).rows;
  res.json({ total, indexes });
}));

// Pencarian: ranking lalu highlighting
app.get('/api/search', wrap(async (req, res) => {
  const q = readQuery(req);
  if (!q) return res.json({ rows: [], hits: 0, ms: 0 });

  const limit = clamp(req.query.limit, 1, 50, 10);
  const minRating = clamp(req.query.minRating, 0, 5, 0);
  const ratingWeight = clamp(req.query.ratingWeight, 0, 1, 0.2);
  const rankFn = RANK_FUNCS[req.query.rank] || 'ts_rank_cd';
  const useIndex = req.query.useIndex !== 'false';

  const params = [q, minRating, limit, ratingWeight, OPT_NAME, OPT_DESC];
  const search = await run(buildSearchSql(rankFn), params, useIndex);
  const hits = (await run(COUNT_SQL, [q, minRating])).rows[0].n;

  res.json({
    hits,
    ms: search.ms,
    useIndex,
    rows: search.rows.map((r) => ({
      id: r.recipe_id,
      name: highlight(r.name_hl),
      category: r.category || '',
      rating: r.rating,
      score: r.skor,
      description: highlight(r.desc_hl),
      ingredients: r.ingredients || '',
    })),
  });
}));

// Cara kerja: kata pencarian setelah tokenization dan normalization
app.get('/api/tokens', wrap(async (req, res) => {
  const q = readQuery(req);
  if (!q) return res.json({ tsquery: '', tokens: [], sql: buildSearchSql('ts_rank_cd').trim() });
  const tsquery = (await run(`SELECT websearch_to_tsquery('english', $1::text)::text AS t`, [q])).rows[0].t;
  const tokens = (await run(
    `SELECT token, alias, lexemes FROM ts_debug('english', $1::text) WHERE alias <> 'blank'`,
    [q]
  )).rows;
  res.json({
    tsquery,
    tokens: tokens.map((t) => ({ token: t.token, alias: t.alias, lexemes: t.lexemes || [] })),
    sql: buildSearchSql('ts_rank_cd').trim(),
  });
}));

// Performa: query yang sama 3x tanpa index dan 3x dengan index
const scanTypes = (node, found = []) => {
  if ((node['Node Type'] || '').includes('Scan') && !found.includes(node['Node Type'])) {
    found.push(node['Node Type']);
  }
  (node.Plans || []).forEach((child) => scanTypes(child, found));
  return found;
};

app.get('/api/explain', wrap(async (req, res) => {
  const q = readQuery(req);
  if (!q) return res.status(400).json({ error: 'Kata pencarian kosong.' });

  const sql = `EXPLAIN (ANALYZE, FORMAT JSON)
               SELECT recipe_id FROM recipes
               WHERE search_vector @@ websearch_to_tsquery('english', $1::text)`;
  const hasil = [];
  for (const [useIndex, label] of [[false, 'Tanpa index'], [true, 'Dengan index']]) {
    const waktu = [];
    let metode = '';
    for (let i = 0; i < 3; i += 1) {
      const out = await run(sql, [q], useIndex);
      let plan = out.rows[0]['QUERY PLAN'];
      if (typeof plan === 'string') plan = JSON.parse(plan);
      waktu.push(plan[0]['Execution Time']);
      metode = scanTypes(plan[0].Plan).join(' + ');
    }
    hasil.push({
      kondisi: label,
      waktu,
      rata: waktu.reduce((a, b) => a + b, 0) / waktu.length,
      metode,
    });
  }
  res.json({ hasil });
}));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Cari resep aktif di http://localhost:${port}`);
});

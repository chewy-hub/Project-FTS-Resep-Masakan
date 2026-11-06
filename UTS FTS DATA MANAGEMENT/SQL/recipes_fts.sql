-- =====================================================================
-- TUGAS PENGGANTI UTS DATA MANAGEMENT
-- PostgreSQL Full-Text Search: Pencarian Resep Makanan
-- Dataset: Food.com - Recipes and Reviews (Kaggle, irkaal)
-- Butuh PostgreSQL 12+ (karena pakai generated column)
-- Jalankan dari folder utama proyek lewat psql
-- =====================================================================



-- BAGIAN 1. TABEL
DROP TABLE IF EXISTS recipes;

CREATE TABLE recipes (
    recipe_id    BIGINT PRIMARY KEY,
    name         TEXT,
    description  TEXT,
    category     TEXT,
    keywords     TEXT,
    ingredients  TEXT,
    instructions TEXT,
    rating       NUMERIC
);

-- BAGIAN 2. IMPORT DATA
\copy recipes FROM 'Data/recipes_clean.csv' CSV HEADER

SELECT count(*) AS jumlah_resep FROM recipes;
SELECT recipe_id, name, keywords FROM recipes LIMIT 5;


-- BAGIAN 3. TOKENIZATION & NORMALIZATION
SELECT to_tsvector('english',
       'Cooking the chicken soups with garlic and onions');

SELECT * FROM ts_debug('english',
       'Cooking the chicken soups with garlic');

SELECT to_tsvector('english', 'running runs ran') AS english,
       to_tsvector('simple',  'running runs ran') AS simple;

SELECT to_tsquery('english', 'cooking & chicken');

SELECT name, to_tsvector('english', name) AS lexemes
FROM recipes
LIMIT 5;


-- BAGIAN 4. KOLOM tsvector (A=nama, B=keywords, C=deskripsi, D=bahan)
ALTER TABLE recipes DROP COLUMN IF EXISTS search_vector;

ALTER TABLE recipes ADD COLUMN search_vector tsvector
GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')),        'A') ||
    setweight(to_tsvector('english', coalesce(keywords, '')),    'B') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(ingredients, '')), 'D')
) STORED;

SELECT name, search_vector
FROM recipes
LIMIT 3;

SELECT pg_size_pretty(pg_total_relation_size('recipes')) AS ukuran_tabel;



-- BAGIAN 5. PENCARIAN DASAR (belum pakai index)
SELECT recipe_id, name,
       ts_rank(search_vector, q) AS skor
FROM recipes,
     websearch_to_tsquery('english', 'chicken garlic soup') AS q
WHERE search_vector @@ q
ORDER BY skor DESC
LIMIT 10;

SELECT recipe_id, name
FROM recipes
WHERE name ILIKE '%chicken%' AND name ILIKE '%garlic%' AND name ILIKE '%soup%'
LIMIT 10;



-- BAGIAN 6. ANALISIS PERFORMA: TANPA INDEX -> GIN -> GiST
\timing on

-- 6.1 TANPA index
EXPLAIN (ANALYZE, BUFFERS)
SELECT recipe_id, name
FROM recipes
WHERE search_vector @@ websearch_to_tsquery('english', 'chicken garlic soup');

-- 6.2 Dengan index GIN
CREATE INDEX idx_recipes_fts_gin ON recipes USING GIN (search_vector);

EXPLAIN (ANALYZE, BUFFERS)
SELECT recipe_id, name
FROM recipes
WHERE search_vector @@ websearch_to_tsquery('english', 'chicken garlic soup');

SELECT pg_size_pretty(pg_relation_size('idx_recipes_fts_gin')) AS ukuran_gin;

-- 6.3 Ganti dengan index GiST
DROP INDEX idx_recipes_fts_gin;
CREATE INDEX idx_recipes_fts_gist ON recipes USING GIST (search_vector);

EXPLAIN (ANALYZE, BUFFERS)
SELECT recipe_id, name
FROM recipes
WHERE search_vector @@ websearch_to_tsquery('english', 'chicken garlic soup');

SELECT pg_size_pretty(pg_relation_size('idx_recipes_fts_gist')) AS ukuran_gist;

-- 6.4 Kembalikan ke GIN
DROP INDEX idx_recipes_fts_gist;
CREATE INDEX idx_recipes_fts_gin ON recipes USING GIN (search_vector);


-- BAGIAN 7. RANKING & HIGHLIGHTING
SELECT name,
       ts_headline('english', description,
                   websearch_to_tsquery('english', 'chocolate cake'),
                   'StartSel=<b>, StopSel=</b>, MaxWords=25, MinWords=10') AS cuplikan
FROM recipes
WHERE search_vector @@ websearch_to_tsquery('english', 'chocolate cake')
LIMIT 5;

SELECT name,
       ts_rank_cd(search_vector, q) AS skor_cd
FROM recipes,
     websearch_to_tsquery('english', 'chocolate cake') AS q
WHERE search_vector @@ q
ORDER BY skor_cd DESC
LIMIT 10;

SELECT name,
       ts_rank(search_vector, q, 32) AS skor_normal
FROM recipes,
     websearch_to_tsquery('english', 'chocolate cake') AS q
WHERE search_vector @@ q
ORDER BY skor_normal DESC
LIMIT 10;

SELECT name, rating,
       ts_rank(search_vector, q) AS skor_teks,
       ts_rank(search_vector, q) * (1 + coalesce(rating, 0) / 5.0) AS skor_gabungan
FROM recipes,
     websearch_to_tsquery('english', 'chocolate cake') AS q
WHERE search_vector @@ q
ORDER BY skor_gabungan DESC
LIMIT 10;


-- =====================================================================
-- BAGIAN 8. ADVANCED QUERYING
-- =====================================================================
SELECT name FROM recipes
WHERE search_vector @@ to_tsquery('english', 'chicken & garlic')
LIMIT 5;

SELECT name FROM recipes
WHERE search_vector @@ to_tsquery('english', 'pancake | waffle')
LIMIT 5;

SELECT name FROM recipes
WHERE search_vector @@ to_tsquery('english', 'chicken & !onion')
LIMIT 5;

SELECT name FROM recipes
WHERE search_vector @@ phraseto_tsquery('english', 'apple pie')
LIMIT 5;

SELECT name FROM recipes
WHERE search_vector @@ to_tsquery('english', 'choc:*')
LIMIT 5;

SELECT name FROM recipes
WHERE search_vector @@ websearch_to_tsquery('english', '"fried chicken" -spicy')
LIMIT 5;

SELECT name, category, rating,
       ts_rank(search_vector, q) AS skor
FROM recipes,
     websearch_to_tsquery('english', 'vegetarian pasta') AS q
WHERE search_vector @@ q
  AND rating >= 4
ORDER BY skor DESC
LIMIT 10;

SELECT name FROM recipes
WHERE search_vector @@ to_tsquery('english', 'lasagna:A')
LIMIT 5;

SELECT word, ndoc, nentry
FROM ts_stat('SELECT search_vector FROM recipes')
ORDER BY ndoc DESC
LIMIT 20;
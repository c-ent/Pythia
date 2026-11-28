-- Weight heading_path (B) above content (C) on chunks.fts, and index document
-- titles (A) on documents.title_fts so note and file lookups rank title and
-- heading matches above body-only matches.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attrdef ad
    JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
    WHERE ad.adrelid = 'chunks'::regclass
      AND a.attname = 'fts'
      AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%heading_path%'
  ) THEN
    ALTER TABLE chunks DROP COLUMN IF EXISTS fts;
    ALTER TABLE chunks ADD COLUMN fts tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(heading_path, '')), 'B') ||
      setweight(to_tsvector('english', content), 'C')
    ) STORED;
    CREATE INDEX IF NOT EXISTS chunks_fts_idx ON chunks USING gin (fts);
  END IF;
END $$;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS title_fts tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A')
  ) STORED;

CREATE INDEX IF NOT EXISTS documents_title_fts_idx ON documents USING gin (title_fts);

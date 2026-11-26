CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS sources (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('obsidian', 'keep', 'repo', 'chat', 'work')),
  name text NOT NULL,
  root_path text NOT NULL,
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS documents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id bigint NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  path text NOT NULL,
  title text NOT NULL DEFAULT '',
  language text,
  content_hash text NOT NULL,
  allow_llm boolean NOT NULL DEFAULT true,
  mtime timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, path)
);

-- vector(768) matches nomic-embed-text on the Oracle Always Free host. Changing
-- the dimension means a new migration and a full re-embed.
CREATE TABLE IF NOT EXISTS chunks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  heading_path text NOT NULL DEFAULT '',
  start_line integer,
  end_line integer,
  content text NOT NULL,
  embedding vector(768),
  embed_model text,
  fts tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);

CREATE INDEX IF NOT EXISTS chunks_fts_idx ON chunks USING gin (fts);
CREATE INDEX IF NOT EXISTS chunks_document_id_idx ON chunks (document_id);
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx ON chunks USING hnsw (embedding vector_cosine_ops);

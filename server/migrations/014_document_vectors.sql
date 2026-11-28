-- Map document vectors (R20, T65; table approved by the owner 2026-11-27).
-- One row per map document: the mean of its chunk embeddings, with the model
-- those chunks were embedded with (D5), so neighbours are only ever compared
-- within one model. Only map documents get a row (server/src/ingest/mapEligible.ts):
-- repo code, boilerplate, work documents and documents with no stored chunks
-- have none. Rows are written with the chunks in IndexStore.replaceDocument
-- and backfilled from stored chunks at startup; no embedder is involved.
-- vector(768) matches chunks.embedding.
CREATE TABLE IF NOT EXISTS document_vectors (
  document_id bigint PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
  embedding vector(768) NOT NULL,
  embed_model text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_vectors_embed_model_idx ON document_vectors (embed_model);

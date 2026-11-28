-- Semantic neighbours (R20, T66; table approved by the owner 2026-11-27).
-- Each map document keeps its top 8 neighbours above the cut-off score,
-- compared only with documents of the same embed_model (D5). Both ends
-- reference document_vectors, so a document that is deleted or leaves the
-- map (its vector row goes) leaves every list at once. Written by
-- server/src/db/neighbourStore.ts after each index round; never by a reader.
CREATE TABLE IF NOT EXISTS document_neighbours (
  document_id bigint NOT NULL REFERENCES document_vectors (document_id) ON DELETE CASCADE,
  neighbour_id bigint NOT NULL REFERENCES document_vectors (document_id) ON DELETE CASCADE,
  rank smallint NOT NULL CHECK (rank >= 1),
  score real NOT NULL,
  embed_model text NOT NULL,
  PRIMARY KEY (document_id, neighbour_id),
  CHECK (document_id <> neighbour_id)
);

-- "Which documents listed this one" when a document changes.
CREATE INDEX IF NOT EXISTS document_neighbours_neighbour_idx ON document_neighbours (neighbour_id);

-- Nearest map documents for one vector, like chunks_embedding_hnsw_idx.
CREATE INDEX IF NOT EXISTS document_vectors_embedding_hnsw_idx ON document_vectors USING hnsw (embedding vector_cosine_ops);

-- When the neighbours of a document were last computed: the vector's
-- updated_at at that time. A vector written since (neighbours_at < updated_at)
-- or never computed (NULL) is a changed document for the next refresh.
ALTER TABLE document_vectors ADD COLUMN IF NOT EXISTS neighbours_at timestamptz;

-- A document whose list lost a row (the neighbour was deleted or left the
-- map) is refreshed on the next round too, so the free slot is filled.
CREATE OR REPLACE FUNCTION document_neighbours_mark_lister() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE document_vectors SET neighbours_at = NULL
  WHERE document_id = OLD.document_id AND neighbours_at IS NOT NULL;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS document_neighbours_deleted ON document_neighbours;
CREATE TRIGGER document_neighbours_deleted AFTER DELETE ON document_neighbours
  FOR EACH ROW EXECUTE FUNCTION document_neighbours_mark_lister();

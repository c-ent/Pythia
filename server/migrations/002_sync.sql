-- Incremental offline sync (R11, T20): every document change takes the next
-- value of one sequence, and deletes leave a tombstone, so a client can ask
-- for "everything after cursor N" and see edits, new notes and removals.
--
-- Writers take a shared advisory lock (in the triggers below) before they
-- draw a sequence value and keep it until commit. The sync reader takes the
-- same lock exclusively for a moment to read the high-water mark, so every
-- value at or below that mark belongs to a committed row: a slow transaction
-- can never commit "behind" a cursor a client has already passed.

CREATE SEQUENCE IF NOT EXISTS sync_seq;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS sync_seq bigint;
UPDATE documents SET sync_seq = nextval('sync_seq') WHERE sync_seq IS NULL;
ALTER TABLE documents ALTER COLUMN sync_seq SET NOT NULL;
CREATE INDEX IF NOT EXISTS documents_sync_seq_idx ON documents (sync_seq);

CREATE TABLE IF NOT EXISTS document_tombstones (
  sync_seq bigint PRIMARY KEY,
  document_id bigint NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

-- 7294732 is the sync lock; 7294731 is the migration lock (migrate.ts).
CREATE OR REPLACE FUNCTION documents_sync_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(7294732);
  NEW.sync_seq := nextval('sync_seq');
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION documents_sync_tombstone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(7294732);
  INSERT INTO document_tombstones (sync_seq, document_id) VALUES (nextval('sync_seq'), OLD.id);
  RETURN OLD;
END
$$;

-- Disabling a source (or renaming it) changes what clients may hold, so its
-- documents are touched and the next sync reports them as removed or renamed.
CREATE OR REPLACE FUNCTION sources_sync_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE documents SET sync_seq = sync_seq WHERE source_id = NEW.id;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS documents_sync_touch ON documents;
CREATE TRIGGER documents_sync_touch
  BEFORE INSERT OR UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_sync_touch();

DROP TRIGGER IF EXISTS documents_sync_tombstone ON documents;
CREATE TRIGGER documents_sync_tombstone
  AFTER DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_sync_tombstone();

DROP TRIGGER IF EXISTS sources_sync_touch ON sources;
CREATE TRIGGER sources_sync_touch
  AFTER UPDATE OF enabled, kind, name ON sources
  FOR EACH ROW
  WHEN (OLD.enabled IS DISTINCT FROM NEW.enabled OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION sources_sync_touch();

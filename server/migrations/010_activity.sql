-- Sync activity (R18, T42): the last 50 events shown on Sources and sync.
-- The server deletes everything but the newest 50 rows in the same
-- transaction as each insert. `message` is a short reason (an error class or
-- a fixed phrase), never note text, file content or a secret value; blocked
-- secrets are recorded as a count only. Per-source last sync times are
-- derived from these rows.
CREATE TABLE IF NOT EXISTS activity (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (
    kind IN ('vault_synced', 'repos_fetched', 'repo_fetched', 'secrets_blocked', 'keep_imported', 'sync_error')
  ),
  source text,
  count integer,
  message text
);

CREATE INDEX IF NOT EXISTS activity_at_idx ON activity (at DESC);

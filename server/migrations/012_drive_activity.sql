-- Drive activity (R19, T61): a finished Drive round (pull, then index) is
-- recorded as `drive_pulled` with the changed count; skipped and failed files
-- are a count in `message`, never names. Failures stay `sync_error`.
-- The inline CHECK in 010_activity.sql is named activity_kind_check by Postgres.
ALTER TABLE activity DROP CONSTRAINT IF EXISTS activity_kind_check;
ALTER TABLE activity
  ADD CONSTRAINT activity_kind_check CHECK (
    kind IN ('vault_synced', 'repos_fetched', 'repo_fetched', 'secrets_blocked', 'keep_imported', 'sync_error', 'drive_pulled')
  );

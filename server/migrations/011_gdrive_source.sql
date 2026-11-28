-- Google Drive source kind (R19, T55; schema change approved by the owner
-- 2026-11-27). Documents pulled from the owner's My Drive by rclone are
-- indexed under a source of kind 'gdrive'. A gdrive source is never 'work'.
-- The inline CHECK in 001_init.sql is named sources_kind_check by Postgres.
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_kind_check;
ALTER TABLE sources
  ADD CONSTRAINT sources_kind_check CHECK (kind IN ('obsidian', 'keep', 'repo', 'chat', 'gdrive', 'work'));

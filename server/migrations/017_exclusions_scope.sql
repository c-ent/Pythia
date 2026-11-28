-- Exclusion scope (R16): each rule in `llm_exclusions` can either keep
-- matching documents away from Gemini only (`scope = 'llm'`, default) or
-- exclude them everywhere (`scope = 'all'`: hidden from Search, Ask, Maps,
-- Backlinks, Offline sync, and `/mcp`).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS excluded boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS documents_not_excluded_idx
  ON documents (source_id)
  WHERE NOT excluded;

ALTER TABLE llm_exclusions
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'llm';

ALTER TABLE llm_exclusions DROP CONSTRAINT IF EXISTS llm_exclusions_scope_check;
ALTER TABLE llm_exclusions
  ADD CONSTRAINT llm_exclusions_scope_check CHECK (scope IN ('llm', 'all'));

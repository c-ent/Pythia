-- Tag, repo and Keep rules for the "Kept away from Gemini" list (R16, T40).
-- New rule kinds next to folder and note:
--   tag:  Obsidian notes tagged with it, or with a tag nested under it
--         (`private` covers `#private/health`); stored lower case, no `#`.
--   repo: every document of the repo with that name.
--   keep: every Google Keep note; its path is always 'keep'.
-- Like folder and note rules, they only set allow_llm; nothing is re-embedded.
ALTER TABLE llm_exclusions DROP CONSTRAINT IF EXISTS llm_exclusions_kind_check;
ALTER TABLE llm_exclusions
  ADD CONSTRAINT llm_exclusions_kind_check CHECK (kind IN ('folder', 'note', 'tag', 'repo', 'keep'));
ALTER TABLE llm_exclusions
  ADD CONSTRAINT llm_exclusions_keep_path_check CHECK (kind <> 'keep' OR path = 'keep');

-- A note's tags (frontmatter `tags` and inline `#tag`, lower case, without
-- `#`), written by the vault indexer, so tag rules and their counts work in
-- SQL. Empty for other sources, and for vault notes until the next scan reads them.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

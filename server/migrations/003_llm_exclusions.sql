-- Gemini exclusion list (R3, T24): vault folders and single notes whose
-- documents get allow_llm = false. It starts empty, so every note may reach
-- Gemini until the owner excludes it in Settings; frontmatter `llm: false`
-- still keeps a note away on its own. Paths are vault-relative and
-- `/`-separated, and they match note paths without regard to case.
CREATE TABLE IF NOT EXISTS llm_exclusions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('folder', 'note')),
  path text NOT NULL CHECK (path <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS llm_exclusions_kind_path_idx ON llm_exclusions (kind, lower(path));

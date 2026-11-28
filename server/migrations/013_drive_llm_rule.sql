-- Drive rules for the "Kept away from Gemini" list (R19, R16, T62).
--   gdrive: Google Drive documents. path '/' covers the whole Drive; any
--           other path is a Drive-relative folder (no leading or trailing
--           '/') and covers its files and subfolders.
-- Like the other rules, they only set allow_llm; nothing is re-embedded.
ALTER TABLE llm_exclusions DROP CONSTRAINT IF EXISTS llm_exclusions_kind_check;
ALTER TABLE llm_exclusions
  ADD CONSTRAINT llm_exclusions_kind_check CHECK (kind IN ('folder', 'note', 'tag', 'repo', 'keep', 'gdrive'));
ALTER TABLE llm_exclusions DROP CONSTRAINT IF EXISTS llm_exclusions_gdrive_path_check;
ALTER TABLE llm_exclusions
  ADD CONSTRAINT llm_exclusions_gdrive_path_check CHECK (
    kind <> 'gdrive' OR path = '/' OR (left(path, 1) <> '/' AND right(path, 1) <> '/')
  );

-- Explicit links (R20, T68; table approved by the owner 2026-11-27).
-- One row per link, tag, Keep label or alias of an Obsidian or Keep note,
-- parsed from its stored (already secrets-scanned) chunks and frontmatter
-- (server/src/ingest/links.ts). Targets are kept as written, plus a lookup
-- key; they are resolved when read, against the documents stored at that
-- moment, so the order notes were indexed in never matters and a target that
-- resolves to nothing is a ghost. Rows go with their document (a rename is a
-- delete plus an insert), and are rewritten with its chunks in
-- IndexStore.replaceDocument or on their own by IndexStore.replaceLinks.
CREATE TABLE IF NOT EXISTS links (
  document_id bigint NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  kind text NOT NULL CHECK (kind IN ('wikilink', 'embed', 'markdown', 'tag', 'label', 'alias')),
  target text NOT NULL,
  target_key text NOT NULL,
  heading text,
  display text,
  PRIMARY KEY (document_id, ordinal)
);

-- Backlinks: "which notes link to a note with this file name, title or alias".
CREATE INDEX IF NOT EXISTS links_target_key_idx ON links (target_key, kind);

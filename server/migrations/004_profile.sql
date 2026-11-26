-- Profile and preferences (R17, T30): one row, shared by every device the
-- owner signs in on. The defaults are what a fresh install shows: no name
-- (the greeting says "Hi"), Taipei time, no vault name (Open in Obsidian is
-- hidden), the System theme, Search as the opening mode and note previews on.
CREATE TABLE IF NOT EXISTS profile (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  display_name text NOT NULL DEFAULT '' CHECK (char_length(display_name) <= 80),
  time_zone text NOT NULL DEFAULT 'Asia/Taipei' CHECK (time_zone <> ''),
  vault_name text NOT NULL DEFAULT '' CHECK (char_length(vault_name) <= 200),
  theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('light', 'dark', 'system')),
  opening_mode text NOT NULL DEFAULT 'search' CHECK (opening_mode IN ('search', 'ask')),
  note_previews boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO profile (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

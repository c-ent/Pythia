-- Server-side web sessions (R15, T36), one row per signed-in device. The
-- cookie holds 32 random bytes; only their SHA-256 (`token_hash`) is stored,
-- so a copy of this table cannot sign anyone in. `password_tag` is the SHA-256
-- of the configured password hash: changing the password ends every session.
-- Signing a device out sets `revoked_at` and keeps the row; the server deletes
-- rows that expired or were revoked more than 30 days ago when someone logs in.
CREATE TABLE IF NOT EXISTS sessions (
  id bigserial PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  password_tag text NOT NULL,
  device_name text NOT NULL CHECK (char_length(device_name) BETWEEN 1 AND 80),
  user_agent text NOT NULL DEFAULT '' CHECK (char_length(user_agent) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS sessions_active_idx ON sessions (last_seen_at DESC) WHERE revoked_at IS NULL;

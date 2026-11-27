-- Gemini API key saved in Settings (R16, T39). At most one row (`id` is always
-- true). Encrypted with AES-256-GCM under PYTHIA_SECRETS_KEY from .env: no
-- plain key is stored, only the ciphertext, IV and auth tag, plus the last 4
-- characters so Settings can show which key is saved. GEMINI_API_KEY in .env
-- wins over this row.
CREATE TABLE IF NOT EXISTS gemini_key (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL CHECK (octet_length(iv) = 12),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  last4 text NOT NULL CHECK (char_length(last4) = 4),
  saved_at timestamptz NOT NULL DEFAULT now()
);

-- Requests sent to Gemini per day, by Asia/Taipei date (R16 "Used today").
CREATE TABLE IF NOT EXISTS gemini_usage (
  day date PRIMARY KEY,
  requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0)
);

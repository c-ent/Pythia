-- The MCP bearer token after its first rotation (R15, R7, T37). At most one
-- row (`id` is always true). Only the SHA-256 of the token is stored, plus its
-- last 4 characters so Settings can show which token is in use. While the
-- table is empty, PYTHIA_MCP_TOKEN from .env is the token; once a row exists,
-- only the token it describes opens /mcp.
CREATE TABLE IF NOT EXISTS mcp_token (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  token_hash text NOT NULL,
  last4 text NOT NULL CHECK (char_length(last4) = 4),
  rotated_at timestamptz NOT NULL DEFAULT now()
);

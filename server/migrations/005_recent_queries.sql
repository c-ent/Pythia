-- Recent searches and Ask questions (R14, T34), shared by every device the
-- owner signs in on. One row per kind and query text: running a query again
-- moves its row to the top (new `used_at`) instead of adding a copy. The
-- server keeps the newest 20 of each kind and deletes the rest when it
-- records one. `filters` holds the sources and repo the query ran with, so
-- rerunning it from the list gives the same results.
CREATE TABLE IF NOT EXISTS recent_queries (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('search', 'ask')),
  query text NOT NULL CHECK (query <> '' AND char_length(query) <= 500),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  used_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, query)
);

CREATE INDEX IF NOT EXISTS recent_queries_kind_used_at_idx ON recent_queries (kind, used_at DESC, id DESC);

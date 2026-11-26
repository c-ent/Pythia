# Architecture

Read this when changing data flow, storage, auth, or module boundaries. Only what the code cannot show on its own: the rules between modules, where data lives, and why a choice was made. No folder tree; read the code for that.

## Module boundaries

- `server/src/ingest/`: Pure file reading, filtering, chunking, and secrets scanning. Never writes back to source directories or calls LLM chat APIs.
- `server/src/security/`: Secrets scanner, auth hashing/session verification, and bearer token validation. No business logic.
- `server/src/db/`: The only place that executes SQL against PostgreSQL. All queries are parameterized.
- `server/src/search/`: Shared hybrid search (`RRF k=60`), document lookup, and Ask orchestration. Both REST routes and `/mcp` tools MUST call this module rather than querying the DB directly.
- `server/src/routes/` and `server/src/mcp/`: Thin transport adapters (Express HTTP and Streamable HTTP MCP). Validate input at the boundary and delegate to `server/src/search/` or `server/src/ingest/`.
- `web/src/offline/`: Owns Dexie (IndexedDB), sync cursor state, and MiniSearch. UI screens read through this layer when offline.
- `web/src/pages/`: Thin route screens; no direct `fetch` or IndexedDB calls embedded in JSX.

## Data flow

### Ingestion
1. Source sync (`rclone` one-way pull for Obsidian, read-only `git fetch` for repos, or Takeout zip upload for Keep) places files on local disk or passes a stream to the importer.
2. `server/src/ingest/` filters blocklisted paths, computes `content_hash` (skipping unchanged files), splits content (heading splitter or tree-sitter), and scans every chunk via `server/src/security/secrets`.
3. `server/src/embed/ollama` batches clean chunks (16–32) with prefix `search_document: ` to produce embeddings.
4. `server/src/db/` upserts `documents` and replaces their `chunks` in a transaction.

### Search & Ask
1. Client (PWA over Tailscale Funnel HTTPS, or MCP client with bearer token) sends a query to Express on `127.0.0.1`.
2. `server/src/search/` embeds the query with prefix `search_query: `, runs Postgres FTS + vector CTEs (applying `sources`/`repo` filters inside both CTEs), and merges rankings with RRF (`k = 60`).
3. For Ask mode, `server/src/search/ask` strips chunks where `allow_llm = false` before calling Gemini (429 backoff), falling back to local Ollama and then to retrieval-only snippets.

## Storage model

- **Source of truth:** Obsidian vault in Dropbox (`Apps/remotely-save`), personal GitHub remotes, and Google Keep. Pythia's copies are read-only mirrors.
- **Primary index:** PostgreSQL + `pgvector` in Docker (`sources`, `documents`, `chunks`). Rebuildable from sources; nightly `pg_dump` is a convenience backup.
- **Client offline cache:** Browser IndexedDB via Dexie on each device (all note text + pinned repo files only, synced incrementally via `/api/sync?since=<cursor>`). Read-only; no conflict resolution.

## External services

- **Ollama (local container/host):** Generates `nomic-embed-text` embeddings and optional local fallback Ask answers. If unavailable during search, degrade to FTS-only; if unavailable during ingestion, queue/retry without corrupting existing chunks.
- **Gemini API (free tier, server-side key only):** Optional primary LLM for Ask mode. Free-tier inputs may be used by Google to improve products, so `allow_llm = false` documents are strictly excluded. On 429 or outage, back off then fall back to Ollama / retrieval-only.
- **Dropbox (via `rclone`):** One-way read source for Remotely Save vault. If unreachable, keep serving existing index and retry on next schedule.
- **GitHub (read-only token/deploy key):** Periodic `git fetch` for configured personal repos.
- **Tailscale Funnel (`tailscale funnel`):** Public HTTPS address (`<machine>.<tailnet>.ts.net`) and certificate for PWA service worker support. Tailscale runs only on the host and forwards to `127.0.0.1:3000`; devices need no Tailscale app. The Pythia login is the only gate, so login limiting is per visitor.

## Decisions

### D1. Single-process Express + MCP server on `127.0.0.1`

- Context: The app needs long-running watchers (`chokidar`), scheduled pulls, REST API, and Streamable HTTP `/mcp` on a free-tier host.
- Decision: Express serves the web API, static PWA assets, and `/mcp` in one Node.js process bound strictly to `127.0.0.1`.
- Consequences: Simple deployment and shared search logic; no SSR (not needed for a private logged-in app).

### D2. PostgreSQL + `pgvector` over SQLite

- Context: Need combined full-text search (`tsvector`) and vector search with exact metadata filtering.
- Decision: All persistent index state MUST live in PostgreSQL + `pgvector`, using plain SQL migration files.
- Consequences: Hybrid RRF search runs in a single SQL query and supports `pg_dump`/`pg_restore` from workstation to server; requires more RAM than SQLite.

### D3. PWA over native mobile/desktop apps

- Context: Must support Windows PC, MacBook, iPhone, and iPad with one codebase for $0.
- Decision: UI MUST be a React + Vite PWA (`vite-plugin-pwa`) using Dexie + MiniSearch for offline keyword search.
- Consequences: Zero app-store overhead; iOS requires installing to Home Screen to avoid Safari's 7-day storage eviction and keeping cached text under ~100 MB.

### D4. Strict `allow_llm` boundary for Gemini free tier

- Context: Free-tier Gemini API prompts/responses may be reviewed or used to improve Google products.
- Decision: Chunks belonging to `allow_llm = false` documents MUST be filtered out before constructing any Gemini prompt.
- Consequences: Notes kept away from Gemini (`llm: false` frontmatter or the Settings exclusion list) stay searchable and can still be answered by local Ollama or retrieval-only mode without leaking to cloud APIs. Keep imports default to `allow_llm = true` like Obsidian notes (owner decision 2026-11-26).

### D5. Embedding model tracked per chunk

- Context: Switching between `nomic-embed-text` (768-dim, Oracle) and a smaller 384-dim model (`e2-micro`), or upgrading Ollama versions that change casing behavior, invalidates old vectors.
- Decision: Every row in `chunks` MUST store `embed_model`, and the embedding dimension MUST be chosen before the first full index.
- Consequences: Targeted re-embedding is possible whenever `embed_model` changes.

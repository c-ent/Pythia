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
- **Knowledge map (R20):** `document_vectors` holds one row per map document (`isMapDocument`, `server/src/ingest/mapEligible.ts`): the mean of its chunk embeddings and their `embed_model`, computed in Postgres from the stored chunks (`server/src/db/documentVectorStore.ts`). `IndexStore.replaceDocument` refreshes it in the same transaction as the chunks, so every indexer (vault, Keep, repos, Drive) keeps it current without its own code; startup backfills missing rows from stored chunks without calling Ollama. Rows go with their document (`ON DELETE CASCADE`). `document_neighbours` (T66) holds each map document's top 8 neighbours above the cut-off, same `embed_model` only; both ends reference `document_vectors`, so a document that is deleted or leaves the map leaves every list at once. `refreshNeighbours` (`server/src/db/neighbourStore.ts`) recomputes the due documents (`neighbours_at` older than `updated_at`, or NULL) from stored vectors after startup and after every index round (`server/src/search/neighbourRefresh.ts`, hooked on round-ending activity events). Readers (`GET /api/documents/:id/related`, `server/src/search/relatedService.ts`) only read; with source or repo filters the ranking runs inside the query over `document_vectors`, not over the stored list. The web app reads it only from the document page's Related panel (`web/src/api/related.ts`, `web/src/document/RelatedPanel.tsx`, T67), online only until T72 syncs the rows to Dexie. `links` (T68, `016_links.sql`) holds each Obsidian and Keep note's explicit links, tags, Keep labels and own aliases, parsed by `extractLinks` (`server/src/ingest/links.ts`) from the stored, secrets-scanned chunks and written by `IndexStore.replaceDocument` with the chunks, or alone by `replaceLinks` when only the links changed (compared through `linksKey`, no re-embedding). Targets are stored as written and resolved when read (`buildNoteIndex` / `resolveLink`: path, then title, then alias; same folder, then shorter path; nothing found is a ghost), so indexing order and renames never leave a stale target; rows go with their document. Repos and Drive write none. The reader is `GET /api/documents/:id/backlinks?limit=` (T68c), served by `createBacklinkService` (`server/src/search/backlinkService.ts`, shared with REST and later `/mcp`) over `createPgBacklinkStore` (`server/src/db/linkStore.ts`). The store finds candidate links with `target_key = ANY(noteKeys)` on `links_target_key_idx`, same source only. The service keeps a candidate only when `resolveLink` sends it to the opened note, groups the survivors per linking note (count, first link's display and heading, and the paragraph holding that link from the stored chunks, capped at 400 chars), and sorts them by title, then path. It also resolves the note's own wikilinks, embeds and Markdown links as `outgoing` (`documentId: null` for a ghost). Repo and Drive documents answer `supported: false`, and switched-off and `work` sources answer 404. The web app reads it on the document page (`web/src/api/backlinks.ts`, `useBacklinks`, `BacklinksPanel`, T69), once per opened Obsidian or Keep note, for the Backlinks panel and to resolve the viewer's note links (`DocumentBody` `targets`), online only until T72. MCP tools (T74) share the same related, backlink and topic-map services; the MCP adapter replaces locked related/backlink passage text with `WITHHELD_TEXT` and replaces topic-map labels for any group containing locked documents with generic labels, since labels can be derived from locked text. Graphs (T70): `createGraphService` (`server/src/search/graphService.ts`) over `createPgGraphStore` (`server/src/db/graphStore.ts`) serves `GET /api/documents/:id/graph` (the map document and everything 2 steps out, up to 200 nodes) and `GET /api/graph` (every map document, tag and repo; links plus each document's top 3 stored neighbours; no ghosts; up to 5000 nodes), read from `links`, `document_neighbours` and `document_vectors` only, with filters inside each store query; tags and Keep labels with the same key are one node. The web app reads the local graph on the document page (T71: `web/src/api/graph.ts`, `web/src/map/LocalGraphPanel.tsx`, online only until T72). Cytoscape is imported only by `web/src/map/GraphCanvas.tsx`, which is lazy-loaded, so it builds into its own chunk; the list view and the data helpers (`web/src/map/graphModel.ts`) never import it.
- **Client offline cache:** Browser IndexedDB via Dexie on each device (all note text + pinned repo files only, synced incrementally via `/api/sync?since=<cursor>`). Read-only; no conflict resolution. Since T72 each synced document also carries its map rows (`inMap`, stored `neighbours` with scores, and `links` as stored), written to the Dexie `map` table (schema version 2, which clears the sync state once so the next sync starts from cursor 0) in the same transaction as the document and removed with it. `web/src/offline/offlineMap.ts` builds Related, backlinks with outgoing links, and the local graph from those rows with the server's rules (link resolution mirrors `server/src/ingest/links.ts`, same 200-node cap), without passages. Only synced documents exist there, so `work`, switched-off sources and unpinned repos never appear; a neighbour in an unpinned repo is left out.

## External services

- **Ollama (local container/host):** Generates `nomic-embed-text` embeddings and optional local fallback Ask answers. If unavailable during search, degrade to FTS-only; if unavailable during ingestion, queue/retry without corrupting existing chunks.
- **Gemini API (free tier, server-side key only):** Optional primary LLM for Ask mode. Free-tier inputs may be used by Google to improve products, so `allow_llm = false` documents are strictly excluded. On 429 or outage, back off then fall back to Ollama / retrieval-only.
- **Dropbox (via `rclone`):** One-way read source for Remotely Save vault. If unreachable, keep serving existing index and retry on next schedule.
- **GitHub (read-only token/deploy key):** Periodic `git fetch` for configured personal repos.
- **Tailscale Funnel (`tailscale funnel`):** Public HTTPS address (`<machine>.<tailnet>.ts.net`) and certificate for PWA service worker support. Tailscale runs only on the host and forwards to `127.0.0.1:3000`; devices need no Tailscale app. The Pythia login is the only gate, so login limiting is per visitor. Exception: `/mcp` is tailnet only (R7, T48): requests that came through Funnel get 403 before the bearer check, so only computers on the owner's tailnet (with the Tailscale app) and the host itself reach the MCP tools. `requireTailnet` (`server/src/routes/auth.ts`) runs in front of `requireBearer`; the classification is `requestOrigin` in `server/src/security/tailnet.ts` (Funnel header, then `X-Forwarded-For` must be one Tailscale address, else loopback with no proxy headers = host; anything else is refused).

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

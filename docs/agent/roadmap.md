# Roadmap

Read this when picking the next task, planning, or asked what comes next. It is the task queue: every requirement in `spec.md` broken into tasks that are built one per session, in order.

## Rules for a task

- One task is one change that can be verified end to end in one session. If it needs "and" to describe, split it.
- Every task names the requirement it serves (`R1`) and a Verify check: a command to run, or a manual step with the expected result.
- Status is `Todo`, `Done` or `Blocked`. The task being built is named in `progress.md`, not here.
- A task starts only when every task in its Depends on column is `Done`.
- Rows are not permission to build ahead. Build the current task only, even when the next one looks easy.
- A new idea becomes a requirement in `spec.md` first, then rows here.

## Queue

| # | Task | Requirement | Depends on | Verify | Status |
| --- | --- | --- | --- | --- | --- |
| T1 | Project scaffold: TypeScript workspace (`server` + `web`), ESLint, Vitest, build/typecheck scripts, and one passing test | — | — | `pnpm build`, `pnpm typecheck`, and `pnpm test` pass | Done |
| T2 | Docker Compose (`postgres` + `pgvector`, `ollama`, `app`) and idempotent SQL migration runner with `sources`, `documents`, `chunks` schema | R1 | T1 | `docker compose up -d` starts all services and migration test passes twice | Done |
| T3 | Secrets file blocklist and chunk regex scanner (cloud keys, GitHub tokens, PEM headers, JWTs) with count-only logging | R2 | T1 | `npx vitest run server/src/security/secrets.test.ts` passes with planted fake keys | Done |
| T4 | Markdown heading chunker (300–500 token target, title + heading path prefix, `llm: false` frontmatter and excluded folder detection) | R3 | T1 | `npx vitest run server/src/ingest/markdownChunker.test.ts` passes | Done |
| T5 | Ollama embedding client (`nomic-embed-text`, `search_document:` / `search_query:` prefixes, batches of 16–32) | R3 | T2 | `npx vitest run server/src/embed/ollama.test.ts` passes (unit + live smoke test) | Done |
| T6 | Obsidian vault indexer and debounced `chokidar` watcher (content-hash skip, delete removed files, secrets scan, DB upsert) | R3, R2 | T2, T3, T4, T5 | Indexing a fixture vault twice skips Ollama on second run; deleted file is removed from DB | Done |
| T7 | Hybrid search service (Postgres FTS + vector cosine + RRF `k=60` with CTE-level filters) and REST endpoints (`/api/search`, `/api/documents`, `/api/recent`) | R4 | T6 | Integration test passes (`server/src/db/searchStore.db.test.ts` with `PYTHIA_DB_TESTS=1`) | Done |
| T7b | Relevance check of hybrid search on the real vault | R4 | T7 | 10 owner-written test questions via `POST /api/search` return the expected note in the top 5 | Blocked |
| T8 | Single-user authentication (`argon2id` password hash, HTTP-only session cookie, login rate limit, `127.0.0.1` server bind, MCP bearer token middleware) | R5 | T2 | `npx vitest run server/src/auth/auth.test.ts` verifies 401 unauthenticated and 429 rate limit | Done |
| T9 | React + Vite + `vite-plugin-pwa` app shell, dark-mode theme tokens, login screen, and responsive navigation | R6, R5 | T1, T8 | `pnpm test` (web: login, session, shell, offline banner) and `pnpm build` emits a valid `manifest.webmanifest` and `sw.js` | Done |
| T9b | Manual check of the T9 shell with a real password | R6, R5 | T9 | Manual: log in at `localhost`, see responsive shell on desktop and mobile widths, install prompt available | Blocked |
| T10 | Web App Search screen: source filter chips, ranked result cards with heading path and highlighted snippets, and retrieval-only Ask box | R6, R4 | T7, T9 | `pnpm test` (web: `SearchScreen.test.tsx`, `highlight.test.ts`, `format.test.ts`) and `pnpm build` pass | Done |
| T10b | Manual check of the T10 Search screen on real data | R6, R4 | T10, T9b | Manual: search from MacBook at `localhost` and see ranked results and retrieval-only Ask snippets | Blocked |
| T11 | Web App Document viewer screen: rendered Markdown, syntax-highlighted code blocks, and file path header | R6, R4 | T9, T7 | `pnpm exec vitest run web/src/screens/DocumentScreen.test.tsx web/src/document/format.test.ts web/src/router.test.ts web/src/shell/AppShell.test.tsx` passes with stubbed `fetch` (Markdown + GFM, highlighted code file, no raw HTML or images, offline saved copy, 404/500 states, result cards and Ask sources link to `/doc/<id>`) | Done |
| T11b | Manual check of the T11 Document viewer on real data | R6, R4 | T11, T9b | Manual: click a search result to open full rendered Markdown or code file | Blocked |
| T12 | Streamable HTTP MCP server at `/mcp` (bearer token auth) with `search`, `get_document`, and `recent_changes` tools | R7, R5 | T7, T8 | `pnpm exec vitest run server/src/mcp/mcpServer.test.ts` passes (SDK client over HTTP: tool list, `allow_llm` withholding, input errors, wrong token) | Done |
| T12b | Manual check of `/mcp` from Claude Code | R7, R5 | T12 | Manual: Claude Code (`--transport http`) answers a question using `/mcp` | Blocked |
| T13 | Server-side `POST /api/ask` with `allow_llm` enforcement, Gemini API client (429 backoff), local Ollama fallback, and retrieval-only fallback | R8 | T7 | Tests confirm `allow_llm = false` never reaches Gemini and missing `GEMINI_API_KEY` falls back cleanly | Done |
| T13b | Live check of Ask with a real Gemini key and the pulled local model | R8 | T13 | Manual: Ask answers via `gemini`; with the key removed it answers via `ollama` | Blocked |
| T14 | Wire Web App Ask box to `POST /api/ask` with cited source links and active engine/fallback badge | R8, R6 | T10, T13 | `pnpm exec vitest run web/src/screens/SearchScreen.test.tsx web/src/search/citations.test.ts` passes (stubbed `/api/ask`: linked `[n]` citations, engine badge, fallback notes, retrieval-only, errors, stale answers) | Done |
| T14b | Manual check of Ask in the web app on real data | R8, R6 | T14, T13b | Manual: Ask answers a conceptual question with clickable note citations; removing key triggers fallback | Blocked |
| T15 | GitHub repo config loader, read-only `git` clone/30-min fetch scheduler, and file filter (`.gitignore`, 200 KB cap, code/README/manifest allowlist) | R9, R2 | T2, T3 | `pnpm exec vitest run server/src/ingest/repoConfig.test.ts server/src/ingest/repoFilter.test.ts server/src/ingest/repoMirror.test.ts server/src/ingest/repoScheduler.test.ts` passes (local test repo: bare clone, fetch, force-push, branch and default-branch changes, no partial mirror on failure, filter on the real tree) | Done |
| T15b | Mirror the owner's real repos with the GitHub token | R9, R2 | T15 | Manual: with `GITHUB_TOKEN` and `PYTHIA_REPOS_CONFIG` set, the startup log shows every repo synced, `data/repos/<name>.git` exists for each, and no log line contains the token | Blocked |
| T16 | Tree-sitter code chunker (function/class boundaries + 80-line fallback) and deterministic repo `SUMMARY` chunk builder | R9 | T15 | `pnpm exec vitest run server/src/ingest/codeChunker.test.ts server/src/ingest/repoSummary.test.ts` passes on TS/JS/Python/PHP, the line-window fallback and the SUMMARY builder | Done |
| T17 | Repo ingestion pipeline: index each fetched commit (file filter, code chunker, secrets scan, embed, unchanged-blob skip, deletes) plus one `SUMMARY` document per repo, wired to the fetch scheduler | R9, R2 | T15, T16 | `pnpm exec vitest run server/src/ingest/repoIndexer.test.ts` passes (local test repo: allowlisted files indexed, planted fake key never stored or logged, unchanged blobs skip Ollama, changed and deleted files handled, embed failure keeps old chunks, one SUMMARY chunk) | Done |
| T17c | `list_repos` and `get_repo_overview` MCP tools and `GET /api/repos`, `GET /api/repos/:name` on the search service | R9, R7 | T17, T12 | `pnpm exec vitest run server/src/mcp/mcpServer.test.ts server/src/routes/api.test.ts` passes (repo list with counts, overview from the SUMMARY document, unknown repo error) | Done |
| T17d | Web App Repos screen: repo list, overview, pin toggle stored on the device | R6, R11 | T17c, T9 | `pnpm exec vitest run web/src/screens/ReposScreen.test.tsx` passes with stubbed `fetch` | Done |
| T17b | Manual check of repo search on the owner's repos | R9, R2 | T17c, T15b | Manual: "which repo has X?" returns the right repo in the top 5; planted fake key never enters index | Blocked |
| T18 | Production Docker Compose, workstation `pg_dump`/restore script, and scheduled one-way `rclone` Dropbox pull (`Apps/remotely-save`) | R10 | T6, T17 | `pnpm exec vitest run server/src/routes/static.test.ts server/src/config.test.ts` passes, `docker compose -f docker-compose.yml -f docker-compose.prod.yml config` is valid, and the image builds with the web app and `git` | Done |
| T18b | Manual check of the production stack with real Dropbox and a restored dump | R10 | T18 | Manual: `rclone` pulls vault read-only and restored DB serves search without re-embedding | Blocked |
| T27 | Per-visitor login rate limit for the public Funnel address (visitor address from the header Tailscale Funnel forwards; confirm which header first), so others' failed logins cannot lock the owner out | R5, R10 | T8 | `pnpm exec vitest run server/src/security/rateLimit.test.ts server/src/routes/auth.test.ts` passes (two visitors limited separately; missing or spoofed header cannot bypass the limit) | Done |
| T19 | Always-on host deployment with Tailscale Funnel HTTPS (Tailscale on the host only) and firewall lockdown | R10, R5 | T18, T27 | Manual: with PC off, phone on mobile data without the Tailscale app opens the Funnel URL, logs in, searches, and sees a newly synced note | Todo |
| T20 | Incremental sync endpoint (`GET /api/sync?since=<cursor>`) and Dexie (IndexedDB) client sync store | R11, R4 | T7, T9 | Integration test verifies cursor sync; browser IndexedDB populates notes on sync | Done |
| T21 | Offline mode: Workbox app-shell precache, MiniSearch keyword search, repo pinning, and Settings storage panel (`persist()`/`estimate()`) | R11, R6 | T20, T17d | `pnpm exec vitest run web/src/offline web/src/screens/SearchScreen.offline.test.tsx web/src/screens/SettingsScreen.test.tsx` passes (offline word search over cached notes and pinned repo files, no `fetch` while offline, storage panel) | Done |
| T21b | Manual offline check on an iPhone | R11, R6 | T21, T19 | Manual: installed Home Screen app on iPhone in airplane mode finds a cached note and pinned repo file | Blocked |
| T22 | Google Keep Takeout zip importer (`allow_llm = false`, replace-all on re-import) and Web App Import page (upload, re-index button, index status) | R12, R6 | T6, T9 | `pnpm exec vitest run server/src/ingest/keepTakeout.test.ts server/src/ingest/keepImporter.test.ts server/src/routes/import.test.ts web/src/screens/ImportScreen.test.tsx` passes (fixture zip, `allow_llm = false`, re-import without duplicates, bad uploads leave notes untouched, Import page states) | Done |
| T22b | Manual check of Keep import with a real Takeout zip | R12, R6 | T22, T9b | Manual: upload Keep Takeout zip, search a Keep note, re-upload without duplicates | Blocked |
| T23 | 30-question evaluation harness (`hit@5` scorer) and baseline score recording | R12 | T17, T22 | `pnpm exec vitest run server/src/eval/evalSet.test.ts` passes, and `pnpm --filter server eval server/eval.example.json` runs against the live index and prints per-question results and `hit@5` | Done |
| T23b | Record the baseline with the owner's 30 questions | R12 | T23, T6, T15b, T22b | Manual: `pnpm --filter server eval --save` on the real index writes `data/eval/results-*.json` with the `hit@5` baseline | Blocked |
| T24 | Gemini exclusion list on the server: `llm_exclusions` table (folders and single notes), empty by default (`Private` no longer excluded), `GET`/`PUT /api/settings/llm-exclusions`, and applying it to `allow_llm` without re-embedding | R3, R8 | T6, T8 | `pnpm exec vitest run server/src/ingest/vaultIndexer.test.ts server/src/routes/settings.test.ts` passes, plus the Postgres suite with `PYTHIA_DB_TESTS=1` (empty list leaves `Private/` notes `allow_llm = true`; excluded folder and excluded note get `false`; `llm: false` still wins; changing the list calls no embedder) | Done |
| T25 | Web App Settings "Kept away from Gemini" panel: list, add a folder or a single note, remove | R6, R3 | T24, T21 | `pnpm exec vitest run web/src/screens/SettingsScreen.test.tsx` passes with stubbed `fetch` (list, add, remove, save error) | Done |
| T26 | Keep notes default to `allow_llm = true`: importer change, and already-imported Keep notes flipped (re-import or one-time update; decide in the task) | R12, R8 | T22 | `pnpm exec vitest run server/src/ingest/keepImporter.test.ts server/src/ask/askService.test.ts` passes (imported Keep notes have `allow_llm = true`; a Keep note can reach Gemini; `llm`-excluded Obsidian notes still cannot) | Done |

## Blocked

| # | Reason | What unblocks it |
| --- | --- | --- |
| — | — | — |

## Later

Ideas that are not requirements yet. Nothing here is built until it moves into `spec.md` and the queue.

- Chat history importers (Claude export, ChatGPT `conversations.json`, Gemini Takeout scheduled to Dropbox), defaulting `allow_llm = false`.
- Public `/mcp` endpoint via Tailscale Funnel or Cloudflare Tunnel with OAuth for Claude web and mobile custom connectors.
- In-browser offline LLM for desktop browsers.
- Cross-encoder reranker on top of RRF results.
- Separate work database (`kind = 'work'`) if employer approval is ever granted.

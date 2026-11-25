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
| T1 | Project scaffold: TypeScript workspace (`server` + `web`), ESLint, Vitest, build/typecheck scripts, and one passing test | — | — | `npm run build`, `npm run typecheck`, and `npm test` pass | Todo |
| T2 | Docker Compose (`postgres` + `pgvector`, `ollama`, `app`) and idempotent SQL migration runner with `sources`, `documents`, `chunks` schema | R1 | T1 | `docker compose up -d` starts all services and migration test passes twice | Todo |
| T3 | Secrets file blocklist and chunk regex scanner (cloud keys, GitHub tokens, PEM headers, JWTs) with count-only logging | R2 | T1 | `npx vitest run server/src/security/secrets.test.ts` passes with planted fake keys | Todo |
| T4 | Markdown heading chunker (300–500 token target, title + heading path prefix, `llm: false` frontmatter and excluded folder detection) | R3 | T1 | `npx vitest run server/src/ingest/markdownChunker.test.ts` passes | Todo |
| T5 | Ollama embedding client (`nomic-embed-text`, `search_document:` / `search_query:` prefixes, batches of 16–32) | R3 | T2 | `npx vitest run server/src/embed/ollama.test.ts` passes (unit + live smoke test) | Todo |
| T6 | Obsidian vault indexer and debounced `chokidar` watcher (content-hash skip, delete removed files, secrets scan, DB upsert) | R3, R2 | T2, T3, T4, T5 | Indexing a fixture vault twice skips Ollama on second run; deleted file is removed from DB | Todo |
| T7 | Hybrid search service (Postgres FTS + vector cosine + RRF `k=60` with CTE-level filters) and REST endpoints (`/api/search`, `/api/documents`, `/api/recent`) | R4 | T6 | Integration test passes; 10 test questions over personal vault return expected note in top 5 | Todo |
| T8 | Single-user authentication (`argon2id` password hash, HTTP-only session cookie, login rate limit, `127.0.0.1` server bind, MCP bearer token middleware) | R5 | T2 | `npx vitest run server/src/auth/auth.test.ts` verifies 401 unauthenticated and 429 rate limit | Todo |
| T9 | React + Vite + `vite-plugin-pwa` app shell, dark-mode theme tokens, login screen, and responsive navigation | R6, R5 | T1, T8 | Manual: log in at `localhost`, see responsive shell on desktop and mobile widths, valid PWA manifest | Todo |
| T10 | Web App Search screen: source filter chips, ranked result cards with heading path and highlighted snippets, and retrieval-only Ask box | R6, R4 | T7, T9 | Manual: search from MacBook at `localhost` and see ranked results and retrieval-only Ask snippets | Todo |
| T11 | Web App Document viewer screen: rendered Markdown, syntax-highlighted code blocks, and file path header | R6, R4 | T9, T7 | Manual: click a search result to open full rendered Markdown or code file | Todo |
| T12 | Streamable HTTP MCP server at `/mcp` (bearer token auth) with `search`, `get_document`, and `recent_changes` tools | R7, R5 | T7, T8 | Manual: Claude Code (`--transport http`) answers a question using `/mcp` | Todo |
| T13 | Server-side `POST /api/ask` with `allow_llm` enforcement, Gemini API client (429 backoff), local Ollama fallback, and retrieval-only fallback | R8 | T7 | Tests confirm `allow_llm = false` never reaches Gemini and missing `GEMINI_API_KEY` falls back cleanly | Todo |
| T14 | Wire Web App Ask box to `POST /api/ask` with cited source links and active engine/fallback badge | R8, R6 | T10, T13 | Manual: Ask answers a conceptual question with clickable note citations; removing key triggers fallback | Todo |
| T15 | GitHub repo config loader, read-only `git` clone/30-min fetch scheduler, and file filter (`.gitignore`, 200 KB cap, code/README/manifest allowlist) | R9, R2 | T2, T3 | `npx vitest run server/src/ingest/repoFilter.test.ts` passes; test repo clones read-only | Todo |
| T16 | Tree-sitter code chunker (function/class boundaries + 80-line fallback) and deterministic repo `SUMMARY` chunk builder | R9 | T15 | `npx vitest run server/src/ingest/codeChunker.test.ts` passes on TS/JS/Python/PHP and fallback file | Todo |
| T17 | Repo ingestion pipeline, `list_repos` and `get_repo_overview` MCP tools, and Web App Repos screen | R9, R7, R6 | T12, T16, T9 | Manual: "which repo has X?" returns right repo; planted fake key never enters index | Todo |
| T18 | Production Docker Compose, workstation `pg_dump`/restore script, and scheduled one-way `rclone` Dropbox pull (`Apps/remotely-save`) | R10 | T6, T17 | Manual: `rclone` pulls vault read-only and restored DB serves search without re-embedding | Todo |
| T19 | Always-on host deployment with `tailscale serve` HTTPS and firewall lockdown | R10, R5 | T18 | Manual: with PC off, phone on mobile data searches the app and sees a newly synced note | Todo |
| T20 | Incremental sync endpoint (`GET /api/sync?since=<cursor>`) and Dexie (IndexedDB) client sync store | R11, R4 | T7, T9 | Integration test verifies cursor sync; browser IndexedDB populates notes on sync | Todo |
| T21 | Offline mode: Workbox app-shell precache, MiniSearch keyword search, repo pinning, and Settings storage panel (`persist()`/`estimate()`) | R11, R6 | T20, T17 | Manual: installed Home Screen app on iPhone in airplane mode finds a cached note and pinned repo file | Todo |
| T22 | Google Keep Takeout zip importer (`allow_llm = false`, replace-all on re-import) and Web App Import page (upload, re-index button, index status) | R12, R6 | T6, T9 | Manual: upload Keep Takeout zip, search a Keep note, re-upload without duplicates | Todo |
| T23 | 30-question evaluation harness (`hit@5` scorer) and baseline score recording | R12 | T17, T22 | Eval script runs against live index and prints per-question results and `hit@5` score | Todo |

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

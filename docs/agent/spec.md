# Spec: Pythia

Read this when building or changing a feature. It is the requirements document: it defines what to build. The order of the work is in `roadmap.md`. If something is not here, do not invent it; add an open question to `progress.md`.

## Overview

Pythia (named after the Oracle at Delphi) is a private, read-only Personal Knowledge Server that answers questions across personal Obsidian notes, personal GitHub repositories, and Google Keep exports from any of four devices (Windows PC, MacBook, iPhone, iPad) for $0/month. One PostgreSQL + `pgvector` index powers both an installable offline-capable PWA and a Streamable HTTP MCP server for AI coding clients.

## Users

- Single owner (`@Cent`): writes notes in Obsidian and code in desktop editors, and uses Pythia to search, inspect, and ask questions across personal knowledge and code from desktop, mobile, or AI clients (Cursor, Claude Code).

## Product principles

1. **Read-only by design.** Pythia never modifies the Obsidian vault, GitHub repos, or Keep notes; there are no write-sync conflicts to solve.
2. **Privacy and secrets first.** Credentials are never indexed; private notes never leave the machine to third-party LLMs; work material stays out by default.
3. **Zero recurring cost ($0).** Every component uses open-source software or free tiers.
4. **One stack, four devices.** A single React + Vite PWA covers PC, MacBook, iPhone, and iPad; no native apps.
5. **Graceful degradation.** If Gemini fails or is disallowed, Ask falls back to local Ollama, then to retrieval-only snippets; if the network is down, the PWA falls back to local IndexedDB keyword search.

## Goals

1. Answer personal note and code queries with the right source in the top 5 results (`hit@5`) measured against a 30-question personal evaluation set.
2. Open the installed PWA on iPhone/iPad in airplane mode and find any cached note or pinned repo file via keyword search.
3. Connect Claude Code or Cursor to `/mcp` over Tailscale and retrieve notes, code, and repo overviews using the same hybrid index as the web app.
4. Keep total monthly operating cost at $0 across hosting, embeddings, sync, and networking.

## Non-goals

- Editing, creating, or two-way syncing notes or repository files.
- Multi-user accounts, team workspaces, or public sharing.
- Indexing employer/work code or notes (unless explicitly enabled later in a separate database).
- Native iOS, macOS, or Windows desktop apps.
- Live API sync for Google Keep or AI chat exports.

## Core user flow

1. User opens Pythia PWA (installed on Home Screen or desktop browser) over its Tailscale Funnel HTTPS address and signs in once with their password.
2. User types a query in the Search or Ask box, optionally filtering by source (`obsidian`, `repo`, `keep`) or repository.
3. In Search mode, Pythia returns ranked chunks with heading paths, highlighted snippets, and links to open the full rendered document.
4. In Ask mode, Pythia retrieves top chunks, synthesizes a cited answer (respecting `allow_llm`), and links directly to the source chunks.
5. Offline, the PWA opens from the precached app shell and runs MiniSearch over cached notes and pinned repos in IndexedDB.

## Requirements

### Foundation & Storage

#### R1. Infrastructure & Database Schema

- Behaviour: Docker Compose runs `postgres` (with `pgvector`), `ollama` (`nomic-embed-text`, 768 dims), and the Node.js TypeScript `app` container. Plain SQL migrations create `sources`, `documents`, and `chunks` tables:
  - `sources`: `id`, `kind` (`'obsidian' | 'keep' | 'repo' | 'chat' | 'work'`), `name`, `root_path`, `enabled` (default `true`).
  - `documents`: `id`, `source_id` (FK cascade), `path`, `title`, `language`, `content_hash`, `allow_llm` (boolean, default `true`), `mtime`, `updated_at`, `UNIQUE(source_id, path)`.
  - `chunks`: `id`, `document_id` (FK cascade), `ordinal`, `heading_path`, `start_line`, `end_line`, `content`, `embedding vector(768)`, `embed_model`, `fts tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED`.
  - Indexes: GIN on `chunks(fts)`, B-tree on `chunks(document_id)`, optional HNSW (`vector_cosine_ops`) on `chunks(embedding)`.
- Edge cases: Re-running migrations on an already-migrated DB is idempotent; embedding dimension must be configurable before the first index if targeting `e2-micro` (`vector(384)`).
- Acceptance criteria:
  - Given a clean environment, when `docker compose up -d` and migrations run, then all three services start healthy, `vector` extension is enabled, and all tables/indexes exist.
  - Given migrations already ran, when migrations run again, then the command exits 0 with no duplicate errors.

#### R2. Secrets & Work Material Guardrails

- Behaviour:
  - File blocklist skips `.env*`, `*.pem`, `id_rsa*`, `credentials*`, `*.key`, and `.git/`.
  - Every chunk is scanned before embedding/storage for secret patterns (cloud API keys, GitHub tokens, private key headers, JWTs). Matching chunks are dropped and only the dropped count is logged.
  - Sources with `kind = 'work'` are disabled by default and rejected by default ingestion unless explicitly configured for a separate database.
- Edge cases: Secret split across lines (PEM blocks), fake/test keys, case variations in filenames.
- Acceptance criteria:
  - Given a file named `.env.local` or `id_rsa`, when the indexer scans its directory, then the file is skipped and not stored in `documents`.
  - Given a markdown note or code file containing a planted fake GitHub token or private key header, when indexed, then that chunk never appears in `chunks` and logs contain only the count, not the token.

### Ingestion

#### R3. Obsidian Vault Ingestion

- Behaviour:
  - Watches a local read-only vault directory with `chokidar` (debounced) and supports full scan on startup/demand.
  - Skips unchanged files by comparing `content_hash`. Deletes `documents` rows when files disappear from disk.
  - Splits Markdown by heading into chunks targeting ~300–500 tokens, prepending note title and `heading_path` (`Note > Section`) before embedding.
  - Embeds chunks via Ollama `nomic-embed-text` in batches of 16–32 with prefix `search_document: `. Stores `embed_model` per chunk so model upgrades can re-embed stale rows.
  - Every note may be sent to Gemini by default (`allow_llm = true`); nothing is excluded until the owner excludes it.
  - Sets `allow_llm = false` when a note sits in a folder on the Gemini exclusion list, is itself on that list, or has frontmatter property `llm: false`.
  - The exclusion list (folders and single notes, vault-relative paths) is edited in Settings and stored in `llm_exclusions`. Changing it updates `allow_llm` on the affected notes without re-embedding them.
- Edge cases: Empty markdown file, note with no headings, huge single section exceeding 500 tokens (split cleanly), malformed YAML frontmatter, rapid consecutive file saves (debounced).
- Acceptance criteria:
  - Given a vault with sample notes, when indexed, then each note produces heading-scoped chunks with 768-dim embeddings and valid `content_hash`.
  - Given an unchanged note, when re-indexed, then Ollama is not called for that note.
  - Given a note with `llm: false` in frontmatter, inside an excluded folder, or excluded on its own, when indexed, then `documents.allow_llm` is `false`.
  - Given an empty exclusion list, when a note in `Private/` (or any folder) without `llm: false` is indexed, then `documents.allow_llm` is `true`.
  - Given a folder or note added to or removed from the exclusion list in Settings, when saved, then the affected notes' `allow_llm` changes and Ollama is not called.

#### R9. GitHub Repo Ingestion & Overviews

- Behaviour:
  - Reads a list of personal repos from config, clones via read-only deploy key or fine-grained token, and runs `git fetch` every 30 minutes.
  - Skips `.gitignore` matches, `node_modules`, `vendor`, `dist`, `build`, lockfiles, binaries, images/data assets, and files > 200 KB. Indexes source code, READMEs, and package manifests only.
  - Chunks code by function/class using `tree-sitter`, falling back to 80-line windows for unsupported languages.
  - Generates one deterministic `SUMMARY` chunk (`heading_path` starting with `SUMMARY`) per repo from its README, file tree, and dependency manifest (`package.json`, `composer.json`, `requirements.txt`). No LLM required.
- Edge cases: Repo without a README, unsupported file language, fetch failure (log error and keep previous index), file exceeding 200 KB.
- Acceptance criteria:
  - Given a configured repo, when ingested, then source files are chunked by symbol (or 80-line fallback), ignored paths and >200 KB files are excluded, and one `SUMMARY` chunk exists.
  - Given a query "which repo has X?", when searched, then the matching repo ranks in the top 5.

#### R12. Google Keep Takeout Import & Quality Eval

- Behaviour:
  - Import page accepts a Google Takeout `.zip` containing Keep notes, parses title, text, labels, and checklist items, and replaces all existing `kind = 'keep'` documents on each import.
  - Keep documents default to `allow_llm = true`, like Obsidian notes (owner decision 2026-11-26; was `false`).
  - Import page also exposes index status (counts per source, last updated) and a manual re-index trigger.
  - Includes a 30-question evaluation script that queries hybrid search and reports `hit@5`.
- Edge cases: Invalid or non-Keep zip file returns a clear 400 error without wiping existing Keep docs; empty checklist or untitled note.
- Acceptance criteria:
  - Given a valid Keep Takeout zip, when uploaded, then Keep notes appear in search with `allow_llm = true`, and a second upload replaces rather than duplicates them.
  - Given a 30-question eval JSON file, when the eval script runs, then it outputs per-question pass/fail and aggregate `hit@5`.

### Search, Ask & MCP

#### R4. Hybrid Search & Retrieval API

- Behaviour:
  - One shared search service runs Postgres full-text search (`websearch_to_tsquery('english', $1)`, top 50) and vector cosine search (`embedding <=> $2::vector` with `search_query: ` prefix, top 50), merging with Reciprocal Rank Fusion (`1.0 / (60 + rank)`).
  - Optional `sources` and `repo` filters are applied inside both CTEs before `LIMIT 50`.
  - REST API exposes:
    - `POST /api/search` (query, sources, repo, limit) -> ranked chunks with path, heading_path, snippet, score.
    - `GET /api/documents/:id` (or by source + path) -> full document text, size-capped.
    - `GET /api/recent?days=&source=` -> recently modified documents.
    - `GET /api/sync?since=<cursor>` -> documents changed since cursor for offline sync.
- Edge cases: Empty query (400), query matching only FTS or only vector search, Ollama unavailable during search (degrade to FTS-only with a warning flag rather than 500), oversized document truncated cleanly at size cap.
- Acceptance criteria:
  - Given 10 real test questions over the Obsidian vault, when queried via `POST /api/search`, then the expected note appears in the top 5.
  - Given a `sources` or `repo` filter, when searched, then zero chunks from excluded sources appear and top-K slots are not wasted on filtered-out rows.

#### R7. MCP Server

- Behaviour:
  - Mounted on the same Express server at `/mcp` using the official MCP TypeScript SDK over Streamable HTTP.
  - Authenticated via a dedicated bearer token (separate from web login).
  - Tools: `search(query, sources?, repo?, limit?)`, `get_document(source, path)`, `list_repos()`, `get_repo_overview(repo)`, `recent_changes(days, source?)`.
- Edge cases: Missing or invalid bearer token returns 401; unknown repo or document returns a clean MCP tool error.
- Acceptance criteria:
  - Given Claude Code configured with `--transport http` and the bearer token, when asked a question about an indexed note, then it calls `search` / `get_document` and returns the right answer.

#### R8. Ask Mode (LLM Answers with Privacy & Fallbacks)

- Behaviour:
  - `POST /api/ask` runs hybrid search, then enforces `allow_llm`: chunks from `allow_llm = false` documents are never sent to Gemini.
  - Fallback chain:
    1. If allowed chunks exist and a Gemini key is configured (`GEMINI_API_KEY` in `.env`, or the key saved in Settings, R16), call Gemini API (server-side only, exponential backoff on 429) and return cited answer.
    2. If Gemini fails, times out, is unconfigured, or all top matches have `allow_llm = false`, try the configured local Ollama chat model (if available).
    3. If both fail/unavailable, return a retrieval-only response with the top chunks and highlighted sentences.
  - Every response includes source chunk links and which engine answered (`gemini`, `ollama`, or `retrieval`).
- Edge cases: Missing `GEMINI_API_KEY`, Gemini 429 rate limit, all matching chunks marked `allow_llm = false`, zero search results.
- Acceptance criteria:
  - Given a question whose best match is marked `allow_llm = false`, when `POST /api/ask` runs, then that chunk's text never appears in any outbound Gemini request.
  - Given `GEMINI_API_KEY` unset, when `POST /api/ask` runs, then it succeeds via local Ollama or retrieval-only fallback without throwing an error.

### Security, Web App, Hosting & Offline

#### R5. Authentication & Network Security

- Behaviour:
  - Express binds strictly to `127.0.0.1`.
  - Single-user web auth uses an `argon2id` password hash from env/config, HTTP-only `Secure` `SameSite=Lax` session cookie, and rate limiting on `POST /api/login`.
  - `/mcp` uses a separate static bearer token checked in constant time.
- Edge cases: Brute-force login attempts (429 after threshold), expired/missing cookie returns 401 on `/api/*`, wrong bearer token returns 401 on `/mcp`.
- Acceptance criteria:
  - Given unauthenticated requests to `/api/search` or `/mcp`, when sent, then both return 401.
  - Given repeated failed logins, when the rate limit is exceeded, then `/api/login` returns 429.

#### R6. Web App (PWA) Core UI

- Behaviour:
  - React + Vite + `vite-plugin-pwa` installable web app, responsive across mobile, tablet and desktop, with light and dark themes (R13). The look and layout follow the owner's mock-ups in `docs/agent/mockups/` as described in `ui.md` (redesign decided 2026-11-26).
  - Screens: Login; Home (greeting, Search / Ask box with source chips, Recent changes, Pinned offline and Try asking cards); Search results (result cards with heading path and highlighted snippets, desktop preview pane, Copy path, Open in Obsidian); Ask (cited answer, engine badge, answer-engine and sources panels, follow-up box); Document (rendered Markdown, syntax-highlighted code, file path, Copy path, Open in Obsidian); Repos (filter, language chips, repo cards, detail panel with stats, "Allow Ask to read this repo", pin, re-sync); Pinned and offline (pinned repos, storage use, Update all now, Clear offline cache); Sources and sync (R18, Keep import); Settings with Profile (R17), Gemini access (R16), Connect devices (R15) and Offline storage sections.
  - "Open in Obsidian" opens `obsidian://open?vault=<vault name>&file=<path>`, using the vault name from Profile; it is hidden when no vault name is set and for non-Obsidian documents.
  - Chat history sources appear on Sources and sync as "Coming later" and cannot be used.
- Edge cases: Narrow mobile viewport (iPhone), long code lines (horizontal scroll), empty search results, offline banner when disconnected, first visit with no data indexed (each Home card shows an empty state, not sample data).
- Acceptance criteria:
  - Given the running app at `localhost`, when opened on desktop or mobile viewport, then user can log in, search, open a rendered Markdown/code document, and install the PWA manifest.

#### R10. Always-On Host & Vault Sync

- Behaviour:
  - Same Docker Compose stack runs on an always-on host (Oracle Always Free Arm primary; Google Cloud `e2-micro` fallback).
  - Supports running initial heavy indexing on workstation and transferring via `pg_dump` / `pg_restore`.
  - Scheduled one-way `rclone` pull fetches Dropbox `Apps/remotely-save` into the server's read-only vault directory every few minutes.
  - Exposed exclusively via Tailscale Funnel (`tailscale funnel`, public `https://<machine>.<tailnet>.ts.net`), with host firewall blocking other inbound ports. Tailscale runs only on the host; devices open the address in a browser and log in, with no Tailscale app (owner decision 2026-11-26, replacing tailnet-only `tailscale serve`).
  - Because the login page is public, the login rate limit counts each visitor separately, so failed guesses from others cannot lock the owner out.
- Edge cases: `rclone` transient Dropbox network error (retry next interval without deleting local vault); Oracle idle-reclamation avoidance (keep memory usage > 20%).
- Acceptance criteria:
  - Given the workstation is powered off, when opening the Funnel HTTPS URL on iPhone over mobile data without the Tailscale app, then search works and a note edited/synced from the phone appears after the next `rclone` pull.

#### R11. Offline Mode & Pinning

- Behaviour:
  - Workbox precaches the PWA app shell so it opens without network.
  - Client pulls incremental changes from `GET /api/sync?since=<cursor>` into Dexie (IndexedDB). All Obsidian/Keep note text is cached by default; repo files are cached only when pinned.
  - MiniSearch indexes cached text in the browser for offline keyword search. Semantic search and Ask LLM are disabled offline with clear UI messaging.
  - Calls `navigator.storage.persist()` and displays usage via `navigator.storage.estimate()` in Settings.
  - Targets < 100 MB cached text for iOS Safari Home Screen quota safety.
- Edge cases: First sync run inside iOS installed Home Screen app (separate storage from Safari tabs); unpinning a repo removes its cached files from IndexedDB.
- Acceptance criteria:
  - Given the PWA installed on iPhone Home Screen and synced, when airplane mode is enabled, then the app opens, searches cached notes and pinned repos via MiniSearch, and displays full document text.

### Redesign features (owner decisions 2026-11-26)

#### R13. Themes, Font, Logo & App Shell

- Behaviour:
  - Light and dark themes from one set of tokens (`ui.md`). Profile offers Light, Dark and System (default System, following `prefers-color-scheme`). The choice is cached on the device and applied before first paint, so the app opens in the right theme offline.
  - Geist and Geist Mono are bundled with the app (woff2, precached for offline). No font or other asset is loaded from a third-party host.
  - The logo is the laurel sprig from `docs/agent/mockups/Main.dc.html`, used for the favicon, the in-app mark and the PWA icons.
  - App shell per `ui.md`: desktop sidebar, tablet top navigation, mobile top bar and bottom tab bar; main-panel top bar with source picker, device count, Online and "Gemini on" pills and avatar; `Ctrl K` / `⌘ K` starts a new search from anywhere.
  - Routes `/`, `/ask`, `/repos`, `/pinned`, `/sources`, `/settings/<section>`, `/doc/<id>`; old `/import` and `/settings` redirect.
- Edge cases: Theme changed on another device (applies on next profile load), System theme switching while the app is open, `prefers-reduced-motion`.
- Acceptance criteria:
  - Given Dark selected, when the app reloads offline, then it paints dark with no light flash.
  - Given a production build, when its files are inspected, then no request goes to a font or CDN host.
  - Given each theme, when every text/background token pair is checked, then contrast is at least 4.5:1.

#### R14. Recent Searches

- Behaviour:
  - The server stores the owner's last 20 searches and last 20 Ask questions in a `recent_queries` table (kind `search` or `ask`, query text, filters, time), so every device shows the same lists.
  - A query is recorded when it runs successfully; repeating a query moves it to the top instead of adding a copy. Each entry can be removed, and each list can be cleared.
  - `GET /api/recent-queries?kind=`, `DELETE /api/recent-queries/:id`, `DELETE /api/recent-queries?kind=`.
  - The sidebar shows Recent searches (Recent questions on the Ask page); clicking one runs it again. Home's mobile layout shows the latest searches. Home's Try asking card shows the last three Ask questions; until there are any, it shows three fixed example questions (owner decision 2026-11-26).
  - Queries run while offline are not recorded.
- Edge cases: Empty or whitespace query (not recorded), very long query (stored truncated to 500 characters), the 21st entry (oldest dropped).
- Acceptance criteria:
  - Given a search run on one device, when another device loads the sidebar, then the search is listed first.
  - Given 21 searches, when the list is read, then it has 20 entries and the oldest is gone.

#### R15. Devices, Sessions & MCP Token

- Behaviour:
  - Sessions move to a server-side `sessions` table (id, token hash, device name, user agent, created, last seen, revoked). Each login creates one device, named from the browser (e.g. "iPhone · Safari") and renamable. The cookie stays HTTP-only, `Secure`, `__Host-` prefixed.
  - Connect devices lists devices with last seen; each can be renamed or signed out, and "Sign out everywhere" (also in Profile) ends every session. Revocation survives restarts.
  - The top bar shows "Personal index · N devices" (active sessions).
  - The MCP token can be rotated from Connect devices: the new token is shown once, only its hash is stored (in the database), and the old token stops working at once. Until the first rotation, `PYTHIA_MCP_TOKEN` from `.env` is used. The page shows the token's last 4 characters, the server URL, a Claude config snippet and the tools exposed, and says the address is public through Tailscale Funnel and protected by the token.
- Edge cases: Rotating while an MCP client is connected (its next call gets 401), signing out the current device (back to Login), sessions issued before this change (they end once; the owner logs in again), user agent missing (name "Unknown device").
- Acceptance criteria:
  - Given two signed-in devices, when one is signed out from the other, then its next `/api` call returns 401, also after a server restart.
  - Given a rotated MCP token, when `/mcp` is called with the old token, then it returns 401, and the new token works.

#### R16. Gemini Access: API Key & Rules

- Behaviour:
  - The Gemini API key can be saved, tested and removed in Settings. It is stored encrypted (AES-256-GCM) in the database with `PYTHIA_SECRETS_KEY` from `.env` (printed by `pnpm --filter server auth-env` alongside the other values); without that variable, saving is refused with a clear message. The key is never returned to the browser or logged: the API reports only whether a key is set, where it comes from (`env` or `settings`) and its last 4 characters. A key in `.env` (`GEMINI_API_KEY`) wins over a saved one.
  - "Test" makes one minimal Gemini call and reports success or the error class (invalid key, rate limited, unreachable).
  - The server counts Gemini requests per day (Asia/Taipei date) and Settings shows "Used today: N requests".
  - Rules on the "Kept away from Gemini" list (R3) gain two kinds: **tags** (an Obsidian note whose frontmatter `tags` or inline `#tag` matches is locked) and **repos** (a repo marked locked, the "Allow Ask to read this repo" switch, sets `allow_llm = false` on all its documents). Google Keep as a whole can be locked too. Each rule shows how many documents it covers. Applying a rule changes `allow_llm` without re-embedding.
  - New notes stay allowed unless a rule matches (no "default Locked" setting).
- Edge cases: Wrong `PYTHIA_SECRETS_KEY` after a restore (key cannot be decrypted: treated as no key, with a warning in Settings), tag with or without `#`, nested tags (`#private/health` matches `private`), a repo rule for a repo later removed from `repos.json`.
- Acceptance criteria:
  - Given a key saved in Settings, when `GET /api/settings/gemini` is called, then the response holds no key text except the last 4 characters, and the database column holds no plain key.
  - Given a note tagged `#private` and a `private` tag rule, when Ask runs on it, then its text never reaches Gemini.
  - Given a locked repo, when Ask runs, then none of its chunks reach Gemini, and Ollama was not called to re-embed anything.

#### R17. Profile & Preferences

- Behaviour:
  - One `profile` row on the server: display name (shown as "Hi, <name>" and as the initial avatar), time zone (default Asia/Taipei), Obsidian vault name (for Open in Obsidian), theme (Light / Dark / System), opening mode (Search or Ask), and note previews in results (on/off). `GET`/`PUT /api/profile`.
  - Profile also shows the signed-in device summary and "Sign out everywhere" (R15).
  - Not built: email sign-in links, profile photo, language switch.
- Edge cases: Empty name (greeting shows "Hi"), unknown time zone name (400), profile edited offline (refused with a message; preferences cached on the device still apply).
- Acceptance criteria:
  - Given a name and theme saved on one device, when another device opens the app, then it shows the same greeting and theme.

#### R18. Status, Sync Now & Sources

- Behaviour:
  - `GET /api/status` returns: server reachable, Gemini available (a key is set and the last call did not fail on the key), document counts per source, active device count, and per source its state (`healthy`, `error` with a short reason, `manual`, `off`), last sync time and schedule.
  - "Sync now" (sidebar card, Pinned page "Update all now", Sources "Sync all") first asks the server to re-scan the vault and fetch every repo now (`POST /api/sync-now`, answered at once; a run already in progress is not started twice), then pulls this device's offline copy. Per repo, "Re-sync" fetches one repo.
  - The server keeps the last 50 activity events in an `activity` table (vault synced with changed count, repos fetched, chunks blocked by the secrets scanner with count only, Keep imported, sync errors). Sources and sync shows them; nothing in them may contain secret text or note content.
  - The sidebar "Offline ready" card shows cached notes, pinned repos, cached size and last sync for this device. Offline it says so and Sync now is disabled.
- Edge cases: Sync now pressed twice quickly, vault path not set (vault shown as `off`), repo fetch failing (state `error`, old index kept), Gemini key removed (pill shows "Gemini off").
- Acceptance criteria:
  - Given Sync now, when a vault file changed since the last scan, then it is indexed without waiting for the watcher or the schedule, and an activity event records the changed count.
  - Given a blocked secret during a fetch, when Sources and sync is opened, then the event shows only the blocked count.

## Constraints

- Platforms: Web PWA (Windows PC, MacBook, iPhone Safari Home Screen, iPad) + Linux/WSL2 Docker host + Streamable HTTP MCP.
- Performance: Vault size < 50 MB (~15 personal repos; tens of thousands of chunks). Exact vector search is fast; HNSW index is optional.
- Privacy and security: Read-only against sources; secrets never indexed; private notes never sent to Gemini free tier; Tailscale Personal plan (non-commercial use only).
- Accessibility: Keyboard-navigable search/document views, >= 4.5:1 contrast in both light and dark themes, >= 44x44px touch targets on mobile.
- Licences: Open-source dependencies only (MIT/Apache/BSD/PostgreSQL); $0 recurring cost.

## Out of scope for this version

- Chat history importers (Claude, ChatGPT, Gemini Takeout)—deferred to Later after Keep import is proven.
- Public `/mcp` endpoint (Tailscale Funnel / Cloudflare Tunnel + OAuth) for Claude web/mobile custom connectors—deferred to Later.
- In-browser offline LLM for desktop browsers—deferred to Later.
- Cross-encoder reranker—deferred to Later unless `hit@5` evaluation shows a gap.
- Work/employer sources (`kind = 'work'`)—excluded until employer approval.

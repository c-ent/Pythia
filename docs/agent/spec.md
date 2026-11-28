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
  - Generates one deterministic `SUMMARY` chunk (`heading_path` starting with `SUMMARY`) per repo from its README, file tree, dependency manifest (`package.json`, `composer.json`, `requirements.txt`), and git commit dates (`First commit` / `Latest commit`, with `:SUMMARY` `mtime` set to the latest commit timestamp). No LLM required.
  - Repo discovery (owner request 2026-11-27): on by default whenever `GITHUB_TOKEN` is set (owner decision 2026-11-27; `PYTHIA_REPOS_DISCOVER=0` turns it off), each 30-minute round first lists the token owner's repos (`GET /user/repos?affiliation=owner`, forks and private included) and adds any repo not already configured, so a new GitHub repo is cloned and indexed without editing the config or restarting. Only the new repo is embedded; configured repos are untouched. Repos named in the config's `exclude` list are never added. Discovery only adds: a repo deleted or renamed on GitHub keeps its index until it is removed from the config by hand. Discovered repos are `kind = 'repo'`, never `work`.
- Edge cases: Repo without a README, empty repo with 0 commits on the default branch (syncs with 0 indexed files and a minimal `SUMMARY` chunk until the first commit arrives), unsupported file language, fetch failure (log error and keep previous index), file exceeding 200 KB, discovery listing fails or is rate-limited (log the error class, keep the current repo list, try again next round).
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

#### R19. Google Drive Documents Ingestion (owner decisions 2026-11-27)

All points below are owner decisions (2026-11-27); no open questions.

- Behaviour:
  - One-way `rclone sync` of the owner's My Drive only (owner decision: not "Shared with me", not shared drives) into the server's read-only `/data/gdrive` directory: at startup, every 30 minutes, and on Sync now. Access is the owner's own Google login through rclone with the read-only scope (`drive.readonly`), kept in the host's rclone config like the Dropbox remote; Pythia never writes to Drive. rclone exports Google Docs as `.docx`, Google Sheets as `.xlsx` and Google Slides as `.pptx`, and filters pulls to supported document extensions so videos, images and archives are not downloaded.
  - Indexed documents: Google Docs and Word `.docx`, Google Sheets and Excel `.xlsx`, Google Slides and PowerPoint `.pptx`, `.pdf` with a text layer, `.md` and `.txt`, plus (owner decision) old Office `.doc` / `.xls` / `.ppt`, OpenDocument `.odt` / `.ods` / `.odp`, `.rtf` and `.csv`.
  - No size cap (owner decision): every document is indexed in full, whatever its size. Not indexed, counted as skipped: files that are not documents (images, audio, video, archives, executables), Google Forms, Drawings and Sites, PDFs without text, encrypted or password-protected files.
  - Chunking: `.docx` headings become `heading_path` and reuse the R3 heading chunker (~300–500 tokens); `.md` and `.txt` use R3 directly; PDF text is split by page, then by the same token target; each sheet of a spreadsheet is a section (`File > Sheet`) split into row windows, with the header row repeated at the top of every chunk; each slide is a section (`File > Slide N: title`) holding its text and speaker notes; a `.csv` is one sheet. `.doc`, `.rtf` and `.odt` are converted to `.docx`, `.xls` and `.ods` to `.xlsx`, and `.ppt` and `.odp` to `.pptx` with LibreOffice headless in the app container, then chunked the same way; a file that fails to convert is skipped and counted.
  - Each file is one `documents` row in a source of the new kind `gdrive` (added to `sources.kind`, owner OK): `path` is relative to the Drive root, `title` is the file name without extension.
  - Same pipeline as the vault: file blocklist, `content_hash` skip, secrets scan on every chunk before embedding or insert (count-only logging), `search_document: ` prefix, `embed_model` per chunk. Files gone from the mirror are deleted from the index; an empty or missing mirror deletes nothing (like `keptEmptyVault`).
  - `allow_llm = true` by default, like Obsidian notes and Keep (owner decision). The Gemini rules list (R16) gets a Drive rule kind that locks either the whole Drive or one Drive folder and its subfolders; applying it changes `allow_llm` without re-embedding.
  - Search, Ask, `/mcp` and the source filter accept `gdrive`. The PWA shows a Drive filter chip, a Drive card on Sources and sync (state, last pull, file count, skipped count, last error), and activity events (pulled with changed count, skipped count, blocked secrets as a count only). Drive text is cached offline like notes (owner decision) and counts toward the R11 ~100 MB target.
  - Work material: the whole Drive is read, so work documents could come in. Folders on the Drive `exclude` list (owner decision; `"exclude"` in `/config/gdrive.json`, edited on the host like the repo config) are never pulled (passed to rclone as `--filter "- /<folder>/**"`) and never indexed; adding an already indexed folder to the list removes its documents at the next round. A `gdrive` source is never `kind = 'work'`.
- Edge cases: Drive unreachable (keep the index, source state `error`, retry next round); Google login revoked or expired (same, and Sources and sync says the Drive login must be renewed on the host); two files with the same name in one Drive folder (rclone keeps one; log the duplicate count); file renamed or moved (old path removed, new path indexed); Doc with no headings; very large file (indexed in full; on the 1 OCPU host it may take hours to embed, and searches still go first per T51); spreadsheet with thousands of rows or empty sheets; slide with no title; Sync now pressed during a scheduled round (no double run).
- Acceptance criteria:
  - Given a Drive with a Google Doc, a Word file, a Google Sheet, an Excel file, a Google Slides deck, a PowerPoint file and a PDF with text, when a round runs, then all of them appear in search with source `gdrive` and heading-, sheet-, slide- or page-scoped chunks, and an image in the same folder is skipped and counted.
  - Given a Drive Gemini rule on a folder, when saved, then that folder's documents get `allow_llm = false` and Ollama is not called.
  - Given a `.doc`, an `.odt`, an `.ods`, a `.ppt`, an `.rtf` and a `.csv` in My Drive, when a round runs, then each is found in search, and a file that fails to convert is skipped and counted.
  - Given a folder on the Drive `exclude` list, when a round runs, then none of its files are pulled or indexed, and a file only shared with the owner (not in My Drive) is never indexed.
  - Given an unchanged file, when the next round runs, then Ollama is not called for it.
  - Given a file deleted from the Drive folder, when the next round runs, then its document is removed; given an empty or missing mirror, then nothing is deleted.
  - Given a Doc with a planted fake key, when indexed, then that chunk is not stored and the logs contain only the count.
  - Given the Google login is revoked, when a round runs, then existing Drive results stay searchable and Sources and sync shows the error.

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
  - Tailnet only (owner decision 2026-11-27): `/mcp` is never served to the public internet. A request that reached the server through Tailscale Funnel is refused with 403 (`tailnet_only`, "/mcp is only available over Tailscale") before the token is checked, so a leaked token is useless outside the owner's tailnet. Requests over the tailnet (a computer running the Tailscale app, signed in to the owner's account) and from the host itself go on to the token check. The web app and `/api` stay public through Funnel (R10).
  - How Funnel traffic is recognised (confirmed from Tailscale's source in T48, `ipn/ipnlocal/serve.go`): Tailscale's Serve/Funnel HTTP proxy deletes any `Tailscale-Funnel-Request` header the client sent, in every spelling (case-insensitive, `_` read as `-`), sets it to `?1` on Funnel traffic, and sets (does not append) `X-Forwarded-For` to the connecting address: the public visitor's for Funnel, the peer's Tailscale address for tailnet traffic. `/mcp` refuses a request when any spelling of the Funnel header is present, and also unless `X-Forwarded-For` is exactly one Tailscale address (`100.64.0.0/10` without `100.115.92.0/23`, or `fd7a:115c:a1e0::/48`). So it fails closed: if Tailscale stopped setting the Funnel header, the visitor's public address would still be refused. A request with no proxy headers from a loopback socket is the host itself and goes on to the token check. Funnel must stay an HTTP proxy (`tailscale funnel 3000`); a raw TCP forward sets no headers.
  - Address over the tailnet: the same `https://<machine>.<tailnet>.ts.net/mcp` as the web app. On a computer with Tailscale on and MagicDNS enabled, that name resolves to the host's Tailscale address, so the connection arrives over the tailnet, not through Funnel. Without Tailscale (or without MagicDNS) the name resolves to Funnel's public relays and `/mcp` answers 403.
  - Tools: `search(query, sources?, repo?, limit?)`, `get_document(source, path)`, `list_repos()`, `get_repo_overview(repo)`, `recent_changes(days, source?)`.
- Edge cases: Missing or invalid bearer token returns 401; Funnel request with a valid token returns 403; a visitor sending a forged or stripped Tailscale header cannot reach the tools from the public address; unknown repo or document returns a clean MCP tool error.
- Acceptance criteria:
  - Given Claude Code configured with `--transport http` and the bearer token, on a computer on the owner's tailnet, when asked a question about an indexed note, then it calls `search` / `get_document` and returns the right answer.
  - Given a request that arrived through Funnel with a valid token, when sent to `/mcp`, then it returns 403 and no tool runs.

#### R8. Ask Mode (LLM Answers with Privacy & Fallbacks)

- Behaviour:
  - `POST /api/ask` runs hybrid search (diversified across documents), passes a privacy-filtered index catalog (repos with first/latest commit dates and languages, plus recent documents) alongside passages, enriches named-repo or temporal/overview questions with `:SUMMARY`/recent passages, and enforces `allow_llm`: chunks and catalog entries from `allow_llm = false` documents are never sent to Gemini.
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
  - Exception: `/mcp` is tailnet only (R7, owner decision 2026-11-27). A computer that runs an MCP client (Claude Code) needs the Tailscale app signed in to the owner's account. Phones and tablets need nothing: they use the web app only.
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
  - App shell per `ui.md`: desktop sidebar, tablet top navigation, mobile top bar and bottom tab bar; main-panel top bar with source picker, device count, unified status pill (with a popover for server, service and key checks), and avatar; `Ctrl K` / `⌘ K` starts a new search from anywhere.
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
  - The sidebar shows up to 2 Recent searches (Recent questions on the Ask page) without scrolling, always keeping the latest one or two as new queries run; clicking one runs it again. Home's mobile layout shows the latest searches. Home's Try asking card shows the last three Ask questions; until there are any, it shows three fixed example questions (owner decision 2026-11-26).
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
  - The MCP token can be rotated from Connect devices: the new token is shown once, only its hash is stored (in the database), and the old token stops working at once. Until the first rotation, `PYTHIA_MCP_TOKEN` from `.env` is used. The page shows the token's last 4 characters, the server URL, a Claude config snippet and the tools exposed.
  - Connect devices explains that the web app is public through Tailscale Funnel but `/mcp` only works over Tailscale (R7), and gives the setup steps for a computer: 1) install the Tailscale app and sign in to the same Tailscale account as the host; 2) check the host shows up in Tailscale (`tailscale status`, or the app's device list); 3) run the `claude mcp add` command shown on the page with the current token; 4) if Claude Code reports 403, the request did not go over Tailscale: turn Tailscale on and try again; if it reports 401, the token is wrong or was rotated. Phones and tablets need none of this. The address shown is the one that works over the tailnet (confirmed in the T48 task).
  - The page offers only the `claude mcp add` command (stored in the user's Claude config), not a `.mcp.json` file, so the token is not saved in a project folder that could be committed.
- Edge cases: Rotating while an MCP client is connected (its next call gets 401), signing out the current device (back to Login), sessions issued before this change (they end once; the owner logs in again), user agent missing (name "Unknown device").
- Acceptance criteria:
  - Given two signed-in devices, when one is signed out from the other, then its next `/api` call returns 401, also after a server restart.
  - Given a rotated MCP token, when `/mcp` is called with the old token, then it returns 401, and the new token works.

#### R16. Gemini Access: API Key & Rules

- Behaviour:
  - The Gemini API key can be saved, tested and removed in Settings. It is stored encrypted (AES-256-GCM) in the database with `PYTHIA_SECRETS_KEY` from `.env` (printed by `pnpm --filter server auth-env` alongside the other values); without that variable, saving is refused with a clear message. The key is never returned to the browser or logged: the API reports only whether a key is set, where it comes from (`env` or `settings`) and its last 4 characters. A key in `.env` (`GEMINI_API_KEY`) wins over a saved one.
  - "Test" makes one minimal Gemini call and reports success or the error class (invalid key, rate limited, unreachable).
  - The server counts Gemini requests per day (Asia/Taipei date) and Settings shows "Used today: N requests".
  - Rules on the "Kept away from Gemini" list (R3) gain two kinds: **tags** (an Obsidian note whose frontmatter `tags` or inline `#tag` matches is locked) and **repos** (a repo marked locked, the "Allow Ask to read this repo" switch, sets `allow_llm = false` on all its documents). Google Keep as a whole can be locked too. Each rule shows how many documents it covers. Applying a rule changes `allow_llm` without re-embedding. `GET /api/settings/llm-exclusions/catalog` returns the indexed Obsidian folders/notes/tags, Drive folders/files and Keep count so Settings groups rules into collapsible **Obsidian**, **GitHub**, **Google Drive** and **Google Keep** sections.
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
  - `GET /api/status` returns: server reachable, Gemini available (a key is set and the last call did not fail on the key), document counts per source, active device count, and per source its state (`healthy`, `error` with a short reason, `manual`, `off`), last sync time, schedule, and optional live `progress` (`stage`, `done`, `total`, optional `item` such as repo name; never file paths or secrets) while syncing.
  - "Sync now" (sidebar card, Pinned page "Update all now", Sources "Sync all") first asks the server to re-scan the vault and fetch every repo now (`POST /api/sync-now`, answered at once; a run already in progress is not started twice), then pulls this device's offline copy. Per repo, "Re-sync" fetches one repo. While syncing, Sources, the top-bar sync menu, and the sidebar card show the current stage, counts/percentage when known, and device pull progress.
  - The server keeps the last 50 activity events in an `activity` table (vault synced with changed count, repos fetched, chunks blocked by the secrets scanner with count only, Keep imported, sync errors). Sources and sync shows them; nothing in them may contain secret text or note content.
  - The sidebar "Offline ready" card shows cached notes, pinned repos, cached size and last sync for this device. Offline it says so and Sync now is disabled.
- Edge cases: Sync now pressed twice quickly, vault path not set (vault shown as `off`), repo fetch failing (state `error`, old index kept), Gemini key removed (status popover shows Gemini `Not set up` / `Off`, Ask falls back).
- Acceptance criteria:
  - Given Sync now, when a vault file changed since the last scan, then it is indexed without waiting for the watcher or the schedule, and an activity event records the changed count.
  - Given a blocked secret during a fetch, when Sources and sync is opened, then the event shows only the blocked count.

### Knowledge map (owner request 2026-11-27)

#### R20. Knowledge Map: Related Documents, Backlinks, Graphs & Topic Map (owner decisions 2026-11-27)

Owner answers 2026-11-27: build after Google Drive (R19); all parts (Related, backlinks, local graph, topic map, whole-vault graph); the mind map is the classic kind, with a centre and many connections; all sources, but repos only through their README and docs, not code; leave out `LICENSE`, `package.json` and similar. Every other detail was left to the builder's recommendation ("do what's better"); those choices are recorded below and can be changed by the owner before the row that uses them is built. Rows T65 to T76b.

- Purpose: show how notes, Keep notes, Drive documents and repo docs connect, including across sources, which have no explicit links between them.
- Map documents (the only documents that appear anywhere in the map):
  - Every Obsidian note, Keep note and Drive document.
  - From repos, only `README*` files at any depth, Markdown and text files under `docs/` or `doc/`, and `CHANGELOG*` and `CONTRIBUTING*` (owner decision: no code files).
  - Never: `LICENSE*`, `COPYING*`, lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `Cargo.lock`, `poetry.lock`, `composer.lock`), `package.json`, config files (`*.config.*`, `tsconfig*.json`, `.eslintrc*`, `.prettierrc*`, `.editorconfig`, `Dockerfile`, `docker-compose*.yml`, CI files under `.github/`), `kind = 'work'` documents, Drive `exclude` folders (R19), and documents with no stored chunks (all dropped by the secrets scanner).
  - Repo code stays searchable in Search, Ask and `/mcp` exactly as today; it is only left out of the map.
- Connections:
  - Semantic (all sources): a document's vector is the mean of its chunk embeddings, stored in `document_vectors` with its `embed_model`. Each map document keeps its top 8 neighbours above a cut-off score in `document_neighbours`, compared only with documents of the same `embed_model` (D5). Stored at index time and refreshed after each index round for changed documents and the documents that listed them, so reading the map never waits on Ollama. The cut-off is cosine similarity 0.6 (confirmed on real data in T67b).
  - Explicit (Obsidian, Keep): wikilinks `[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]`, embeds `![[Note]]`, Markdown links to other notes, inline `#tags` and frontmatter `tags`, and Keep labels. Stored in `links`. Targets resolve by path, then title, then frontmatter `aliases`; when two notes share a title, the one in the same folder wins, then the shorter path. A target that resolves to nothing is kept as a ghost.
  - Structural: a repo is one node, and its map documents hang off it. Tags are nodes of their own, linked to every note that carries them.
- Views:
  - Related panel on the document page: up to 8 semantic neighbours from any source, each with source label, title, a score band (strong, medium, weak) and the neighbour's best matching passage, which is the reason for the link.
  - Backlinks panel on the document page. Wikilinks to other notes become links in the viewer; a ghost target shows as muted text (T69; a link the server has not resolved, for example offline, stays text, see `ui.md`).
  - Local graph on the document page: the document and everything 2 steps out (links, tags, repo node, semantic neighbours, ghost nodes in grey). Force-directed layout. Works offline (T72).
  - Map screen (new navigation item), topic map: the owner types a topic and picks the usual filter chips. Hybrid search (R4) returns up to 40 eligible map documents (deduplicated per document so multi-chunk files cannot crowd out shorter notes, with a semantic chunk similarity cutoff of 0.62 and a 0.54 document-vector floor for borderline chunks below 0.68 so unrelated long documents are dropped). They are grouped in plain TypeScript (no dependency) into 3 to 7 branches by embedding similarity, and a branch with more than 8 documents is split once more, so the map is at most 2 levels deep. Owner decisions 2026-11-28 (T84–T87):
    - **Direct center leaves (T84):** When a topic map has 3 or fewer documents in total, or when a branch holds only 1 document (with no sub-branches), those documents attach directly to the Topic center instead of inserting an intermediate branch node.
    - **Branch labels & optional AI labels (T85):** By default (instant, no LLM call), multi-document branches prefer a shared folder name or `#tag` / Keep label when a clear share of documents in the group match it, falling back to distinctive TF-IDF keywords weighted toward titles and headings (with filler words, numeric-prefix tokens, and same-stem duplicates filtered out). An optional `AI labels` toggle on the Topic Map lets the owner request short natural-language subtopic labels via LLM when online (`Gemini` for branches where all documents have `allow_llm = true`; local `Ollama` or folder/tag/TF-IDF fallback when a branch contains `allow_llm = false` documents—never sending `allow_llm = false` text or titles to Gemini, R8/D4).
    - **2D default + `2D | 3D` view toggle (T86):** On wide screens (`>= 640 px`), the Topic Map defaults to an interactive **Markmap-style bilateral 2D mind map** (central root box for the topic, colour-coded curved Bezier branches fanning left and right, crisp text sitting on underlined horizontal stems with source indicators on leaves, pan/zoom controls, and `2D | 3D` switcher to toggle to the 3D constellation atlas). Under 640 px wide it still defaults to the nested list view, with a toggle to show the map.
    - **In-place expand/collapse + Explore (T87):** Clicking a branch's fork toggle (or branch label) expands or collapses its child sub-branches and document leaves inside the same map so the full picture stays visible; a dedicated `Explore` action on a branch re-centers and builds a new map around its label while passing the parent topic trail as `context` (with an FTS semantic gate of 0.54 and a Back button). Clicking a leaf opens the document; hovering/tapping previews it; an expandable "Where these branches come from" panel links directly to every source document; "Copy as Markdown" copies the map as a nested outline. Online only.
  - Map screen, whole-vault graph: a second view beside the topic map, using the graph API to show every eligible map document, tag and repo; edges are explicit links plus each document's top 3 neighbours. The view has source and repo filters and uses the force-directed graph. Under 640 px wide it defaults to a list, with a toggle to show the graph.
  - Graph Filters, Display, Forces & 2D/3D (owner decisions 2026-11-28, T88–T90):
    - **Filters panel (T88):** Whole-vault graph and document Local graph add a collapsible `Filters` panel (plus a quick node filter box on Topic Map) supporting client-side filtering without re-fetching: `Search nodes` (matches title, path, or `#tag`), `Tags` toggle (show/hide `#tag` nodes), `Repos` toggle (show/hide repo nodes), `Semantic neighbours` toggle (show/hide dashed similarity edges), `Orphans` toggle (show/hide nodes with 0 remaining connections), and `Existing files only` toggle (hide missing/ghost notes on Local graph).
    - **2D | 3D switcher (T89):** Whole-vault and Local graphs keep 3D as default (or switch cleanly) with a `2D | 3D` view toggle that switches between the 3D constellation and a 2D force-directed network layout sharing the same filtered graph and list fallback.
    - **Display & Forces controls (T90):** Collapsible `Display` (`Arrows` toggle, `Label density` / text fade threshold, `Node size`, `Link thickness`, `Animate` / re-layout button) and `Forces` (`Center force`, `Repel force`, `Link force`, `Link distance`) controls adjust the Whole-vault and Local graph rendering and force simulation in real time, with a Reset defaults action.
  - All graphs: colour by source, node size by number of links, click to open, hover (long press on touch) for a preview, zoom and pan. Every graph has a list or nested-list view. Under 640 px wide (iPhone, iPad in split view) the list view is the default and a toggle shows the graph.
  - Graphs use Cytoscape.js (MIT; owner confirmed the dependency and the `document_vectors`, `document_neighbours` and `links` tables on 2026-11-27), lazy-loaded in its own chunk so search and the app shell do not load it.
- REST (built in T68c, T70, T72; web clients in `web/src/api/`):
  - `GET /api/documents/:id/backlinks?limit=` gives `{ documentId, supported, backlinks: [{ id, source, sourceLabel, title, allowLlm, count, display, heading, passage: { headingPath, text } | null }], outgoing: [{ target, heading, display, documentId | null }] }`. Backlinks sorted by title then path. `supported: false` for repo and Drive documents. `outgoing` holds the note's wikilink, embed and Markdown note links; `documentId: null` is a ghost. `target` is the link as stored in `links.target` (wikilink target without heading, Markdown path decoded); the viewer matches it with `noteLinkKey` (`web/src/document/noteLinks.ts`), which mirrors the server's `nameKey`. Passage text is plain text.
  - `GET /api/documents/:id/graph?sources=&repo=` gives `{ documentId, inMap, center, nodes: [{ id, type: document|tag|repo|ghost, label, documentId, source, sourceLabel, path, allowLlm, links, depth }], edges: [{ source, target, kind: link|tag|repo|neighbour, score }], truncated }`. `inMap: false` with no nodes for repo code and boilerplate; 404 for missing, switched-off or `work` documents.
  - `GET /api/graph` is the whole-vault graph: same shape without `depth`, `documentId` and `center`, and no ghosts.
  - `POST /api/topic-map` accepts `{ topic, context?, sources?, repo? }` and returns `{ topic, branches: [{ label, documents: [{ documentId, source, path, title, allowLlm }], branches? }] }`. It embeds the topic (anchored with `context` when drilling down), hybrid-ranks up to 40 eligible map documents with the usual source/repo filters and similarity cutoff, and groups them by stored document-vector similarity. A branch with more than 8 documents has one additional branch level; leaves carry no document text.
  - Sync rows (`/api/sync`) carry `inMap`, `neighbours` (`{ id, score }`) and `links` (`{ kind, target, heading, display }`), so the device builds Related, backlinks and the local graph offline (`web/src/offline/offlineMap.ts`).
- MCP: `related_documents`, `backlinks` and `topic_map` tools, sharing `server/src/search/` with REST. `allow_llm = false` passage text is withheld like in `search`; topic-map labels for any group containing locked documents are generic so keywords derived from their text are not exposed.
- Rules that already apply:
  - Text of `allow_llm = false` documents never goes into a Gemini prompt, including prompts that label topic map groups (R8, D4).
  - `kind = 'work'` never appears; Drive `exclude` folders never appear (R2, R19).
  - Connections are computed only from stored, already scanned chunks (R2); nothing is written back to any source.
  - Source and repo filters are applied inside each query that ranks documents, not only on the outer result (R4).
  - Keyboard navigable, >= 4.5:1 contrast in both themes, >= 44x44px touch targets; every graph has a list alternative for screen readers.
- Edge cases: wikilink to a note that does not exist; two notes with the same title; a note renamed or moved (its old links go); a document with no stored chunks (all dropped by the secrets scanner); boilerplate files (`LICENSE`, lockfiles, `package.json`, configs) that cluster together; chunks with a different `embed_model` or dimension (D5); a very large graph; offline; Ollama busy or down (Related still answers because vectors are stored; topic map needs a query embed).
- Acceptance criteria:
  - Given a repo with `README.md`, `docs/setup.md`, `src/index.ts`, `LICENSE` and `package.json`, when the map is built, then only the README and the setup doc are in it, and `src/index.ts` is still found in Search.
  - Given a Keep note and an Obsidian note about the same subject with no link between them, when the Obsidian note is opened, then the Keep note is in its Related panel.
  - Given note A with `[[B]]`, when B is opened, then A is in B's backlinks.
  - Given a `kind = 'work'` document or a file on the boilerplate list, when any related list, graph or topic map is built, then it is not in it.
  - Given an `allow_llm = false` document in a topic map, when group labels are made, then its text is not in any Gemini request.
  - Given a topic, when the topic map is built, then every leaf opens its document and the map can be read as a nested list.

### Server health & Oracle plan (owner request 2026-11-27)

#### R21. Server Health, Connection Checks & Oracle Plan Usage (owner decisions 2026-11-27)

Owner answers 2026-11-27: show every detail about the server in the app, in Settings; use the Oracle Cloud API for plan usage (not only the limits written into the app); a red "something is broken" dot in the top bar as well as the Settings page; build after the Drive rows and the knowledge map (R19, R20). Other details are the builder's recommendation, recorded below; the owner can change them before the row that uses them is built. Rows T77 to T83b; the rows that need the owner's input (Oracle access, the manual check) come last.

- Host (read inside the app container, which shares the host kernel; `docker-compose.prod.yml` adds `pid: host` and mounts `/` read-only at `/hostfs` via `PYTHIA_HOST_ROOT` for host-wide breakdown):
  - CPU: core count, load average (1, 5, 15 min) and busy % over the last minute, sampled every 10 s in the background, plus top CPU processes (`/proc/<pid>/stat`, falling back to the app process when `/proc` is unavailable).
  - Memory: host total, used and available (`/proc/meminfo`), the memory Ollama holds for loaded models (`GET /api/ps`), and top memory processes (`VmRSS` from `/proc/<pid>/status`).
  - Disk: size, used and free of the filesystem the app runs on (`fs.statfs`), the Postgres database size (`pg_database_size`), and a cached storage breakdown (`createStorageScan`, refreshed every 15 minutes and on demand via `POST /api/status/server/scan`): Pythia areas (Postgres, Ollama models via `/api/tags`, Vault, Repo mirrors, Google Drive mirror), Postgres top tables, host top-level folders, non-redundant largest subdirectories, and largest individual files (single-filesystem walk skipping `/proc`, `/sys`, `/dev`, `/run`, symlinks, hardlink duplicates, and counting `EACCES`/`EPERM` folders).
  - Uptime of the host and the app, app version and git commit.
- Connection checks, each `ok` or `broken` with a short reason (an error class or a status code, never a secret or note text), each with its own 2 s timeout, results cached 30 s:
  - Postgres answers `SELECT 1`.
  - Ollama answers and `nomic-embed-text` is installed; whether it is loaded right now.
  - Gemini key: the existing R16/R18 availability (`off` when no key is set, which is not broken).
  - `GITHUB_TOKEN`: valid (`GET /rate_limit`, which costs no quota) and the remaining core rate limit; `off` when no token is set.
  - Vault folder: mounted and readable (`off` when no `PYTHIA_VAULT_PATH`).
  - Sources: the R18 source states (vault, github, Drive); reported in `checks.sources` and by the top bar's Sync pill (`SyncMenu`), without marking overall server `health` as `broken`.
  - Oracle API: answers with the configured key (`off` when not configured).
- Oracle plan usage (Oracle Cloud Infrastructure API, read-only, refreshed every 15 minutes in the background and kept in memory; the page shows the last good values with "as of", never waits on Oracle):
  - Ampere A1 OCPUs and memory used by all instances in the tenancy against the Always Free 4 OCPU / 24 GB.
  - Block storage: boot and block volumes in the tenancy against 200 GB; volume backups against 5.
  - Outbound data this month against 10 TB.
  - Cost this month from the Usage API (expected $0; anything above $0 is a warning).
  - Reclaim risk: Oracle may reclaim an Always Free instance when over 7 days its CPU 95th percentile, its network use and (A1 only) its memory are all under 20%. From the Monitoring API the page shows the three 7-day values and `at risk` when all three are under 20%.
  - The exact OCI API operations, metric names and limit names (confirmed in T81):
    - Signing: OCI Signature v1 (`rsa-sha256` via Node `crypto`, `keyId="<tenancyId>/<userId>/<fingerprint>"`), signing `date (request-target) host` on `GET`/`DELETE` and `date (request-target) host content-length content-type x-content-sha256` on `POST`/`PUT`.
    - Health check (`identity.<region>.oci.oraclecloud.com`): `GetTenancy` (`GET /20160918/tenancies/{tenancyId}`).
    - Inventory (`iaas.<region>.oraclecloud.com`): `ListCompartments` (`GET /20160918/compartments`), `ListInstances` (`GET /20160918/instances`), `ListVolumes` (`GET /20160918/volumes`), `ListBootVolumes` (`GET /20160918/bootVolumes`), `ListVolumeBackups` (`GET /20160918/volumeBackups`), `ListBootVolumeBackups` (`GET /20160918/bootVolumeBackups`).
    - Limits (`limits.<region>.oci.oraclecloud.com`): `ListLimitValues` (`GET /20190729/limitValues`) and `GetResourceAvailability` (`GET /20190729/services/{serviceName}/limits/{limitName}/resourceAvailability`): service `compute-core` (`standard-a1-core-count`, `standard-a1-memory-count`) and service `block-storage` (`total-storage-gb`, `volume-backup-count` / `backup-count`).
    - Monitoring (`telemetry.<region>.oci.oraclecloud.com`): `SummarizeMetricsData` (`POST /20180401/metrics/actions/summarizeMetricsData`): namespace `oci_computeagent` (`CpuUtilization` with `.percentile(0.95)`, `MemoryUtilization`, `NetworksBytesOut`) and namespace `oci_vcn` (`VnicToNetworkBytes`).
    - Usage (`usageapi.<region>.oci.oraclecloud.com`): `RequestSummarizedUsages` (`POST /20200107/usage`, `granularity: "DAILY"` / `"MONTHLY"`, `queryType: "COST"`).
- Oracle access and secrets:
  - A dedicated Oracle user in its own group with read-only policies (inspect or read only: instances, volumes, metrics, usage reports, limits); never manage or use permissions. The setup steps are shown in Settings › Server and in T83b.
  - Configuration: `PYTHIA_OCI_TENANCY`, `PYTHIA_OCI_USER`, `PYTHIA_OCI_FINGERPRINT`, `PYTHIA_OCI_REGION` in `.env`, and the API private key as a file on the existing `/config` mount (`PYTHIA_OCI_KEY_FILE`, default `/config/oci_api_key.pem`), never in the database, never in git. Any value missing means Oracle is `off`, not broken.
  - Requests are signed with Node's built-in `crypto` (Oracle's RSA-SHA256 request signature), so no Oracle SDK dependency.
  - The key and the OCIDs are never returned by any route or written to logs or activity events; errors are logged by class only. Oracle calls go only to Oracle's own endpoints for the configured region.
- API: `GET /api/status/server`, behind the normal session (R5), not on `/mcp`. Returns host, top processes, cached storage breakdown, checks, Oracle usage and an overall `health`: `broken` when any check is broken, `warning` when any plan value is at or over 90% of its limit, cost is above $0, or reclaim risk is `at risk`, else `ok`. `POST /api/status/server/scan` triggers/awaits a storage breakdown scan (also session-only, never on `/mcp`). `GET /api/status` (R18) gains the same `health` field only, so the top bar reads it without loading the full server status.
- Views:
  - Settings › Server: gauges for CPU, memory and disk; top CPU and memory consumers; storage breakdown (Pythia & service storage, host top-level folders, largest folders, largest files, Postgres tables, Ollama models) with a `Scan storage` button; the connection checks list; Oracle plan usage with each value against its limit; reclaim risk with the three 7-day values; "as of" times; a Refresh button that reruns the checks (Oracle values and storage breakdown keep their 15-minute background refresh).
  - Top bar: two separate status pills (`SyncMenu` and `StatusMenu`) — `SyncMenu` shows `Synced` (green), `Syncing`, or `Sync issue` (red) with a popover listing each source and a link to Sources and sync; `StatusMenu` combines connectivity, server reachability, overall server health, and API key status (`Online` green when `ok`, `Warning` / `Server unreachable` / `Offline` amber, `Server issue` red when `broken` with a screen-reader label naming the broken server checks). Clicking `StatusMenu` opens a status popover listing the Pythia server, server connection checks (PostgreSQL, Ollama, Gemini key, GitHub token, Vault folder, Oracle Cloud), and links to Settings › Server and Settings › Gemini access.
  - Offline: Settings › Server says it needs the server; the top bar status pill shows `Offline` and its popover states that live server and key checks need a connection.
- Edge cases: Oracle API down or rate limited (keep the last good values, check shows broken with the status code); key file missing or unreadable; clock skew rejected by Oracle's signature check (reason says so); Ollama busy embedding (check still answers; the 2 s timeout is the reason when it does not); Docker reporting the overlay filesystem (disk is the filesystem backing it); a second instance in the tenancy (A1 and storage totals cover the whole tenancy, host gauges only this machine).
- Acceptance criteria:
  - Given the Ollama container stopped, when any page is open, then within 60 s the top bar status pill turns red (`Server issue`) and clicking it or opening Settings › Server shows Ollama broken with a reason.
  - Given Oracle configured with a read-only user, when Settings › Server is opened, then A1 OCPUs, memory and block storage match the Oracle console.
  - Given no Oracle values in `.env`, when Settings › Server is opened, then Oracle shows `off` with the setup steps, and `health` is not `broken` because of it.
  - Given any response or log line from the server, then it contains no Oracle key, fingerprint or OCID.

## Constraints

- Platforms: Web PWA (Windows PC, MacBook, iPhone Safari Home Screen, iPad) + Linux/WSL2 Docker host + Streamable HTTP MCP.
- Performance: Vault size < 50 MB (~15 personal repos; tens of thousands of chunks). Exact vector search is fast; HNSW index is optional.
- Privacy and security: Read-only against sources; secrets never indexed; private notes never sent to Gemini free tier; Tailscale Personal plan (non-commercial use only).
- Accessibility: Keyboard-navigable search/document views, >= 4.5:1 contrast in both light and dark themes, >= 44x44px touch targets on mobile.
- Licences: Open-source dependencies only (MIT/Apache/BSD/PostgreSQL); $0 recurring cost.

## Out of scope for this version

- Chat history importers (Claude, ChatGPT, Gemini Takeout)—deferred to Later after Keep import is proven.
- Public `/mcp` endpoint (Tailscale Funnel / Cloudflare Tunnel + OAuth) for Claude web/mobile, ChatGPT and other cloud-hosted connectors—deferred to Later. Until then `/mcp` is tailnet only (R7).
- In-browser offline LLM for desktop browsers—deferred to Later.
- Cross-encoder reranker—deferred to Later unless `hit@5` evaluation shows a gap.
- Work/employer sources (`kind = 'work'`)—excluded until employer approval.

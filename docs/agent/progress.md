# Progress

Read at the start of every session. Rewrite before ending one. It is the only thing a new session knows about the last one, so keep it short and current: what is being built, what is open, and what still needs checking. Finished work goes in [completed.md](completed.md).

## Current task

None open. The owner asked on 2026-11-26 to build the front-end rows in order in one go: T28, T29, T30, T31 (needs T34 first), T32, T33, T46. All of them are done and left uncommitted for review. T47, the manual check of the redesign, is done too: the owner looked at it and approved it on 2026-11-26. T19 still needs the Oracle host, and each `b` row is a manual check blocked on setup in the table below.

Redesign notes for the builder: the mock-ups are `docs/agent/mockups/Knowledge-App-UI-Mockups.html` (33 boards inside a `const DATA = {...}` JSON line; each board's HTML is in `boards[i].doc`, titles like "Desktop: Ask") and `Main.dc.html` (desktop home). They are sample data with inline styles; map colors to the `ui.md` tokens. T36 (server sessions), T37 (MCP token rotation), T39 (encrypted Gemini key) and T40 (tag/repo rules) change auth, security or the schema: the owner approved them as a group on 2026-11-26, but show the migration and any new `.env` variable (`PYTHIA_SECRETS_KEY`) before applying. Geist ships as the `geist` npm package (OFL) or as woff2 files under `web/public/fonts/`; either is fine, check the licence file is kept.

Owner follow-up (2026-11-26, not a roadmap row): the search card on `/` now has a clear text row (search/ask icon, bigger field, lime focus ring on the whole card, click anywhere on the row to focus) above a divider, with mode, chips and a round submit below. Source chips and the Settings tabs no longer wrap or show a scrollbar: they sit in `ScrollRow` (`web/src/components/ScrollRow.tsx`, `.scroll-row` in `index.css`), one line that scrolls sideways, fades the edge with more content, maps a vertical mouse wheel to sideways scrolling, and brings the current Settings tab into view. Build, typecheck, lint and all tests pass. Not checked by hand on a phone yet.

## State of the current task

T46 is done (2026-11-26): build, typecheck, lint and all 830 tests pass. There is no Login or Document board in the mock-ups, so both screens follow the shared look of the other boards (panel glow, `rounded-panel` card with the soft light shadow, `strong` primary button, chips in `raised`). Login gained a show/hide password button and the 30-day note; the Document viewer is a centred card. The owner checked the redesign by hand and approved it the same day (T47).

T33 is done (2026-11-26): build, typecheck, lint and all 828 tests pass. `/ask` renders `AskScreen` (the placeholder is gone; `UpcomingScreens.tsx` keeps only Pinned). Search's Ask mode on `/` is unchanged and still shows the answer card above the matches. A follow-up is a fresh `POST /api/ask` with no earlier turns, since the server has no conversation state; if follow-ups should carry context, that is a server change (not planned). The sidebar's "Recent questions" on the Ask page is T35. `useClipboard` (`web/src/hooks/useClipboard.ts`) now backs Copy path and Copy answer.

T32 is done (2026-11-26): build, typecheck, lint and all 812 tests pass. The preview pane starts at 80rem (1280px, the Desktop board width), not `lg`, so the list keeps a readable width beside the rail or sidebar. Per-source counts on the chips are `aria-hidden` (the results heading already announces the total) and hidden while a filter is on, since the other sources would read 0. Not built from the ui.md Search results list: "Ask about these results" and the age on cards. Open in Obsidian needs a vault name in Profile; with none it is hidden everywhere.

T30 is done (2026-11-26): build, typecheck, lint and all 771 tests pass, Postgres suite included (`PYTHIA_DB_TESTS=1`). Migration `004_profile.sql` adds `profile`; run `pnpm --filter server migrate` on any database that predates it. `TopBar`'s `name` prop is still unused: `Avatar` reads the saved name itself. Not done yet from the ui.md Profile list: the signed-in devices summary and Sign out everywhere (need T36 sessions).

T29 is done (2026-11-26): build, typecheck, lint and all 738 tests pass. Sign out moved from the sidebar to Settings › Profile. The tablet boards use a 72px icon rail, not top navigation, so the rail is what was built (ui.md updated; the roadmap row still says "tablet top navigation"). `TopBar` takes `devices`, `gemini` and `name` props that nothing passes yet: T30 should pass the Profile name to `TopBar` and both `Avatar`s, T38 the device count, T41 the Gemini state. `ThemeSwitch` is already in Profile under Appearance; T30 replaces that section with the full Profile form.

T27 is done (2026-11-26): build, typecheck, lint and all 645 tests pass. Header confirmed from Tailscale's source (`addProxyForwardedHeaders` in `ipn/ipnlocal/serve.go`): its HTTP proxy *sets* `X-Forwarded-For` to the connecting client's address (for Funnel, the public visitor's, from `Tailscale-Ingress-Src`), overwriting any copy the visitor sent; it also sets `Tailscale-Funnel-Request: ?1` on Funnel traffic. The docs pages do not mention `X-Forwarded-For`. `createVisitorLimiter` (`server/src/security/rateLimit.ts`, replaces `createAttemptLimiter`) keeps one sliding window per visitor; `visitorKey` takes the header only when it is exactly one IP address (IPv6 keyed by /64, IPv4-mapped IPv6 as IPv4), and anything else (missing, empty, a list, junk) shares one `unknown` window. Past 10,000 tracked visitors, new ones share an `overflow` window. A successful login resets only that visitor. For T19: Funnel must proxy HTTP (`tailscale funnel 3000`, not `--tcp` or a TLS-terminated TCP forward), or no header is set and every visitor shares the `unknown` window, which puts the old lock-out back. Requests made on the host itself (e.g. `curl 127.0.0.1:3000`) also land in `unknown`.

T26 is done (2026-11-26): build, typecheck, lint and all 636 tests pass (two full runs). Decided in the task: Keep notes already stored with `allow_llm = false` are flipped on the next re-import (unchanged notes get `setAllowLlm(true)`, no re-embedding), not by a migration; no real Keep zip has been imported yet (T22b), so nothing needs a one-time update. The `llm_exclusions` list still applies to Obsidian notes only (`TIGHTEN_SQL` filters `kind = 'obsidian'`); Keep notes cannot be excluded one by one. The flaky `document.title` check in `DocumentScreen.test.tsx` failed twice in full runs this session and now uses `waitFor`.

T25 is done (2026-11-26): build, typecheck, lint and all 634 tests pass. The Settings panel is `web/src/screens/LlmExclusionsPanel.tsx`; its path checks live in `web/src/screens/exclusionPaths.ts` (kept out of the component file for the `react-refresh/only-export-components` lint rule) and mirror the server's `normalizeVaultPath` in `server/src/ingest/llmExclusions.ts`, so change both together. Every add or remove PUTs the whole list. Not checked by hand yet: it needs a real login (T9b).

T24 is done (2026-11-26): build, typecheck, lint and all 622 tests pass, Postgres suite included (`PYTHIA_DB_TESTS=1`). Migration `003_llm_exclusions.sql` adds `llm_exclusions`; run `pnpm --filter server migrate` on any database that predates it. `PYTHIA_VAULT_EXCLUDED_FOLDERS` is gone and ignored if still in `.env`, so after deploying, `Private/` notes become Gemini-readable on the next scan unless the owner adds `Private` to the list (T25 panel, or `PUT /api/settings/llm-exclusions`). Not covered yet: a Postgres test for `createPgLlmExclusionStore.replace` (the same-transaction `allow_llm = false` update). Flaky: the `document.title` check in `web/src/screens/DocumentScreen.test.tsx` (set in an effect, asserted without waiting) failed in some runs and passed in the final full run.

T11 is done (2026-11-26): `react-markdown`, `remark-gfm` and `rehype-highlight` are installed (no install scripts; `allowBuilds` unchanged). Build, typecheck, lint and all 602 tests pass. Its manual check on real data is T11b (Blocked, needs T9b).

Housekeeping (2026-11-26, owner OK): deleted the unused Vite template files (`web/src/App.css`, `web/src/assets/`, `web/public/favicon.svg`, `web/public/icons.svg`, `web/README.md`) and the `server/src/appInfo.ts` placeholder and its test; offline search now runs on MiniSearch. Build, typecheck, lint and all 601 tests pass (one test failed once in a loaded `pnpm test` run and passed on the rerun; if it recurs, find which and treat it as flaky).

T13 is done (2026-11-25): build, typecheck, lint and all 319 tests pass. Its live check is T13b (Blocked, needs the Gemini key and `qwen3:4b` pulled).

T12, T14, T15 and T16 are done (2026-11-26): build, typecheck, lint and all tests pass (442 tests). Their manual checks are T12b (needs `PYTHIA_MCP_TOKEN`), T14b (needs T13b and T9b) and T15b (needs `GITHUB_TOKEN` and a `repos.json`).

T20 is done (2026-11-26): build, typecheck, lint and all 471 tests pass, including the Postgres `syncStore.db.test.ts` (`PYTHIA_DB_TESTS=1`) and the fake-indexeddb client tests in `web/src/offline/sync.test.ts`. Migration `002_sync.sql` adds `documents.sync_seq`, the `sync_seq` sequence and `document_tombstones`; run `pnpm --filter server migrate` on any database that predates it.

T17 was split (2026-11-26) into T17 (ingestion), T17c (MCP tools + REST), T17d (Repos screen) and T17b (manual check on real repos). T17 is done: build, typecheck, lint and all 477 tests pass. Each repo's overview is a document at path `:SUMMARY` (`SUMMARY_PATH` in `server/src/ingest/repoIndexer.ts`) with one chunk whose heading path is `SUMMARY > <repo>`; T17c reads it for `get_repo_overview`.

T17c is done (2026-11-26): build, typecheck, lint and all 481 tests pass. `createRepoService` (`server/src/search/repoService.ts`) is an optional dependency of `createApp`; without it `/api/repos` and the `list_repos` / `get_repo_overview` MCP tools are not registered. The MCP overview returns `WITHHELD_TEXT` when the SUMMARY document has `allow_llm = false`; REST returns the summary as stored, like `/api/documents`.

T17d is done (2026-11-26): build, typecheck, lint and all 493 tests pass. Pins live in `localStorage` under `pythia.pinnedRepos` (`web/src/repos/pins.ts`: `readPinnedRepos`, `setRepoPinned`, `usePinnedRepos`); nothing passes them to `syncOnce` yet. T21 wires `usePinnedRepos()` into `useOfflineSync` so pinned repo files sync, and unpinning drops them (the pin-set change already restarts sync from cursor 0).

The owner asked (2026-11-25, `/loop`, and again 2026-11-26) to keep building every task that is not blocked and to record any setup or question under "Waiting on the owner" instead of stopping.

T22, T21, T23 and T18 are done (2026-11-26): build, typecheck, lint and all 574 tests pass. Their manual checks are T22b, T21b, T23b and T18b (all Blocked on owner setup). The production image was built locally (`docker build`): it contains `web/dist` at `/app/web`, `git`, and `/data/repos` owned by `node`. `pnpm --filter server eval server/eval.example.json` ran against the local (empty) index: 0/3, as expected. T11 followed the same day (see above).

T8's roadmap verify path `server/src/auth/auth.test.ts` does not match the module layout in `architecture.md`; the tests live in `server/src/security/auth.test.ts` and `server/src/routes/auth.test.ts`.

T7's real-vault relevance check is T7b (Blocked); it needs the owner's 10 questions.

The session cookie is `__Host-` prefixed and `Secure`. Browsers keep it on `http://localhost` (Chromium, Firefox), and `vite.config.ts` proxies `/api` to `127.0.0.1:3000` so dev uses one origin. Safari may refuse a `Secure` cookie on plain `http://localhost`; test T9b in Chrome or Firefox, or over `tailscale serve` HTTPS.

## Owner decisions (2026-11-25)

- Host: Oracle Always Free (Arm). Embeddings are `nomic-embed-text`, `vector(768)`.
- Styling: Tailwind CSS. Icons: `lucide-react`. PWA: `vite-plugin-pwa`.
- T4 frontmatter: use a real YAML parser (the `yaml` package) rather than a hand-written one.
- New packages are approved when they are well maintained and the better choice; no need to ask per package. Install-script (`allowBuilds`) decisions for pnpm 12 still go to the owner.
- `argon2` install script: allowed (`allowBuilds: { argon2: true }` when T8 adds it).
- `nomic-embed-text` pulled into the `ollama` container (owner approved) for T5's live smoke test.
- T13 local fallback model: owner asked for the best choice. Picked `qwen3:4b` (about 2.5 GB; the strongest all-round 3–4B instruct model on CPU in Nov 2026 roundups). `OLLAMA_CHAT_MODEL` overrides it (`phi4-mini` or `llama3.2:3b` are lighter alternatives). Gemini default is `gemini-3.5-flash-lite`, the stable Flash-Lite model; `GEMINI_MODEL` overrides it. `gemini-2.5-flash` is deprecated and redirects on 2026-12-01.
- T15: index all of the owner's personal repos (still never `kind = 'work'` or employer repos).

## Owner decisions (2026-11-26)

- Gemini exclusion (answers old open question 1): Gemini may read every Obsidian note by default. Nothing is excluded at first; `Private/` is no longer special. The owner excludes whole folders or single notes in Settings. Frontmatter `llm: false` still keeps a note away. The owner approved the schema change: a new `llm_exclusions` table. Spec R3/R6 updated; work is T24 (server) then T25 (Settings panel). Decided in T24: `PYTHIA_VAULT_EXCLUDED_FOLDERS` is removed, not kept as a seed, so the list starts empty as the owner asked.
- Google Keep notes may go to Gemini too: Keep defaults to `allow_llm = true` (spec R12 updated). Work is T26.
- Access: Tailscale Funnel, because it is free and needs no domain and no Tailscale app on devices (Cloudflare Access was offered but needs a paid domain). Security rule changed with the owner's OK: AGENTS.md, spec R10 and architecture updated. The login limit is per visitor since T27. `docker-compose.prod.yml` comments still say `tailscale serve`; T19 updates them with the real Funnel setup.
- UI redesign (later the same day): rebuild the web app to the mock-ups in `docs/agent/mockups/` (`Knowledge-App-UI-Mockups.html` holds 33 boards: desktop, tablet, mobile, logos; `Main.dc.html` is the desktop home). Light **and** dark themes (Light / Dark / System). Font: Geist, bundled with the app (not loaded from Google Fonts). Logo: the laurel sprig from `Main.dc.html` (may change later). Build the five new features too: recent searches, device list, Gemini API key set in the app, Profile page, and Sync now plus Online / "Gemini on" status. Details agreed the same day, all as proposed: recent searches on the server, 20 per list, Search and Ask separate; devices from a server-side sessions table (rename, sign out one, sign out everywhere); Gemini key encrypted with `PYTHIA_SECRETS_KEY`, only last 4 shown, `.env` key wins, daily request counter; Profile with name, time zone, theme, opening mode, note previews (no email links, photo or language); Sync now triggers a server scan and fetch, then the device sync. Beyond the five: chat history shown as "Coming later"; build per-repo Allow Ask, tag rules, Open in Obsidian, Clear offline cache and MCP token Rotate; leave out a default rule for new notes, Add repo, single-note pins and Wi-Fi only; Connect devices text says the address is public via Funnel. Specced as R13–R18.
- Logins work: the owner ran `auth-env` and filled `.env` (hash checked as `argon2id`, both 43-character secrets). The owner confirmed on 2026-11-26 that login works at `localhost`. The rest of T9b (shell at desktop and mobile widths, install prompt) is not confirmed yet.
- Redesign follow-ups (2026-11-26, owner OK): Home's Try asking card shows the last three Ask questions, with fixed examples until there are any (T31 now depends on T34). Moving to server-side sessions (T36) ends every current login once; the owner signs in again on each device. `auth-env` also prints `PYTHIA_SECRETS_KEY` (T39), and the owner pastes that line into `.env` when T39 lands.

## Waiting on the owner

These tasks cannot start, or cannot be verified, without an answer or setup from the owner.

| Task | What is needed | Kind |
| --- | --- | --- |
| T6 (real run), T7b | Path to a local copy of the Obsidian vault for `PYTHIA_VAULT_PATH` in `.env`. Indexing is read-only. For the `app` container the folder also needs a read-only bind mount (`- <path>:/vault:ro`), which T18 makes permanent. | Setup |
| T7b | 10 test questions, each with the note that should come back in the top 5. | Answer |
| T8 (real use), T9b, T10b | Run `pnpm --filter server auth-env` in a terminal, type a login password (12+ characters, not echoed), and paste the three printed lines into `.env`. Until then `/api` answers 401 and login answers 503. | Setup |
| T11b | Same as T10b (login set up, real data indexed), then click a search result and an Ask source: a note renders as Markdown, a repo file as highlighted code with a horizontal scroll on long lines. | Manual verification |
| T12b | `PYTHIA_MCP_TOKEN` in `.env` (printed by `pnpm --filter server auth-env`), the server running, then `claude mcp add --transport http pythia http://127.0.0.1:3000/mcp --header "Authorization: Bearer <token>"` and one question in Claude Code. | Setup + manual verification |
| T13b | `GEMINI_API_KEY` in `.env`, and `docker compose exec ollama ollama pull qwen3:4b` (about 2.5 GB). | Setup |
| T14b | Same as T13b plus T9b (login set up), then ask a question in the web app. | Setup + manual verification |
| T15b | A fine-grained, read-only GitHub token (Contents: read) as `GITHUB_TOKEN` in `.env`, and a `repos.json` listing your repos (format in `.env.example`) with `PYTHIA_REPOS_CONFIG` pointing at it. Then restart and check the log. | Setup + manual verification |
| T15 | Read-only GitHub fine-grained token (or deploy keys) covering the personal repos; confirm whether forks and archived repos count as "all repos". | Setup + answer |
| T18b, T19 | Oracle host account, Tailscale on the host only with Funnel enabled for the tailnet, and on the host: `rclone config` for a Dropbox remote saved under `data/rclone/rclone.conf`, `PYTHIA_RCLONE_SOURCE` (e.g. `dropbox:Apps/remotely-save/<vault>`) in `.env`, then `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`. For the restore half: `scripts/db-dump.sh` on the workstation, copy the file over, `docker compose stop app`, `scripts/db-restore.sh <file> --replace`. | Setup + manual verification |
| T21b | Manual check on an iPhone in airplane mode (needs T19 for HTTPS). | Manual verification |
| T22b | A real Google Keep Takeout zip. | Setup |
| T23b | The 30 evaluation questions with expected paths, in `data/eval/questions.json` (copy `server/eval.example.json`), then `pnpm --filter server eval --save` on the real index. | Answer |

## Open questions

1. **`/mcp` on the public address:** With Funnel, `/mcp` (bearer token only) would be public too. Ask the owner at T19 whether to expose it or funnel only the web app and `/api` (Claude Code on the workstation can use `127.0.0.1`).
2. **App port on the host:** The `app` container binds to `127.0.0.1` inside the container (R5). T18's `docker-compose.prod.yml` uses `network_mode: host` for `app` so the server's `127.0.0.1:3000` is the host's loopback and `tailscale serve` can reach it, with no bind exception. Confirm this with the owner at T19; the base `docker-compose.yml` (workstation) is unchanged.

## Still to check

- T6 against the real vault: first full scan time and chunk count on CPU-only Ollama, once `PYTHIA_VAULT_PATH` is set.
- `chokidar` 6 on the Oracle host's filesystem. If events turn out unreliable on a mount, set `PYTHIA_VAULT_WATCH=0` and rely on the scan after each `rclone` pull (T18).
- Search latency on the real index (one embed call plus one SQL query); the query embedder has a 10 s timeout and no retries.

## Notes for the next session

- Package manager is pnpm 12 (owner decision). One lockfile at the root; `pnpm-workspace.yaml` lists `server` and `web`.
- pnpm 12 blocks dependency install scripts and fails `pnpm install` on any it skipped. The owner chose to deny rather than allow them: `allowBuilds: { esbuild: false }` in `pnpm-workspace.yaml`. A new dependency with an install script needs the same decision from the owner (`pnpm approve-builds '!<pkg>'` to deny).
- Root `pnpm test` runs Vitest with `projects: ['server', 'web']`; each package has its own `vitest.config.ts`. `server/vitest.config.ts` passes only the `PYTHIA_DB_*`, `PYTHIA_DB_TESTS` and Postgres password variables from the root `.env` into tests.
- `.env` exists on this workstation (gitignored) with a generated database password and `PYTHIA_DB_TESTS=1`. The compose stack is running; `docker compose down` stops it (volumes `pythia_pgdata` and `pythia_ollama` keep data).
- Env vars use `PYTHIA_DB_*` names, never libpq `PG*` names: compose passes `.env` into the `postgres` container and its server reads `PGPORT`. This broke the first T2 run (Postgres listened on 5433 inside the container).
- All env parsing goes through `loadConfig` in `server/src/config.ts` (zod). The server host is the constant `127.0.0.1`, not configurable.
- `server` builds with `tsc -p tsconfig.build.json` (excludes tests) to `server/dist/`; it uses `nodenext` modules, so relative imports need `.js` extensions. Migrations live in `server/migrations/` and are found relative to `dist/db/` or `src/db/`.
- Secrets scanner (`server/src/security/secrets.ts`): the ingest pipeline (T6, T15, T22) must call `isBlockedPath` before reading a file and `dropSecretChunks` before embedding. Patterns are non-global regexes on purpose. Test fixtures build fake keys and passwords by string concatenation so no literal secret is ever committed; keep doing that.
- Web (T9): tokens, layout, icons and the router are described in `docs/agent/ui.md`. Web tests use jsdom + Testing Library with `web/src/test/setup.ts` (cleanup, unstub globals, reset URL). Stub `fetch` with `vi.stubGlobal`; never hit a real server from web tests.
- Offline search (`web/src/offline/offlineSearch.ts`) uses the `minisearch` package (owner OK, 2026-11-26) with the module's own `tokenize` (accents dropped, 2+ char words), field boosts title 3 / path 2 / content 1, prefix match on the last query word only, no fuzzy matching, and an extra rank factor so documents matching every word come first. `buildIndex` / `searchIndex` / `searchOffline` keep their old signatures.
- Embeddings: always go through `createOllamaEmbedder` (`server/src/embed/ollama.ts`), which adds the `search_document: ` / `search_query: ` prefixes. Never add them by hand. The live smoke test is opt-in with `PYTHIA_OLLAMA_TESTS=1` (set in this workstation's `.env`).
- Vault ingest: `createVaultIndexer` takes an `IndexStore`, so the logic is tested with the in-memory store in `vaultIndexer.test.ts`; `createPgIndexStore` is the only SQL. T15/T22 importers should reuse `IndexStore.replaceDocument` (one transaction per document).
- Vault env: `PYTHIA_VAULT_PATH` (empty = off), `PYTHIA_VAULT_WATCH` (`1`/`0`). The Gemini exclusion list lives in the `llm_exclusions` table, not in env (T24); `PYTHIA_VAULT_EXCLUDED_FOLDERS` is ignored. The indexer reads the list at every scan and sync; `VaultIndexer.refreshAllowLlm` re-applies it without embedding.
- A full scan of an empty vault folder deletes nothing (`keptEmptyVault`), so a missing mount or a failed sync cannot wipe the index.
- Search: REST routes and `/mcp` tools (T12) must call `createSearchService` (`server/src/search/searchService.ts`) and reuse the zod schemas in `server/src/search/schemas.ts`; `createPgSearchStore` (`server/src/db/searchStore.ts`) is the only search SQL. Snippets come back as plain text plus `[start, end)` highlight offsets, never HTML, so the web app (T10) renders highlights without `dangerouslySetInnerHTML`.
- HTTP: `server/src/app.ts` builds the Express app (`createApp`); `index.ts` only wires config, pool, vault and `listen`. T8 adds auth middleware in front of `/api` in `createApp`. Errors go through `jsonErrorHandler` in `server/src/routes/api.ts`; throw `HttpError` for client-safe errors.
- Auth (T8): `createApp` mounts `createAuthRouter` (login, logout, session) on `/api`, then `requireSession`, then the search routes; `/mcp` sits behind `requireBearer` and the T12 MCP router. argon2id uses Node's built-in `crypto.argon2` (Node 24.7+), not the `argon2` package, so no install script was needed and `allowBuilds` is unchanged. Sessions are stateless HMAC tokens keyed on the session key and the password hash: changing either ends all sessions; logout revocation is in memory only. The login limit is global (10 per 15 minutes) because behind `tailscale serve` every client is `127.0.0.1`.
- Unset auth values close things, never open them: no password hash means login 503 and `/api` 401; no MCP token means `/mcp` 401.
- MCP (T12): `server/src/mcp/mcpServer.ts`. Stateless Streamable HTTP (`sessionIdGenerator: undefined`, JSON responses): a new `McpServer` per `POST /mcp`; `GET`/`DELETE` answer 405. Tools reuse the zod schemas and `SearchService`; `allow_llm = false` snippets and document text are replaced with `WITHHELD_TEXT` because an MCP client passes every result to its model. Unknown errors return `Internal server error` and log the error name only. T17 adds `list_repos` and `get_repo_overview` to `buildMcpServer`.
- Document viewer (T11): `/doc/<id>` is parsed by `documentIdFromPath` in `web/src/router.ts` and maps to the `search` route; `AppShell` keeps `SearchScreen` mounted but hidden under `DocumentScreen`. Use `documentPath(id)` and `followLink` for any new link to a document. `DocumentBody` is lazy-loaded; tests that render it should `await import('../document/DocumentBody')` in `beforeAll`, or the first `findBy` can time out on the cold import.
- DB test suites (`PYTHIA_DB_TESTS=1`) drop their throwaway database with `dropTestDatabase` (`server/src/db/testDatabase.ts`), which waits for the pool's backends to close first; dropping `WITH (FORCE)` right after `pool.end()` raced and sometimes failed the run with an unhandled 57P01. New DB suites should use it too.

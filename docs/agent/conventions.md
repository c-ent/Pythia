# Conventions

Read this when unsure how something is done here. Only rules that the linter, formatter and compiler do not enforce. Rules every session needs are in `AGENTS.md`.

## TypeScript & Node

- Use explicit return types on exported service and DB functions.
- Never read `process.env` scattered across modules; parse and validate all environment variables once at startup in a single `config` module.
- Decide responsive layout from viewport width, not user-agent or device type.

## Data, SQL & Errors

- Validate all external input (HTTP bodies, query params, MCP tool arguments, uploaded Takeout zips, YAML frontmatter) at the boundary before passing it to services.
- Never interpolate user input into SQL strings; always use parameterized queries (`$1`, `$2`).
- Return structured JSON errors (`{ error: { code, message } }`) from Express error middleware; never leak stack traces, DB errors, or secret values to the client.
- When logging secrets-scan hits, log only `{ file, droppedCount }`—never log matched text or regex capture groups.

## Embeddings & Search

- Always attach `search_document: ` when embedding chunks and `search_query: ` when embedding user queries for `nomic-embed-text`.
- Batch embedding requests in groups of 16–32 chunks; never fire unbounded concurrent requests to Ollama.

## Tests

- Tests sit beside the file they test (`*.test.ts`).
- Logic depending on time (sync schedules, `recent_changes`, rate limits) or randomness takes `now` or a clock dependency as an argument.
- Every bug fix comes with a test that fails without the fix.
- Security guardrails (secrets blocklist, `allow_llm = false` filtering, auth 401/429) must have dedicated unit tests.

## Comments and docs

- A comment explains why the code is the way it is, not what a standard API does.
- No history in code comments: no dated notes, "used to", "was removed", or commit IDs.
- Docs state facts plainly. Remove unused code instead of commenting it out.
- Add a new rule here only after the same mistake has been corrected twice.

## Implementation notes

- Owner rule (2026-11-25): new packages are approved without asking when they are well maintained and the better choice. Install-script (`allowBuilds`) decisions still go to the owner.
- Package manager is pnpm 12 (owner decision). One lockfile at the root; `pnpm-workspace.yaml` lists `server` and `web`.
- pnpm 12 blocks dependency install scripts and fails `pnpm install` on any it skipped. The owner chose to deny rather than allow them: `allowBuilds: { esbuild: false }` in `pnpm-workspace.yaml`. A new dependency with an install script needs the same decision from the owner (`pnpm approve-builds '!<pkg>'` to deny).
- Root `pnpm test` runs Vitest with `projects: ['server', 'web']`; each package has its own `vitest.config.ts`. `server/vitest.config.ts` passes only the `PYTHIA_DB_*`, `PYTHIA_DB_TESTS` and Postgres password variables from the root `.env` into tests.
- `.env` exists on this workstation (gitignored) with a generated database password and `PYTHIA_DB_TESTS=1`. The compose stack is running; `docker compose down` stops it (volumes `pythia_pgdata` and `pythia_ollama` keep data).
- Env vars use `PYTHIA_DB_*` names, never libpq `PG*` names: compose passes `.env` into the `postgres` container and its server reads `PGPORT`. This broke the first T2 run (Postgres listened on 5433 inside the container).
- Open Postgres pools with `createPool` (`server/src/db/pool.ts`), never `new pg.Pool`: without its `error` listeners a dropped connection crashes the process (T53). DB test suites keep their own pools with no-op listeners.
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
- Auth (T8): `createApp` mounts `createAuthRouter` (login, logout, session) on `/api`, then `requireSession`, then the search routes; `/mcp` sits behind `requireTailnet` (T48), then `requireBearer` and the T12 MCP router. argon2id uses Node's built-in `crypto.argon2` (Node 24.7+), not the `argon2` package, so no install script was needed and `allowBuilds` is unchanged. Sessions are stateless HMAC tokens keyed on the session key and the password hash: changing either ends all sessions; logout revocation is in memory only. The login limit is global (10 per 15 minutes) because behind `tailscale serve` every client is `127.0.0.1`.
- Unset auth values close things, never open them: no password hash means login 503 and `/api` 401; no MCP token means `/mcp` 401.
- MCP (T12): `server/src/mcp/mcpServer.ts`. Stateless Streamable HTTP (`sessionIdGenerator: undefined`, JSON responses): a new `McpServer` per `POST /mcp`; `GET`/`DELETE` answer 405. Tools reuse the zod schemas and `SearchService`; `allow_llm = false` snippets and document text are replaced with `WITHHELD_TEXT` because an MCP client passes every result to its model. Unknown errors return `Internal server error` and log the error name only. T17 adds `list_repos` and `get_repo_overview` to `buildMcpServer`.
- Document viewer (T11): `/doc/<id>` is parsed by `documentIdFromPath` in `web/src/router.ts` and maps to the `search` route; `AppShell` keeps `SearchScreen` mounted but hidden under `DocumentScreen`. Use `documentPath(id)` and `followLink` for any new link to a document. `DocumentBody` is lazy-loaded; tests that render it should `await import('../document/DocumentBody')` in `beforeAll`, or the first `findBy` can time out on the cold import.
- DB test suites (`PYTHIA_DB_TESTS=1`) drop their throwaway database with `dropTestDatabase` (`server/src/db/testDatabase.ts`), which waits for the pool's backends to close first; dropping `WITH (FORCE)` right after `pool.end()` raced and sometimes failed the run with an unhandled 57P01. New DB suites should use it too.

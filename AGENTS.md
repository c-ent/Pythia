# Pythia

Private, read-only Personal Knowledge Server (PWA + MCP server) that indexes Obsidian notes, personal GitHub repos, and Google Keep exports into PostgreSQL + pgvector for hybrid search and cited LLM answers across PC, MacBook, iPhone, and iPad.

## Commands

*(Unverified until T1 scaffold is complete.)*

- Install: `npm install`
- Dev server (API + web): `npm run dev`
- Build (must pass before finishing any task): `npm run build`
- Typecheck: `npm run typecheck`
- Tests, all: `npm test`
- Test one file: `npx vitest run path/to/file.test.ts`
- Lint one file: `npx eslint path/to/file.ts`
- Local infra (Postgres + Ollama): `docker compose up -d`

## Traps and conventions the code does not show

- `nomic-embed-text` requires prefixing every stored chunk with `search_document: ` and every query with `search_query: `; omitting prefixes silently degrades recall.
- In hybrid search (`RRF k = 60`), source and repo filters MUST be applied inside both the `lexical` and `semantic` CTEs—never only in the outer `SELECT`—or filtered queries drop relevant matches.
- Every ingested chunk MUST pass through the secrets scanner before embedding or DB insert; log only the redacted/dropped count, never the matched value.
- Documents with `allow_llm = false` remain searchable in hybrid search, but their text MUST NEVER be sent to the Gemini API.
- Bind the Express server to `127.0.0.1` only; external access goes exclusively through `tailscale serve`.
- Keep work material out: `kind = 'work'` is disabled by default and must never be auto-enabled.
- After adding a SQL file in `server/migrations/`, run the migration script before running DB tests.

## Boundaries

- **Always:** Run the build, typecheck and tests before finishing a task; update `docs/agent/progress.md` before ending a session.
- **Ask first:** Adding dependencies, changing the database schema or stored data format, changing auth or security rules, changing CI, adding tracking or paid features.
- **Never:** Commit secrets or `.env` files, edit generated files (`dist/`, `web/dist/`, `coverage/`), skip or delete a failing test to make a task pass, build a task that is not the current one.

## Workflow

One task per session. A session starts with a clean context and ends when its task is verified and written down.

1. Read `docs/agent/progress.md`. If it names a current task, continue that task. If not, take the first `Todo` row in `docs/agent/roadmap.md` whose dependencies are `Done`, and write it into `progress.md` as the current task.
2. Build only that task. Its requirement is in `docs/agent/spec.md` under the id the row names.
3. Verify it: run the row's Verify check, then the build, typecheck and tests. Add or update a test for the behaviour the task changes.
4. Write it down: set the row to `Done`, add one line to `docs/agent/completed.md`, update `spec.md` or `architecture.md` if behaviour or structure changed, and clear the current task in `progress.md` with anything the next session needs to know.
5. End the session there. The next task starts in a new session, not in this one.

- A task that cannot pass its Verify check is not done. Set the row to `Blocked`, write the reason in `progress.md`, and end the session.
- Do not invent product behaviour. If a requirement is missing or unclear, add it under Open questions in `progress.md` and ask before building.
- A task that turns out too big for one session is split into new rows in `roadmap.md` before any code is written.
- The handoff between sessions is `progress.md`, not conversation history. Write it so a session with no memory of this one can continue.

## Read when relevant

- Building or changing a feature, or checking what a requirement says: `docs/agent/spec.md`
- Picking the next task, planning, or asked what comes next: `docs/agent/roadmap.md`
- Changing data flow, storage, auth, or module boundaries: `docs/agent/architecture.md`
- Unsure about a convention: `docs/agent/conventions.md`
- Touching UI, styling, layout, theme or icons: `docs/agent/ui.md`

## Git and destructive actions

- Never run `git commit`, `git push`, `git reset --hard`, `git clean`, or force-push unless the owner explicitly asks in this conversation.
- Never delete files or folders, or drop, truncate or delete database data, without asking the owner first and showing exactly what will be affected.
- Commit messages and PR descriptions never credit the agent: no `Co-Authored-By` trailer, no "Generated with" line, no agent name as author.
- Leave changes uncommitted in the working tree for the owner to review, unless the owner asks for a commit.

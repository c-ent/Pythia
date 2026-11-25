# Progress

Read at the start of every session. Rewrite before ending one. It is the only thing a new session knows about the last one, so keep it short and current: what is being built, what is open, and what still needs checking. Finished work goes in [completed.md](completed.md).

## Current task

None. Take the first `Todo` row in [roadmap.md](roadmap.md) whose dependencies are `Done` (`T1`).

## State of the current task

Nothing in progress. Project files are initialized; no application code has been written yet.

## Open questions

1. **Package manager:** `npm` workspaces or `pnpm`? (`AGENTS.md` currently assumes `npm`; update in T1 if using `pnpm`.)
2. **Styling approach:** Tailwind CSS or plain CSS variables/modules for `web/`? (Needed before T9.)
3. **Final always-on host:** Confirm Oracle Always Free (Arm, `nomic-embed-text` 768-dim) vs Google Cloud `e2-micro` (in-process 384-dim) before running the first full production index, since vector dimension (`vector(768)` vs `vector(384)`) is set in the schema.
4. **Local fallback Ollama chat model:** Which small Ollama model should Phase 5 (`T13`) use as the local Ask fallback when Gemini is unavailable or `allow_llm = false`?
5. **Personal repo list & excluded folders:** Which ~15 GitHub repos go in the Phase 6 config, and which Obsidian folders (besides `Private/`) should default to `allow_llm = false`?

## Still to check

- Commands in `AGENTS.md` (`npm run build`, `npm run typecheck`, `npm test`, `npx vitest run`, `npx eslint`) are unverified until `T1` scaffold is complete.

## Notes for the next session

- Start with `T1`: scaffold the TypeScript `server` + `web` workspace, verify all commands in `AGENTS.md`, and remove the unverified note above once they pass.

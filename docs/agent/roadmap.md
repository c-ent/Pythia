# Roadmap

Read this when picking the next task, planning, or asked what comes next. It is the task queue: every requirement in `spec.md` broken into tasks that are built one per session, in order.

## Rules for a task

- One task is one change that can be verified end to end in one session. If it needs "and" to describe, split it.
- Every task names the requirement it serves (`R1`) and a Verify check: a command to run, or a manual step with the expected result.
- Status is `Todo`, `Done` or `Blocked`. The task being built is named in `progress.md`, not here. When a row turns `Done`, delete it here; its line in `completed.md` is the record.
- A task starts only when every task in its Depends on column is `Done`.
- Rows are not permission to build ahead. Build the current task only, even when the next one looks easy.
- A new idea becomes a requirement in `spec.md` first, then rows here.

## Queue

Done rows are removed from this table (`completed.md` lists them). A Depends on id that is not in this table is Done.

| # | Task | Requirement | Depends on | Verify | Status |
| --- | --- | --- | --- | --- | --- |

## Blocked

Every `Blocked` row is a manual check waiting on the owner. What each one needs is in `progress.md` under "Waiting on the owner"; keep the reasons there, not here, so they live in one place.

## Later

Ideas that are not requirements yet. Nothing here is built until it moves into `spec.md` and the queue.

- Chat history importers (Claude export, ChatGPT `conversations.json`, Gemini Takeout scheduled to Dropbox), defaulting `allow_llm = false`.
- Public `/mcp` endpoint via Tailscale Funnel or Cloudflare Tunnel with OAuth for Claude web and mobile custom connectors.
- In-browser offline LLM for desktop browsers.
- Cross-encoder reranker on top of RRF results.
- Separate work database (`kind = 'work'`) if employer approval is ever granted.
- Knowledge map extras (R20, deferred 2026-11-27): saved or pinned topic maps, a map of an Ask answer's cited sources, PNG and Obsidian `.canvas` export, repo code files in the map.

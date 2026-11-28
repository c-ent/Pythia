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
| T7b | Relevance check of hybrid search on the real vault | R4 | T7 | 10 owner-written test questions via `POST /api/search` return the expected note in the top 5 | Blocked |
| T11b | Manual check of the T11 Document viewer on real data | R6, R4 | T11, T9b | Manual: click a search result to open full rendered Markdown or code file | Blocked |
| T15b | Mirror the owner's real repos with the GitHub token | R9, R2 | T15 | Manual: with `GITHUB_TOKEN` and `PYTHIA_REPOS_CONFIG` set, the startup log shows every repo synced, `data/repos/<name>.git` exists for each, and no log line contains the token | Blocked |
| T17b | Manual check of repo search on the owner's repos | R9, R2 | T17c, T15b | Manual: "which repo has X?" returns the right repo in the top 5; planted fake key never enters index | Blocked |
| T18b | Manual check of the production stack with real Dropbox and a restored dump | R10 | T18 | Manual: `rclone` pulls vault read-only and restored DB serves search without re-embedding | Blocked |
| T21b | Manual offline check on an iPhone | R11, R6 | T21, T19 | Manual: installed Home Screen app on iPhone in airplane mode finds a cached note and pinned repo file | Blocked |
| T22b | Manual check of Keep import with a real Takeout zip | R12, R6 | T22, T9b | Manual: upload Keep Takeout zip, search a Keep note, re-upload without duplicates | Blocked |
| T23b | Record the baseline with the owner's 30 questions | R12 | T23, T6, T15b, T22b | Manual: `pnpm --filter server eval --save` on the real index writes `data/eval/results-*.json` with the `hit@5` baseline | Blocked |
| T61b | Manual check of Drive sync on the host | R19 | T61, T63 | Manual: owner sets up the read-only rclone Google Drive remote on the host with their own login; within one round a real Google Doc, Word file, Google Sheet, Excel file, Slides deck, PowerPoint file, text PDF, `.doc`, `.odt` and `.csv` are found in search, an image is skipped and counted, a folder on the exclude list and a file only shared with the owner are not indexed, a Drive Gemini rule locks its folder, and a file deleted in Drive leaves the index after the next round | Blocked |
| T67b | Manual check of Related on real data | R20 | T67 | Manual: owner opens 10 documents of their choice across sources and judges the neighbours; the cut-off is tuned and the value written into R20 | Todo |
| T76b | Manual check of the knowledge map on the PC and an iPhone | R20 | T72, T74, T75, T76 | Manual: on real data a local graph opens in under 2 s, 3 topic maps build in under 10 s each, the whole-vault graph renders in under 5 s, the iPhone shows the list views and the map toggle, the local graph works in airplane mode, and Claude Code gets an answer from `topic_map` | Todo |
| T83b | Manual check of server health on the host (needs owner input) | R21 | T83 | Manual: owner creates the read-only Oracle user and key and sets `.env`; Oracle A1, memory and block storage match the console; stopping the Ollama container shows the red dot within 60 s and starting it clears it | Todo |

## Blocked

Every `Blocked` row is a manual check waiting on the owner. What each one needs is in `progress.md` under "Waiting on the owner"; keep the reasons there, not here, so they live in one place.

## Later

Ideas that are not requirements yet. Nothing here is built until it moves into `spec.md` and the queue.

- Chat history importers (Claude export, ChatGPT `conversations.json`, Gemini Takeout scheduled to Dropbox), defaulting `allow_llm = false`.
- Public `/mcp` endpoint via Tailscale Funnel or Cloudflare Tunnel with OAuth for Claude web and mobile custom connectors.
- In-browser offline LLM for desktop browsers.
- Cross-encoder reranker on top of RRF results.
- Separate work database (`kind = 'work'`) if employer approval is ever granted.
- Knowledge map extras (R20, deferred 2026-11-27): saved or pinned topic maps, a map of an Ask answer's cited sources, LLM-written group labels (Ollama or Gemini, locked text left out), PNG and Obsidian `.canvas` export, repo code files in the map.

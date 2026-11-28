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
| T61b | Manual check of Drive sync on the host | R19 | T61, T63 | Manual: owner sets up the read-only rclone Google Drive remote on the host with their own login; within one round a real Google Doc, Word file, Google Sheet, Excel file, Slides deck, PowerPoint file, text PDF, `.doc`, `.odt` and `.csv` are found in search, an image is skipped and counted, a folder on the exclude list and a file only shared with the owner are not indexed, a Drive Gemini rule locks its folder, and a file deleted in Drive leaves the index after the next round | Todo |
| T67b | Manual check of Related on real data | R20 | T67 | Manual: owner opens 10 documents of their choice across sources and judges the neighbours; the cut-off is tuned and the value written into R20 | Todo |
| T73 | Topic map API: hybrid search top 40 map documents for a topic; grouped in plain TypeScript into 3 to 7 branches, a branch over 8 documents split once more; keyword labels from titles, heading paths and text, no LLM call | R20, R4 | T66 | `pnpm exec vitest run server/src/search` passes (fixture set gives the same groups on every run; no Gemini or Ollama chat call; labels never empty) | Todo |
| T74 | MCP tools `related_documents`, `backlinks` and `topic_map`, withholding `allow_llm = false` text like `search` | R20, R7 | T70, T73 | `pnpm exec vitest run server/src/mcp/mcpServer.test.ts` passes (tool list, withheld text, input errors) | Todo |
| T75 | Map screen, topic map: new Map navigation item; topic box and filter chips; radial tree with the topic in the centre, branches and leaves; clicking a branch builds a new map around its label; Copy as Markdown outline; nested list view (default under 640 px) | R20, R6 | T71, T73 | `pnpm exec vitest run web/src/screens web/src/map web/src/router.test.ts` passes with stubbed `fetch` | Todo |
| T76 | Map screen, whole-vault graph: second view next to the topic map, force-directed, tag and repo nodes, filter chips; list view under 640 px | R20, R6 | T70, T75 | `pnpm exec vitest run web/src/screens web/src/map` passes with stubbed `fetch` | Todo |
| T76b | Manual check of the knowledge map on the PC and an iPhone | R20 | T72, T74, T75, T76 | Manual: on real data a local graph opens in under 2 s, 3 topic maps build in under 10 s each, the whole-vault graph renders in under 5 s, the iPhone shows the list views and the map toggle, the local graph works in airplane mode, and Claude Code gets an answer from `topic_map` | Todo |
| T77 | Host metrics for `GET /api/status/server` (new route, session only): CPU cores, load average and busy % sampled every 10 s, host memory from `/proc/meminfo`, disk from `fs.statfs`, `pg_database_size`, host and app uptime, app version and commit | R21 | T76 | `pnpm exec vitest run server/src/health server/src/routes/serverStatus.test.ts` passes (fixture `/proc` text parsed; 401 without a session; not reachable on `/mcp`) | Todo |
| T78 | Connection checks and `health`: Postgres, Ollama (model installed and loaded, memory held), Gemini, `GITHUB_TOKEN` with rate limit, vault folder, R18 source states; 2 s timeout each, 30 s cache; `health` in `/api/status/server` and `/api/status` | R21, R18 | T77 | `pnpm exec vitest run server/src/health server/src/routes` passes (a hung check times out as broken, an unset token is `off` not broken, no secret in any reason) | Todo |
| T79 | Settings › Server section, host and checks: CPU, memory and disk gauges, checks list with reasons, "as of" times, Refresh, offline message; an Oracle card that says "Not set up yet" until T83 | R21, R6 | T78 | `pnpm exec vitest run web/src/screens/settings` passes with stubbed `fetch` (gauges render, a broken check shows its reason, offline message) | Todo |
| T80 | Top bar red dot when `health` is `broken`, screen-reader label naming the broken checks, opens Settings › Server; no dot offline or on `warning` | R21, R13 | T79 | `pnpm exec vitest run web/src/shell` passes with stubbed `fetch` | Todo |
| T81 | Oracle API client (needs owner input: approve the `PYTHIA_OCI_*` variables and the key file on `/config` before applying): RSA-SHA256 request signing with Node `crypto`, Oracle check; exact API operations and metric names confirmed and written into R21 | R21, R2 | T80 | `pnpm exec vitest run server/src/health/oci` passes (signature matches Oracle's documented test vector; missing values mean `off`; key, fingerprint and OCIDs never in responses or logs) | Todo |
| T82 | Oracle plan usage: A1 OCPUs and memory, block storage and backups, outbound data this month, cost this month, 7-day reclaim-risk values; 15-minute background refresh, last good values kept with "as of"; `warning` health rules | R21 | T81 | `pnpm exec vitest run server/src/health` passes with stubbed Oracle responses (90% gives `warning`, cost above $0 gives `warning`, all three 7-day values under 20% gives `at risk`, an Oracle failure keeps the last values) | Todo |
| T83 | Settings › Server, Oracle card: plan usage against limits, reclaim risk with the three 7-day values, "as of", Oracle setup steps when `off` | R21, R6 | T82, T79 | `pnpm exec vitest run web/src/screens/settings` passes with stubbed `fetch` (values against limits, `at risk` shown, Oracle `off` shows the steps) | Todo |
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

# Progress

Read at the start of every session. Rewrite before ending one. Keep it short (about 5 KB): what is being built, what is open, what still needs checking. Finished work goes in [completed.md](completed.md) as one line; delete old session notes (git keeps them) and put lasting facts in `spec.md` or `architecture.md`. Implementation traps and notes are in [conventions.md](conventions.md) under Implementation notes: read them before touching code.

## Current task

Knowledge map (R20), built one row per session (owner, 2026-11-27). T65 to T72 (with T68c) are done and left uncommitted: build, typecheck, lint and all 1391 tests (110 files) pass. Next: **T73** (topic map API). T67b (owner's manual check of Related) is skipped for now and stays `Todo`.

- The local DB is migrated to 015 only; run `pnpm --filter server migrate` for `016_links.sql`.
- Not yet seen on real data or a real device: T69/T68c (Backlinks, note links), T71 (Graph card), T72 (offline map; each device does one full resync after deploy). The Map screens (T74, T75) must show a "needs the server" note offline.
- The `/backlinks`, `/graph` and offline map row shapes are in `spec.md` R20 (REST).
- Google Drive (R19): all code rows are done and uncommitted. Left: owner runs `rclone config` on the host into `data/rclone/rclone.conf` (scope `drive.readonly`), sets `PYTHIA_DRIVE_REMOTE=gdrive:`, rebuilds, then T61b. A flaky activity test failed once and passed on rerun.

## Waiting on the owner

These tasks cannot start, or cannot be verified, without an answer or setup from the owner.

| Task | What is needed | Kind |
| --- | --- | --- |
Login (`auth-env`, `.env`) and the real vault are set up: the host has indexed all 19 notes since T19, so the old vault-path and password rows are gone.

| T7b | Questions agreed with the owner 2026-11-27 (query → expected note): "how do I calm down during a panic attack" → Stop Overthinking; "why should I repeat someone's last words back to them" → Never Split The Difference; "what stops me from starting creative work" → Do the Work; "Japanese secrets to living a long and happy life" → Ikigai; "what should I post on LinkedIn to get noticed" → Personal Branding; "difference between authentication and authorization" → Cybersecurity — Fundamentals, Shallow & Deep Concepts; "how do I combine two tables in a query" → SQL Mastery Guide; "things an AI agent should never do without asking me" → AI Coding Guardrails; "how to remember what people tell me in conversations" → Cognitive_Training_Active_Listening; "what to run after I git clone a Laravel app" → Cloning Laravel Projects. First run (2026-11-27, during T15b repo indexing) is not valid: 8 of 10 took ~10 s (the query embedder's timeout) and returned no results, because Ollama was busy embedding repo chunks; the 2 that got an embedding in time ranked the right note 1st. Rerun via `POST /api/search` once T15b's `repo fetch round` line has appeared. Separate finding: when the query embed times out, these natural-language questions get zero lexical matches, so search shows nothing rather than degrading. | Waiting (rerun after T15b) |
| T11b | Click a search result and an Ask source: a note renders as Markdown, a repo file as highlighted code with a horizontal scroll on long lines. Note half passed 2026-11-27: `/doc/17` renders from a search result and from an Ask source. Left: a repo file, which needs T15b. Seen on the way and fixed the same day (not deployed yet): Obsidian callouts and `[[#heading]]` links now render (see `ui.md`); recheck on `/doc/17` after the next deploy. | Manual verification |
| T15b | In progress on the host (2026-11-27). Owner answer: every repo on the `c-ent` account counts, forks and private ones included (all personal). Token set (`GITHUB_TOKEN`, all repositories, Contents read-only), `PYTHIA_REPOS_CONFIG=/config/repos.json`; the list was generated on the host from `GET /user/repos?affiliation=owner` with the token (32 repos, 12 private; names lowercased). After restart the log said `repos: 32 configured`, the first mirror `agent-context-template.git` existed, and `grep -c github_pat_` on the logs printed 0. The scheduler clones and indexes one repo at a time, and the `repo fetch round` log line only appears when all 32 are done, so on 1 OCPU this takes hours. Left: that line with `synced: 32` and `failed: []`, and 32 `.git` entries in `/data/repos`. Since T54 (deployed 2026-11-27) new repos are picked up each round by discovery. The T54 deploy restarted the app twice during this round; mirrors already cloned stay, and the indexer's blob check skips files already embedded. `data/config/repos.json` on the PC is an older public-only draft (20 repos) and is not used. | Waiting (host is indexing) |
| T18b | The host, `rclone` and Funnel are set up (T19). Left: the restore half, which T19 skipped by embedding on the host: `scripts/db-dump.sh` on the workstation, copy the file over, `docker compose stop app`, `scripts/db-restore.sh <file> --replace`, then check search works without re-embedding. | Manual verification |
| T21b | Manual check on an iPhone in airplane mode, in the Home Screen app installed from the Funnel URL. | Manual verification |
| T22b | A real Google Keep Takeout zip. | Setup |
| T23b | The 30 evaluation questions with expected paths, in `data/eval/questions.json` (copy `server/eval.example.json`), then `pnpm --filter server eval --save` on the real index. | Answer |

## Open questions

None open. R19, R20 and R21 questions are settled (answers are in `spec.md` R19 to R21).

## Still to check

- T6 on the Oracle host (1 OCPU, CPU-only Ollama): a batch of 8 chunks takes 44–60 s, so batches of 32 went past the old 120 s timeout and the 4 largest notes failed. The host's `.env` sets `PYTHIA_EMBED_BATCH_SIZE=8` and `PYTHIA_EMBED_TIMEOUT_MS=600000`; the full scan then reported 19 notes and `failed: []`. Oracle had no capacity to resize to 2 or 4 OCPUs on 2026-11-26. Chunk count not recorded.
- `chokidar` 6 on the Oracle host's filesystem. If events turn out unreliable on a mount, set `PYTHIA_VAULT_WATCH=0` and rely on the scan after each `rclone` pull (T18).
- Search latency on the real index (one embed call plus one SQL query); the query embedder has a 10 s timeout and no retries.


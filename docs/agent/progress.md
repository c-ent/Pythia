# Progress

Read at the start of every session. Rewrite before ending one. Keep it short (about 5 KB): what is being built, what is open, what still needs checking. Finished work goes in [completed.md](completed.md) as one line; delete old session notes (git keeps them) and put lasting facts in `spec.md` or `architecture.md`. Implementation traps and notes are in [conventions.md](conventions.md) under Implementation notes: read them before touching code.

## Current task

None. T83 is done (`web/src/screens/settings/OracleCard.tsx` and `web/src/api/serverStatus.ts` render Oracle Always Free usage meters against limits, monthly cost, 7-day reclaim risk with CPU/network/memory values and `At risk`, `As of` timestamp, error fallback preserving last good values, and read-only Oracle setup steps when `off`). `T61b` is marked `Blocked` (needs host `rclone` Drive setup and manual verification by the owner); the remaining `Todo` rows in `roadmap.md` (`T67b`, `T76b`, `T83b`) are also manual checks waiting on the owner. Note: `web` full `eslint .` still has pre-existing `react-hooks/set-state-in-effect` errors in `web/src/map/VaultGraphPanel.tsx` and `web/src/screens/MapScreen.tsx` from earlier uncommitted work; `server` lint and `web` lint on `src/shell`, `src/screens/settings`, and `src/api` are clean.

- The local DB is migrated to 015 only; run `pnpm --filter server migrate` for `016_links.sql` before DB integration checks.
- Not yet seen on real data or a real device: T69/T68c (Backlinks, note links), T71 (Graph card), T72 (offline map; each device does one full resync after deploy), and T73 (topic map route on real indexed documents). T74's MCP tools haven't yet been checked from Claude Code against host data. The Map screens (T75) must show a "needs the server" note offline.
- The `/backlinks`, `/graph`, `/topic-map` and offline map row shapes are in `spec.md` R20 (REST); MCP tools are described there too.
- Google Drive (R19): all code rows are done and uncommitted. Left: owner runs `rclone config` on the host into `data/rclone/rclone.conf` (scope `drive.readonly`), sets `PYTHIA_DRIVE_REMOTE=gdrive:`, rebuilds, then T61b. A flaky activity test failed once and passed on rerun.

## Waiting on the owner

These tasks cannot start, or cannot be verified, without an answer or setup from the owner.

| Task | What is needed | Kind |
| --- | --- | --- |
| Login (`auth-env`, `.env`) and the real vault are set up: the host has indexed all 19 notes since T19, so the old vault-path and password rows are gone.
| T7b | Questions agreed with the owner 2026-11-27; rerun via `POST /api/search` after T15b completes. See earlier progress in git history for question list and first-run details. | Waiting (rerun after T15b) |
| T11b | Verify repo file rendering after T15b. Note rendering passed at `/doc/17`; recheck callouts and heading links after deploy. | Manual verification |
| T15b | Host is indexing 32 personal repos; wait for `repo fetch round` with `synced: 32`, `failed: []`, and 32 mirrors under `/data/repos`. | Waiting (host is indexing) |
| T18b | Restore half: dump workstation DB, copy to host, stop app, restore with `--replace`, verify search without re-embedding. | Manual verification |
| T21b | Check installed iPhone app in airplane mode. | Manual verification |
| T22b | Real Google Keep Takeout zip. | Setup |
| T23b | Owner supplies 30 evaluation questions and expected paths in `data/eval/questions.json`. | Answer |
| T61b | Owner runs `rclone config` on the host into `data/rclone/rclone.conf` (`drive.readonly`), sets `PYTHIA_DRIVE_REMOTE=gdrive:`, rebuilds, and verifies the Drive sync cases on real files. | Setup & manual verification |

## Open questions

None. R19, R20 and R21 decisions are in `spec.md`.

## Still to check

- T6 on the Oracle host: 8-chunk batches take 44–60 s; host uses batch size 8 and 600000 ms timeout. Full scan reported 19 notes and no failures; chunk count not recorded. Oracle had no capacity to resize on 2026-11-26.
- `chokidar` 6 reliability on the Oracle host filesystem; disable vault watcher if mount events prove unreliable.
- Search latency on the real index; query embedding has a 10 s timeout and no retries.

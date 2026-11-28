# Progress

Read at the start of every session. Rewrite before ending one. Keep it short (about 5 KB): what is being built, what is open, what still needs checking. Finished work goes in [completed.md](completed.md) as one line; delete old session notes (git keeps them) and put lasting facts in `spec.md` or `architecture.md`. Implementation traps and notes are in [conventions.md](conventions.md) under Implementation notes: read them before touching code.

## Current task

None. Completed architectural deepening across 5 areas: unified 2D/3D network graph views behind `web/src/map/NetworkGraphView.tsx` and `web/src/map/GraphViewportChrome.tsx` (hiding 2D-only sliders in 3D mode); sealed `ts_headline` delimiter parsing inside `server/src/db/searchStore.ts` (`Snippet`) and consolidated HNSW/visibility helpers in `server/src/db/pgHelpers.ts`; grouped server composition into `server/src/runtime/knowledgeRuntime.ts` and `server/src/runtime/healthRuntime.ts` with options objects for `createApiRouter` and `createMcpRouter`; consolidated `MapScreen` / `VaultGraphPanel` session state into `useMapSession` / `useVaultGraphSession` (`web/src/screens/map.ts`); and inlined `TopicAtlas` in `MapScreen.tsx` while moving `SUMMARY_PATH` metadata parsing into `server/src/search/repoService.ts` (`web/src/map/TopicAtlas.tsx` is now unreferenced). Fixed Google Drive settings UI (`web/src/screens/settings/gemini.ts`, `GeminiSection.tsx`, `GeminiSection.test.tsx`) to render nested subfolders in a collapsible tree and inherit stricter parent/root access rules (`No Gemini` / `Excluded`) with weaker options disabled. Completed conversational follow-up context (up to 3 turns in `POST /api/ask`, `allow_llm` still enforced on retrieved passages), SSE token streaming for Ask (Gemini and Ollama with `<think>` filtering), weighted FTS ranking (`server/migrations/018_weighted_fts.sql`: `documents.title_fts` A, `heading_path` B, `content` C), and Search polish ("Ask about these results" and document age on `ResultCard`). **T91** (R18, live sync progress details—stage, done/total counts, percentage, and current repo name—in `GET /api/status`, `SyncMenu`, `SourcesScreen`, and `OfflineCard`/`OfflineRailButton`/`syncNow`, including background server sync state in `OfflineCard`) is done. Sidebar recent queries are capped at 2 without scrolling (`SIDEBAR_RECENT_SHOWN = 2` in `web/src/shell/RecentQueries.tsx`, `Navigation.tsx`, `OfflineCard.tsx`, `index.css`; R14). **T85–T90** (R20, R8, R6: Knowledge Map UX — folder/tag + optional `AI labels` on Topic Map, 2D Markmap-style bilateral tree default + `2D | 3D` switcher, in-place branch expand/collapse + `Explore`, collapsible `Filters`, 2D force-directed network + `2D | 3D` on Whole Vault & Local Graph, and `Display`/`Forces` sliders) are done. **T84** (R20) is done. All roadmap tasks and manual checks (`T7b`, `T11b`, `T15b`, `T17b`, `T18b`, `T21b`, `T22b`, `T61b`, `T67b`, `T76b`, `T83b`; `T23b` skipped) are complete; the queue in `roadmap.md` is empty.

- Real data/device checks completed for R19 (Drive), R20 (Related, Local Graph, Topic Map, Whole-Vault Graph, iPhone list/map & offline local graph, Claude Code MCP `topic_map`), and R21 (Server Health & Oracle Plan).
- The `/backlinks`, `/graph`, `/topic-map` and offline map row shapes are in `spec.md` R20 (REST); MCP tools are described there too.

## Waiting on the owner

These tasks cannot start, or cannot be verified, without an answer or setup from the owner.

| Task | What is needed | Kind |
| --- | --- | --- |
| None. All setup and manual verification tasks are complete. | | |

## Open questions

None. R19, R20 and R21 decisions are in `spec.md`.

## Still to check

- T6 on the Oracle host: 8-chunk batches take 44–60 s; host uses batch size 8 and 600000 ms timeout. Full scan reported 19 notes and no failures; chunk count not recorded. Oracle had no capacity to resize on 2026-11-26.
- `chokidar` 6 reliability on the Oracle host filesystem; disable vault watcher if mount events prove unreliable.
- Search latency on the real index; query embedding has a 10 s timeout and no retries.

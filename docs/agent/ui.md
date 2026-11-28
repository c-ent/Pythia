# UI

Read this when touching UI, styling, layout, theme or icons. Delete this file if the project has no interface.

The design source is the owner's mock-ups in `docs/agent/mockups/` (2026-11-26). `Knowledge-App-UI-Mockups.html` holds every board (Desktop, Tablet, Mobile, logo options); open it in a browser and use Focus view. `Main.dc.html` is the desktop home on its own. The mock-ups use sample data and inline styles: copy their layout, spacing and look, never their sample text, and map their colors to the tokens below. Where a board shows something the spec does not include (see "Not built" at the end), leave it out.

## Theme

Calm, reading-focused, with search and readable text as the hero of every screen. Two themes, **light** and **dark**, chosen in Profile as Light, Dark or System (default System, which follows `prefers-color-scheme`). The choice is cached on the device so the first paint, and offline use, gets the right theme.

- **Light** is the mock-up: a dark sidebar beside a light, rounded main panel with a soft pastel glow (pink, green, lavender) at the top, white cards and a lime accent.
- **Dark** keeps the same layout, sidebar and lime accent; the main panel, cards and text switch to the dark values, and the pastel glow is dimmed.

Styling is Tailwind CSS 4. Every token lives in `web/src/index.css`: the `@theme` block maps each token to a CSS variable, and the variables have light and dark values (`:root` and `[data-theme='dark']`). Components use the utilities Tailwind generates (`bg-canvas`, `text-muted`, `rounded-card`) and never hardcode colors, fonts or radii. The default Tailwind palette is removed, so a color that is not a token does not exist.

## Color tokens

Starting values from the mock-ups. T28 sets the final values and a test checks every text/background pair.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `canvas` | `#F6F6F4` | `#141519` | Main panel background |
| `surface` | `#FFFFFF` | `#1C1F25` | Cards, search box, inputs |
| `raised` | `#F0F0EC` | `#262A31` | Hover rows, segmented-control track, chips |
| `line` | `#DADAD5` | `#33373F` | Borders and dividers |
| `ink` | `#0F0F10` | `#F2F2F2` | Body text |
| `muted` | `#5A5A5A` | `#A9A9AE` | Secondary text, metadata |
| `accent` | `#CCFF00` | `#CCFF00` | Icon tiles, primary buttons, active-nav icon, status dot |
| `on-accent` | `#0F0F10` | `#0F0F10` | Text and icons on `accent` |
| `accent-ink` | `#4F6600` | `#CCFF00` | Accent-colored text and links (lime is unreadable as text on light) |
| `strong` | `#17191E` | `#F2F2F2` | Selected segmented button, round submit button |
| `on-strong` | `#FFFFFF` | `#0F0F10` | Text on `strong` |
| `danger` | `#B3261E` | `#F28B82` | Errors |
| `warning` | `#7A5900` | `#FDD663` | Offline banner text, unreachable server |
| `success` | `#1F6B3A` | `#81C995` | Confirmations, "Online" dot |
| `mark` | `#FFE9A8` | `#4A4320` | Snippet highlight background (text stays `ink`) |
| `nav` | `#17191E` | `#0F0F10` | Sidebar and the page frame around the main panel |
| `nav-raised` | `#23262D` | `#1E2127` | Active and hover nav rows, New search button |
| `nav-line` | `#30343C` | `#2A2E35` | Sidebar borders, keyboard-hint chips |
| `nav-ink` | `#FFFFFF` | `#FFFFFF` | Sidebar text |
| `nav-muted` | `#8D8D8D` | `#8D8D8D` | Sidebar labels ("Recent searches") |
| `glow-pink`, `glow-green`, `glow-lavender` | `#F6C3D2`, `#CFE9B8`, `#C4CBF2` | same, at about 15% | Radial glow at the top of the main panel |
| `glow-offline` | `#1C2923` + green glow | same | "Offline ready" card in the sidebar |

Every text color is at least 4.5:1 on the backgrounds it sits on, in both themes; `web/src/theme/tokens.test.ts` reads `index.css` and checks each pair, so add a pair there when a token is used as text on a new background. `accent` (lime) is a fill only: never use `text-accent` on light backgrounds; use `accent-ink`. The manifest and `<meta name="theme-color">` cannot read CSS: they use `nav` (the frame color), which is repeated in `vite.config.ts`, `index.html`, `public/theme-init.js` and `THEME_COLOR` in `src/theme/theme.ts` (the test checks they match).

The theme choice is stored in `localStorage` under `pythia.theme` (`src/theme/theme.ts`). `public/theme-init.js` runs in `<head>` before the app and sets `data-theme` on `<html>` so there is no flash; `ThemeSwitch` is the control.

## Type, spacing and radius

- Font: **Geist** (`font-sans`) and **Geist Mono** (`font-mono`, code blocks and file paths), bundled with the app as woff2 files from `@fontsource-variable/geist` and `@fontsource-variable/geist-mono` (OFL; licence copies in `web/public/licenses/`) and precached for offline (owner decision). The app never loads fonts from Google or any other host. System fonts are the fallback.
- Sizes follow the mock-ups: 52px greeting on desktop (40px tablet, about 30px mobile), 30px page titles, 16–17px card titles, 14–15px body and nav, 12–13px metadata. Inputs stay at least 16px so iOS Safari does not zoom on focus.
- Spacing uses Tailwind's default 0.25rem scale.
- Radius: `rounded-control` (0.75rem) for buttons, inputs and nav rows; `rounded-card` (1.25rem) for cards; `rounded-panel` (1.75rem) for the main panel and the search box; `rounded-full` for chips, badges and status pills.
- Shadows are soft and only on light cards (`0 1px 2px` plus a wide, faint blur on the search box); dark cards use borders instead.

## Layout

- Mobile-first, matching the Desktop (1280), Tablet (834) and Mobile (390) boards.
- **Desktop (from `lg`):** 248px dark sidebar plus the rounded main panel, with a 12px frame gutter in `nav`. The sidebar has, top to bottom: logo and collapse button, New search (`Ctrl K` / `⌘ K`), nav (Search, Ask, Repos with "N indexed", Pinned with "N offline", Sources, Settings), Recent searches (Recent questions on the Ask page), the "Offline ready" card with Sync now, then Gemini access and Import Keep links. The Offline ready card (T43) is not built yet. Recent searches / questions (`web/src/shell/RecentQueries.tsx`, up to 8 entries) rerun an entry on its own screen with the source filter it ran with (`rerunQuery` in `shell/rerun.ts`, which waits for the screen to mount like New search); each entry has a Remove button (shown on hover or focus) and the list has Clear. Every list of a kind reloads when a search or question runs or an entry is removed (`RECENT_QUERIES_CHANGED` window event from `api/recent.ts`, read by `shell/useRecentQueries.ts`). Offline the list says it needs a connection.
- **Tablet (`md` to `lg`):** a 72px icon rail (logo, the six nav items as icon-over-label tiles, avatar at the bottom) beside the main panel, content in one wide column. On desktop the sidebar collapses to the same rail; the choice is kept on this device (`pythia.sidebar`).
- **Mobile (below `md`):** top bar (logo, unified status pill with popover, avatar) and a fixed bottom tab bar: Search, Ask, Repos, Pinned, Settings. Sources and sync and the other Settings sections are reached from Settings.
- The main panel has a top bar: source picker ("All sources"), "Personal index · N devices" (opens Connect devices), unified status pill (`StatusMenu`: single green `Online`, amber `Warning` / `Server unreachable` / `Offline`, or red `Server issue` indicator with a screen-reader label naming broken checks; clicking opens a popover showing Pythia server reachability, PostgreSQL, Ollama, Gemini key, GitHub token, Vault folder, Sources, Oracle Cloud, and links to Settings › Server and Settings › Gemini access), and the avatar (opens Profile).
- Search results from 80rem (1280px, `PREVIEW_PANE_QUERY` in `SearchScreen.tsx`) show the result list (up to 42rem) and a sticky preview of the selected result side by side (Desktop: Search results board); the main column widens to 90rem for it. The first result is selected after each search; a plain click on a card selects it, and Ctrl/⌘-click or middle-click still opens the document in a new tab. Narrower screens open the document instead.
- The shell pads for `env(safe-area-inset-*)` so the tab bar clears the iPhone home indicator.
- Long code blocks scroll horizontally inside their container without page-level horizontal overflow (`pre` is `overflow-x-auto` in the base layer).
- Routing is the History API router in `web/src/router.ts`: `/` (Home and Search), `/ask`, `/repos`, `/pinned`, `/sources`, `/settings/<section>` (`profile`, `gemini`, `devices`, `storage`) and `/doc/<id>`. `/import` and `/settings` redirect to `/sources` and `/settings/profile`. Unknown paths show Home. Nav links are real `<a href>`; in-app links use `followLink`.
- A document at `/doc/<id>` opens over Search: Search stays mounted but hidden, so Back returns to the same query and results.
- Rendered Markdown is styled by the `.markdown` component class in `web/src/index.css`; syntax colors map highlight.js classes (`.hljs-*`) to the theme tokens. Raw HTML in notes is never rendered, images never load (they show as a link), and only `http(s):`/`mailto:` links and links to a heading in the same note stay links.
- Obsidian syntax goes through `remarkObsidian` (`web/src/document/obsidian.ts`): callouts (`> [!type] Title`) render as a `.callout` box tinted by tone (info, success, warning, danger, neutral), and as a `<details>` when foldable (`-` starts closed, `+` open). Wikilinks show their alias or `Note > Heading` text; `[[#Heading]]` and `[text](#Heading)` scroll to the heading (ids `h-<slug>`) without changing the URL; links to other notes open `/doc/<id>` in place when the server resolved them, show as muted text when they are ghosts, and stay accent text when the server has not said (offline, not loaded yet; T69, from the backlinks response); the document page shows a Backlinks panel above Related for Obsidian and Keep notes (title links, alias, heading and link count, plain-text passage), none for repo and Drive documents; `![[embed]]` shows as `[Embed: name]`.

## Screens

Each screen follows its Desktop, Tablet and Mobile boards.

- **Login:** single password field with clear error and rate-limit feedback, in the new theme with the logo. No board covers it, so it borrows the shared look: `panel-glow` background, laurel mark, a `rounded-panel` card, a Show password toggle (`aria-pressed`), a `strong` Sign in button and the 30-day note under the card.
- **Home:** "Hi, <name>" and "What are you looking for?", the search box (Search / Ask toggle, source chips All, Notes, Repos, Keep, round submit button; in Ask mode a note that Gemini answers and locked notes stay out), and three cards: Recent changes, Pinned offline, Try asking. Try asking shows the last three Ask questions; until there are any, it shows three fixed example questions. Home is the idle state of `/` (`SearchScreen` renders `HomeCards` from `screens/HomeScreen.tsx`); the first search or question swaps it for results, and New search brings it back. Cards are one column on phones, two on tablets, three from `lg`; phones add a Recent searches card above them (rerun, Remove per entry, Clear; hidden while empty). Every card has its own empty, loading, error and offline text.
- **Search results:** result count per source on the chips (visual only, shown while no source filter is on), "Ask about these results", result cards (source badge, heading path, age, title, highlighted snippet, file path; code results show the code), and the desktop preview pane (`web/src/search/PreviewPane.tsx`: title, Open page, source, heading trail, Local only, Copy path, Open in Obsidian, then the rendered document). The selected card has the `strong` border and `aria-current`. In Ask mode on Search, `All matches · N results` starts collapsed behind a `Show`/`Hide` toggle (and opens automatically if the answer fails), keeping the answer card and its cited sources uncluttered. "Ask about these results" and the age on cards are not built yet.
- **Ask:** the question, engine badge ("Answered by Gemini" / local model / snippets), answer with numbered citations, a note when a matching note was kept away from Gemini, Copy answer and Show only snippets, an "Answer engine" panel (Gemini first, local model if Gemini fails, snippets always work), a Sources panel, and a follow-up box. Built in `web/src/screens/AskScreen.tsx` (helpers in `screens/ask.ts`): before a question, the box with source chips and Recent questions (or the Try asking examples); after one, the answer column with the engine chain and Sources beside it from `lg` (below it on narrower screens) and the follow-up box under both. The server keeps no conversation, so a follow-up is a new question; New question clears the page. The last question and answer stay in memory while the app is open, so Back from a source shows the same answer. Copy answer copies the text with `[n]` markers and the numbered sources. Show only snippets (`aria-pressed`) swaps the answer for the passages; with engine `retrieval` the passages are the answer and both buttons are hidden. Offline the box is disabled with "Ask needs a connection".
- **Document:** a centred card (up to `max-w-3xl`, no board covers it) with the badges first, then the title, updated date, Copy path and Open in Obsidian, then rendered Markdown or highlighted code, source and Gemini indicator, Copy path, Open in Obsidian (notes only, and only when Profile has a vault name: `obsidian://open?vault=<vault>&file=<path>`, built by `obsidianUrl` in `web/src/document/format.ts`). Copy path and Open in Obsidian are shared with the preview pane (`web/src/document/DocumentActions.tsx`). Under the card, once the document has opened, a **Related** card (`web/src/document/RelatedPanel.tsx`, R20) lists up to 8 neighbours in server order: source badge, band chip (Strong / Medium / Weak match; Strong in `accent-ink`, the others `muted`, all on `raised`), Local only for `allow_llm = false`, the title as a `/doc/<id>` link (`min-h-11`), then the passage's heading trail and text as plain text (never HTML; an ellipsis when the server cut it). It says so for an empty list (lists fill in after the index round), a document outside the knowledge map (`inMap: false`), and an error (with Retry). Offline (T72) the list is built on the device from the synced map rows, without passages, and makes no request; only a document this device holds no copy of says "Related documents need a connection". The Backlinks panel and the viewer's note links work the same way offline ("Backlinks need a connection" only without a copy). Under Related, a **Graph** card (`web/src/map/LocalGraphPanel.tsx`, T71) shows the document and everything 2 steps out. It has a Graph / List toggle (`aria-pressed`, `min-h-11`): the list is the default under 640 px (`GRAPH_DEFAULT_QUERY`) and the graph from there up, and the owner's pick wins for the open page. The graph (`web/src/map/GraphCanvas.tsx` + `web/src/map/AtlasCanvas.tsx`, lazy chunk, shared with `VaultGraphPanel` and `TopicAtlas` in `MapScreen.tsx`) uses a dark cosmic 3D constellation canvas (`web/src/map/atlas3d.ts`) with luminous glowing orbs, 3D force/spherical layout, ambient starfield, rotating 3D axis gizmo, and screen-space label collision culling so labels never stack over each other. Node glow colour is the source (`map-*` tokens: Obsidian, Keep, Drive, Repo, Tag, Missing note in grey, dashed). Tags are diamonds and repos rounded squares, the topic/opened root has an orbital halo ring, and size grows with links. Semantic neighbours are dashed lines. A click or tap opens a document (or drills into a topic branch); tags, repos and ghosts open nothing. Hover or a tap shows a preview (title, source, path, Local only, link count). Drag rotates in 3D, Shift+drag pans, wheel or pinch zooms, and Full screen / Exit full screen (`Esc`), Zoom in, Zoom out and Reset view buttons (44 px) control the viewport (with `MapScreen` using full panel width and tall `dvh` sizing). Colours are re-read from the CSS variables when `data-theme` changes. The canvas is `role="img"` with a label that points to the list. The list groups nodes as Connected directly and Two steps away: documents first, then by links. Each row shows a colour dot, the title (a `/doc/<id>` link for documents, `#tag` text for tags, muted text for ghosts), the source, why the node is there ("Similar content", "Links to this note", "Via A, B") and the link count. A legend names the colours in the graph. The card has its own text for loading, errors (with Retry), offline without a copy of the document ("The graph needs a connection"; with a copy the graph is built on the device, T72), documents outside the map, nothing connected yet, and a graph the server cut down. The `map-*` tokens are fills only, at least 3:1 on `surface` and `canvas` in both themes (`tokens.test.ts`).
- **Repos:** filter by name, language chips with counts, repo cards (initials tile, last update, description, tags, files indexed, Cached / Online only), and a detail panel (languages, files, chunks, last commit, last synced, what is indexed, what is skipped, "Allow Ask to read this repo", Open overview, Re-sync, pin).
- **Pinned and offline:** pinned repos with size and status, offline storage used and its breakdown, persistent storage status, Update all now, Clear offline cache.
- **Sources and sync:** Obsidian vault, GitHub repos and Google Keep with health and last sync, Sync all, Keep Takeout import, chat history marked "Coming later", recent activity.
- **Settings:** sections Profile, Gemini access, Connect devices, Sources and sync, Offline storage (a side list on desktop and tablet, a menu on mobile).
  - **Profile:** initial avatar, display name, time zone, Obsidian vault name, theme (Light / Dark / System), opening mode (Search / Ask), note previews in results, signed-in devices summary, Sign out everywhere.
  - **Gemini access:** API key (status, last 4 characters, Test, Save, Remove), free-tier warning, "Used today: N requests", and "Kept away from Gemini" separated into collapsible sections (**Obsidian** with Folders / Tags / Notes tabs, **GitHub** repo catalog, **Google Drive** whole Drive + folders with the files inside each folder and root files) plus **Google Keep**, each item with its count and Allowed / Locked.
  - **Connect devices:** MCP server URL (this page's origin + `/mcp`, the same `ts.net` name that reaches the host over the tailnet) with an "Only over Tailscale" note (the web app is public through Funnel, `/mcp` answers 403 off the tailnet even with the right token), token (last 4 characters; Rotate shows the new one once), "Set up Claude Code on a computer" with four numbered steps (install Tailscale and sign in to the same account, check `tailscale status`, run the `claude mcp add` command, what 403 and 401 mean) and a note that phones and tablets need none of it, tools exposed, devices list with rename and sign out. Only the `claude mcp add` command is offered, no `.mcp.json`, so the token never lands in a project folder.
- **Offline (mobile):** "You are offline", last synced, cached counts, keyword results, Ask disabled with a reason.

## Icons and images

- Icons: `lucide-react` only, always `aria-hidden="true"` next to a visible or screen-reader label.
- The Pythia mark is the **laurel sprig** from `Main.dc.html` (owner decision 2026-11-26; may change later), shown on a lime `accent` tile. Its shape is defined once in `web/src/components/laurel.ts`; `BrandMark` (tile) and `LaurelSprig` (`currentColor`) in `web/src/components/BrandMark.tsx` draw it in the app.
- `web/public/pythia.svg` (favicon) and the PWA and Home Screen PNGs (`pwa-192.png`, `pwa-512.png`, `pwa-maskable-512.png`, `apple-touch-icon.png`) are generated from `laurel.ts` by `node web/scripts/make-icons.mjs` with no image dependencies. Change `laurel.ts`, then rerun it.

## Motion

Keep transitions minimal (<= 150ms) and disable animations when `prefers-reduced-motion: reduce` is active.

## Accessibility

- Text contrast is at least 4.5:1 in both themes.
- Every interactive control has an accessible label and a minimum touch target of 44x44px on touch viewports.
- Search input is keyboard-focusable (`Ctrl K` / `⌘ K` focuses it from anywhere), and results can be navigated without a mouse.
- Toggles (Search / Ask, chips, Allowed / Locked, theme) use `aria-pressed` or radio groups, never color alone.

## Not built (shown in the mock-ups)

Chat history imports (shown as "Coming later"), the Chats chip, Add repo from the app, pinning single notes, Update on Wi-Fi only, email sign-in links, profile photo, language switch, and a default rule for new notes.

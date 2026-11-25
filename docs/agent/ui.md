# UI

Read this when touching UI, styling, layout, theme or icons. Delete this file if the project has no interface.

## Theme

Dark-mode first, calm, reading-focused interface designed for night eye comfort and quick retrieval—search input and readable document text are the hero of every screen.

Styling approach and exact token file path: not decided yet (see Open questions in `docs/agent/progress.md`). Once chosen in T1/T9, keep all color, spacing, and typography tokens in one file and avoid hardcoded values in components.

## Color tokens

Not decided yet; define in T9 before building screens.

## Type, spacing and radius

Not decided yet; define in T9 before building screens. Must include a readable monospace font stack for code blocks and file paths.

## Layout

- Mobile-first responsive layout covering iPhone (portrait), iPad, MacBook, and desktop monitors.
- Exact breakpoint values and the layout helper module: not decided yet; define in T9.
- Long code blocks scroll horizontally inside their container without causing page-level horizontal overflow.

## Screens & Core Components

- **Login:** Single password field with clear error and rate-limit feedback.
- **Search:** Query input, Search / Ask mode toggle, source filter chips (`obsidian`, `repo`, `keep`), ranked result cards (title, `heading_path`, highlighted snippet, source badge), and cited Ask answer card with engine badge (`gemini` / `ollama` / `retrieval`).
- **Document:** Rendered Markdown, syntax-highlighted code, copyable file path, and `allow_llm` / source indicator.
- **Repos:** Repo list with language, last updated, expandable overview (`SUMMARY`), and offline pin toggle.
- **Import:** Google Keep Takeout `.zip` upload, manual re-index trigger, and index status table.
- **Settings:** Offline storage usage (`navigator.storage.estimate()`), persistent storage status, and pinned repos management.

## Icons and images

Not decided yet; choose one lightweight icon set (e.g., `lucide-react`) in T9 and include PWA Home Screen icons for iOS and desktop.

## Motion

Keep transitions minimal (<= 150ms) and disable animations when `prefers-reduced-motion: reduce` is active.

## Accessibility

- Text contrast is at least 4.5:1 against dark-mode backgrounds.
- Every interactive control has an accessible label and a minimum touch target of 44x44px on touch viewports.
- Search input is keyboard-focusable and results can be navigated without a mouse.

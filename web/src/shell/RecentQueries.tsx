import { History, X } from 'lucide-react'
import { useId } from 'react'
import type { RecentQueryKind } from '../api/recent'
import { rerunQuery } from './rerun'
import { useRecentQueries } from './useRecentQueries'

/** How many entries the sidebar shows; the server keeps 20 per kind. */
export const SIDEBAR_RECENT_SHOWN = 8

const TITLES: Record<RecentQueryKind, string> = { search: 'Recent searches', ask: 'Recent questions' }
const EMPTY: Record<RecentQueryKind, string> = {
  search: 'Searches you run show up here.',
  ask: 'Questions you ask show up here.',
}

/**
 * The sidebar's Recent searches (Recent questions on the Ask page), R14.
 * Clicking an entry runs it again on its own screen; each entry can be removed
 * and the list cleared. Render with `key={kind}` so each kind gets its own list.
 */
export function RecentQueries({ kind, online }: { kind: RecentQueryKind; online: boolean }) {
  const headingId = useId()
  const { status, queries, actionError, remove, clear } = useRecentQueries(kind, SIDEBAR_RECENT_SHOWN, online)
  const title = TITLES[kind]

  let note: string | null = null
  if (status === 'offline') note = 'Needs a connection.'
  else if (status === 'loading') note = 'Loading…'
  else if (status === 'error') note = `Couldn’t load ${title.toLowerCase()}.`
  else if (queries.length === 0) note = EMPTY[kind]

  return (
    // Fills the sidebar's free height and scrolls on its own, so the logo, nav
    // and footer stay put on short windows (how chat-style sidebars do it).
    <section aria-labelledby={headingId} className="mt-6 flex min-h-28 flex-1 flex-col">
      <div className="flex min-h-8 items-center justify-between gap-2 px-3">
        <h2 id={headingId} className="text-xs font-medium tracking-wide text-nav-muted uppercase">
          {title}
        </h2>
        {status === 'ready' && queries.length > 0 ? (
          <button
            type="button"
            onClick={clear}
            aria-label={`Clear ${title.toLowerCase()}`}
            className="rounded-md px-1.5 py-0.5 text-xs text-nav-muted transition-colors hover:bg-nav-raised hover:text-nav-ink"
          >
            Clear
          </button>
        ) : null}
      </div>
      {actionError === null ? null : (
        <p role="alert" className="px-3 py-1 text-xs text-nav-ink">
          {actionError}
        </p>
      )}
      {note === null ? (
        <ul data-testid="recent-list" className="nav-scroll -mx-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1 py-1">
          {queries.map((entry) => (
            <li key={entry.id} className="group relative">
              <button
                type="button"
                onClick={() => rerunQuery(entry)}
                title={entry.query}
                className="flex min-h-10 w-full items-center gap-2.5 rounded-control py-2 pr-10 pl-3 text-left text-sm text-nav-ink/80 transition-colors hover:bg-nav-raised hover:text-nav-ink"
              >
                <History aria-hidden="true" className="size-3.5 shrink-0 text-nav-muted" />
                <span className="min-w-0 flex-1 truncate">{entry.query}</span>
              </button>
              <button
                type="button"
                onClick={() => remove(entry.id)}
                aria-label={`Remove “${entry.query}”`}
                title="Remove"
                className="absolute top-1/2 right-1 grid size-8 -translate-y-1/2 place-items-center rounded-md text-nav-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-nav-line hover:text-nav-ink focus-visible:opacity-100"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-3 py-1.5 text-xs text-nav-muted">{note}</p>
      )}
    </section>
  )
}

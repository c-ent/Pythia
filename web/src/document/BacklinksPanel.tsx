import { Link2, LoaderCircle, Lock, RotateCw } from 'lucide-react'
import { useId } from 'react'
import type { Backlink } from '../api/backlinks'
import { documentPath, followLink } from '../router'
import { headingTrail } from '../search/format'
import { backlinkDetails } from './noteLinks'
import type { BacklinksState } from './useBacklinks'

/**
 * Backlinks panel on the document page (R20, T69): every note of the same
 * source that links to this one, in the server's order (title, then path),
 * each opening `/doc/<id>`. Passage text is plain text, never HTML.
 */
export function BacklinksPanel({ state, retry }: { state: BacklinksState; retry: () => void }) {
  const headingId = useId()
  if (state.status === 'off') return null
  if (state.status === 'done' && !state.response.supported) return null

  let body
  if (state.status === 'offline') body = <PanelNote>Backlinks need a connection.</PanelNote>
  else if (state.status === 'loading')
    body = (
      <p role="status" className="flex items-center gap-2 text-sm text-muted">
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
        Finding backlinks…
      </p>
    )
  else if (state.status === 'error')
    body = (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-danger">
        <span className="flex-1">{state.message}</span>
        <button
          type="button"
          onClick={retry}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-control px-3 text-ink hover:bg-raised"
        >
          <RotateCw aria-hidden="true" className="size-4" />
          Retry
        </button>
      </div>
    )
  else if (state.response.backlinks.length === 0)
    body = (
      <PanelNote>
        No notes link here yet. A link written a moment ago shows up once the note is indexed.
      </PanelNote>
    )
  else
    body = (
      <ol className="divide-y divide-line">
        {state.response.backlinks.map((link) => (
          <BacklinkItem key={link.id} link={link} />
        ))}
      </ol>
    )

  return (
    <section
      aria-labelledby={headingId}
      className="mx-auto mt-6 w-full max-w-5xl rounded-card border border-line/60 bg-surface p-5 shadow-[0_1px_2px_rgb(15_15_16/0.05)] md:p-6"
    >
      <h2 id={headingId} className="mb-3 flex items-center gap-2 text-base font-semibold">
        <Link2 aria-hidden="true" className="size-4 text-muted" />
        Backlinks
      </h2>
      {body}
    </section>
  )
}

function PanelNote({ children }: { children: string }) {
  return <p className="text-sm text-muted">{children}</p>
}

function BacklinkItem({ link }: { link: Backlink }) {
  const path = documentPath(link.id)
  const details = backlinkDetails(link)
  const trail = link.passage === null ? null : headingTrail({ title: link.title, headingPath: link.passage.headingPath })
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <a
        href={path}
        onClick={(event) => followLink(event, path)}
        className="-mx-2 flex min-h-11 items-center rounded-control px-2 text-[0.9375rem] font-medium wrap-break-word text-ink transition-colors hover:bg-raised"
      >
        {link.title}
      </a>
      {details === null && link.allowLlm ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted">
          {details === null ? null : <span>{details}</span>}
          {link.allowLlm ? null : (
            <span className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-0.5" title="Never sent to Gemini">
              <Lock aria-hidden="true" className="size-3.5" />
              Local only
            </span>
          )}
        </div>
      )}
      {link.passage === null ? null : (
        <div className="mt-1 text-sm text-muted">
          {trail === null ? null : <p className="truncate text-xs">{trail}</p>}
          <p className="mt-0.5 wrap-break-word whitespace-pre-line">{link.passage.text}</p>
        </div>
      )}
    </li>
  )
}

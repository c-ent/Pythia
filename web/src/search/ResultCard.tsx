import { Lock } from 'lucide-react'
import type { MouseEvent } from 'react'
import type { SearchResult } from '../api/search'
import { documentPath, followLink } from '../router'
import { headingTrail, timeAgo } from './format'
import { Highlighted } from './Highlighted'
import { SourceBadge } from './SourceBadge'

/** Repo files other than Markdown show their snippet as code. */
function isCode(result: Pick<SearchResult, 'source' | 'path'>): boolean {
  return result.source.kind === 'repo' && !/\.(md|mdx|markdown)$/i.test(result.path)
}

/**
 * The title links to the document viewer; the link's hit area covers the whole
 * card. `preview` (Profile › Note previews) shows the snippet under the title.
 * With `onSelect` (wide screens with the preview pane), a plain click selects
 * the card instead of leaving the page; new-tab clicks still open the document.
 */
export function ResultCard({
  result,
  preview = true,
  selected = false,
  timeZone,
  onSelect,
}: {
  result: SearchResult
  preview?: boolean
  selected?: boolean
  timeZone?: string
  onSelect?: () => void
}) {
  const trail = headingTrail(result)
  const href = documentPath(result.documentId)
  const code = isCode(result)
  const timestamp = result.mtime ?? result.updatedAt
  const age = timestamp != null ? timeAgo(timestamp, undefined, timeZone) : ''

  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (onSelect === undefined) {
      followLink(event, href)
      return
    }
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onSelect()
  }

  return (
    <article
      className={`relative rounded-card border bg-surface p-4 transition-colors focus-within:border-accent/60 hover:border-accent/60 ${
        selected ? 'border-strong' : 'border-line'
      }`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <SourceBadge source={result.source} />
        {trail === null ? null : <span className="min-w-0 break-words">{trail}</span>}
        {age === '' ? null : (
          <time dateTime={timestamp ?? undefined} className="shrink-0">
            {age}
          </time>
        )}
        {result.allowLlm ? null : (
          <span className="inline-flex items-center gap-1" title="Never sent to Gemini">
            <Lock aria-hidden="true" className="size-3.5" />
            Local only
          </span>
        )}
      </div>
      <h3 className="mt-2 text-base font-medium break-words">
        <a
          href={href}
          onClick={onClick}
          aria-current={selected ? 'true' : undefined}
          className="outline-none after:absolute after:inset-0 after:rounded-card focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-accent-ink"
        >
          {result.title}
        </a>
      </h3>
      {preview ? (
        code ? (
          <pre className="mt-2 overflow-x-auto rounded-control bg-raised px-3 py-2 font-mono text-[0.8125rem] leading-relaxed whitespace-pre">
            <Highlighted snippet={result.snippet} />
          </pre>
        ) : (
          <p className="mt-2 text-sm leading-relaxed break-words whitespace-pre-line">
            <Highlighted snippet={result.snippet} />
          </p>
        )
      ) : null}
      <p className="mt-2 truncate font-mono text-xs text-muted" title={result.path}>
        {result.path}
      </p>
    </article>
  )
}

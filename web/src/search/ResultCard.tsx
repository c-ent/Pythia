import { Lock } from 'lucide-react'
import type { SearchResult } from '../api/search'
import { documentPath, followLink } from '../router'
import { headingTrail } from './format'
import { Highlighted } from './Highlighted'
import { SourceBadge } from './SourceBadge'

/** The title links to the document viewer; the link's hit area covers the whole card. */
export function ResultCard({ result }: { result: SearchResult }) {
  const trail = headingTrail(result)
  const href = documentPath(result.documentId)
  return (
    <article className="relative rounded-card border border-line bg-surface p-4 transition-colors focus-within:border-accent/60 hover:border-accent/60">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <SourceBadge source={result.source} />
        <span className="min-w-0 truncate font-mono" title={result.path}>
          {result.path}
        </span>
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
          onClick={(event) => followLink(event, href)}
          className="outline-none after:absolute after:inset-0 after:rounded-card focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-accent"
        >
          {result.title}
        </a>
      </h3>
      {trail === null ? null : <p className="mt-0.5 text-sm break-words text-muted">{trail}</p>}
      <p className="mt-2 text-sm leading-relaxed break-words whitespace-pre-line">
        <Highlighted snippet={result.snippet} />
      </p>
    </article>
  )
}

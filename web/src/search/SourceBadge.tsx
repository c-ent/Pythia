import type { SourceRef } from '../api/search'
import { SOURCE_ICONS, sourceLabel } from './format'

export function SourceBadge({ source }: { source: SourceRef }) {
  const Icon = SOURCE_ICONS[source.kind]
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-raised px-2 py-0.5 text-xs text-muted">
      <Icon aria-hidden="true" className="size-3.5" />
      {sourceLabel(source)}
    </span>
  )
}

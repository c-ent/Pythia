import type { ReactNode } from 'react'
import { SOURCE_KINDS, type SourceKind } from '../api/search'
import { ScrollRow } from '../components/ScrollRow'
import { SOURCE_ICONS, SOURCE_LABELS } from './format'

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-line px-3.5 text-sm whitespace-nowrap text-muted transition-colors hover:border-muted/50 hover:text-ink aria-pressed:border-accent aria-pressed:bg-raised aria-pressed:text-ink"
    >
      {children}
    </button>
  )
}

// Visual only: the chip keeps its plain name, and the results heading already
// announces the total.
function Count({ n }: { n: number | undefined }) {
  if (n === undefined) return null
  return (
    <span aria-hidden="true" className="rounded-full bg-raised px-1.5 text-xs text-muted tabular-nums">
      {n}
    </span>
  )
}

/**
 * Source filter. No source selected means every source. `counts` (results
 * per source, and `all` for the total) shows on the chips once a search ran.
 * The chips stay on one line and scroll sideways when they do not fit.
 */
export function SourceChips({
  value,
  onChange,
  counts,
  className = '',
}: {
  value: readonly SourceKind[]
  onChange: (next: SourceKind[]) => void
  counts?: Partial<Record<SourceKind | 'all', number>>
  className?: string
}) {
  const toggle = (kind: SourceKind): void => {
    onChange(value.includes(kind) ? value.filter((k) => k !== kind) : SOURCE_KINDS.filter((k) => k === kind || value.includes(k)))
  }
  return (
    // -m-1 p-1 keeps the focus outline inside the scrolling box.
    <ScrollRow role="group" aria-label="Sources" className={`-m-1 flex gap-2 p-1 ${className}`}>
      <Chip pressed={value.length === 0} onClick={() => onChange([])}>
        All
        <Count n={counts?.all} />
      </Chip>
      {SOURCE_KINDS.map((kind) => {
        const Icon = SOURCE_ICONS[kind]
        return (
          <Chip key={kind} pressed={value.includes(kind)} onClick={() => toggle(kind)}>
            <Icon aria-hidden="true" className="size-4" />
            {SOURCE_LABELS[kind]}
            <Count n={counts?.[kind]} />
          </Chip>
        )
      })}
    </ScrollRow>
  )
}

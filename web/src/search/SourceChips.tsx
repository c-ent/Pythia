import type { ReactNode } from 'react'
import { SOURCE_KINDS, type SourceKind } from '../api/search'
import { SOURCE_ICONS, SOURCE_LABELS } from './format'

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line px-3.5 text-sm text-muted transition-colors hover:text-ink aria-pressed:border-accent aria-pressed:bg-raised aria-pressed:text-ink"
    >
      {children}
    </button>
  )
}

/** Source filter. No source selected means every source. */
export function SourceChips({
  value,
  onChange,
}: {
  value: readonly SourceKind[]
  onChange: (next: SourceKind[]) => void
}) {
  const toggle = (kind: SourceKind): void => {
    onChange(value.includes(kind) ? value.filter((k) => k !== kind) : SOURCE_KINDS.filter((k) => k === kind || value.includes(k)))
  }
  return (
    <div role="group" aria-label="Sources" className="flex flex-wrap gap-2">
      <Chip pressed={value.length === 0} onClick={() => onChange([])}>
        All
      </Chip>
      {SOURCE_KINDS.map((kind) => {
        const Icon = SOURCE_ICONS[kind]
        return (
          <Chip key={kind} pressed={value.includes(kind)} onClick={() => toggle(kind)}>
            <Icon aria-hidden="true" className="size-4" />
            {SOURCE_LABELS[kind]}
          </Chip>
        )
      })}
    </div>
  )
}

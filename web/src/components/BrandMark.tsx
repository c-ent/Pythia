import { LEAVES, STEM, leafPath, leafTransform, stemPath } from './laurel'

/** The laurel sprig alone, in `currentColor`. */
export function LaurelSprig({ className = 'size-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      <path d={stemPath()} fill="none" stroke="currentColor" strokeWidth={STEM.width} strokeLinecap="round" />
      {LEAVES.map((leaf) => (
        <path key={`${leaf.x},${leaf.y},${leaf.angle}`} transform={leafTransform(leaf)} d={leafPath(leaf)} fill="currentColor" />
      ))}
    </svg>
  )
}

/** The Pythia mark: the laurel sprig on a lime tile (same as public/pythia.svg). */
export function BrandMark({ className = 'size-8' }: { className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-control bg-accent text-on-accent ${className}`}>
      <LaurelSprig className="size-3/4" />
    </span>
  )
}

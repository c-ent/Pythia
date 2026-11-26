/** The Pythia mark (same shape as public/pythia.svg), drawn with theme colors. */
export function BrandMark({ className = 'size-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      <circle cx="32" cy="32" r="16.64" fill="none" strokeWidth="5.12" className="stroke-accent" />
      <circle cx="32" cy="32" r="6.4" className="fill-ink" />
    </svg>
  )
}

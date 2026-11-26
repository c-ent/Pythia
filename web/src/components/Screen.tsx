import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export function ScreenHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description === undefined ? null : <p className="mt-1 text-sm text-muted">{description}</p>}
    </header>
  )
}

/** A calm card for a screen or section that has nothing to show yet. */
export function Placeholder({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-surface p-6 text-center">
      <Icon aria-hidden="true" className="mx-auto size-8 text-muted" />
      <h2 className="mt-3 text-base font-medium">{title}</h2>
      <p className="mx-auto mt-1 max-w-prose text-sm text-muted">{children}</p>
    </section>
  )
}

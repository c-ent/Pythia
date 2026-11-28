import { ArrowLeft, LoaderCircle } from 'lucide-react'
import { useOnline } from '../hooks/useOnline'
import { followLink, pathFor } from '../router'
import { statusErrorText } from '../sources/format'
import { useServerStatus } from '../sources/useServerStatus'
import { ActivityRow, Alert, EmptyCard } from './SourcesScreen'

/** Full recent activity list at `/sources/activity`. */
export function ActivityScreen() {
  const online = useOnline()
  const server = useServerStatus(online, { pollWhileSyncing: true })
  const status = server.status
  const events = status?.activity ?? []
  const sourcesUrl = pathFor('sources')

  return (
    <>
      <a
        href={sourcesUrl}
        onClick={(event) => followLink(event, sourcesUrl)}
        className="-ml-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-control px-2 text-sm text-muted hover:text-ink"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Sources and sync
      </a>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Recent activity</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">Syncs, imports, and blocked secrets across your sources.</p>
      </header>

      {status === null ? (
        !online ? (
          <EmptyCard>Activity needs a connection.</EmptyCard>
        ) : server.error !== null && !server.loading ? (
          <Alert message={statusErrorText(server.error)} onRetry={server.reload} />
        ) : (
          <EmptyCard>
            <span className="inline-flex items-center gap-2">
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
              Loading activity…
            </span>
          </EmptyCard>
        )
      ) : (
        <>
          {server.error === null || !online ? null : (
            <Alert message={statusErrorText(server.error)} onRetry={server.reload} />
          )}
          {events.length === 0 ? (
            <EmptyCard>Nothing yet. Syncs, imports and blocked secrets show here.</EmptyCard>
          ) : (
            <section aria-labelledby="all-activity-heading" className="rounded-card border border-line bg-surface p-4">
              <h2 id="all-activity-heading" className="sr-only">
                All activity
              </h2>
              <ol aria-label="Activity" className="space-y-3">
                {events.map((event) => (
                  <ActivityRow key={event.id} event={event} />
                ))}
              </ol>
            </section>
          )}
        </>
      )}
    </>
  )
}

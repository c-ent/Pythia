import { CloudCheck, CloudOff, LoaderCircle, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { STATUS_CHANGED } from '../api/status'
import { offlineDb } from '../offline/db'
import { readCacheCounts, readStorageInfo, type CacheCounts } from '../offline/storage'
import { OFFLINE_CACHE_CHANGED } from '../offline/sync'
import { offlineSummary } from '../sources/format'
import { isSyncing, startSyncNow, syncProgressText, useSyncNow } from '../sources/syncNow'

/** How often the card rereads the cache while the app stays open (the automatic sync runs every few minutes). */
export const CARD_REFRESH_MS = 60_000

type Cache = { counts: CacheCounts | null; usage: number | null }

async function readCache(): Promise<Cache> {
  const [counts, storage] = await Promise.all([
    typeof indexedDB === 'undefined' ? null : readCacheCounts(offlineDb()).catch(() => null),
    readStorageInfo().catch(() => null),
  ])
  return { counts, usage: storage?.usage ?? null }
}

/** This device's offline copy: what is cached and when it last synced; reread after Sync now. */
function useOfflineCache(): Cache | null {
  const [cache, setCache] = useState<Cache | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const reload = (): void => setVersion((n) => n + 1)
    window.addEventListener(STATUS_CHANGED, reload)
    window.addEventListener(OFFLINE_CACHE_CHANGED, reload)
    window.addEventListener('online', reload)
    const timer = window.setInterval(reload, CARD_REFRESH_MS)
    return () => {
      window.removeEventListener(STATUS_CHANGED, reload)
      window.removeEventListener(OFFLINE_CACHE_CHANGED, reload)
      window.removeEventListener('online', reload)
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    let live = true
    void readCache().then((next) => {
      if (live) setCache(next)
    })
    return () => {
      live = false
    }
  }, [version])

  return cache
}

/**
 * The sidebar "Offline ready" card (R18, R11): cached notes, pinned repos,
 * cached size and last sync for this device, and Sync now (server scan and
 * fetch, then this device's copy). Offline it says so and Sync now is disabled.
 */
export function OfflineCard({ online, pinned }: { online: boolean; pinned: number }) {
  const cache = useOfflineCache()
  const sync = useSyncNow()
  const busy = isSyncing(sync)
  const progress = syncProgressText(sync)

  const summary =
    cache === null
      ? 'Checking this device…'
      : cache.counts === null
        ? 'This browser can’t keep an offline copy.'
        : offlineSummary(cache.counts, pinned, cache.usage)

  return (
    <section
      aria-labelledby="offline-card-heading"
      className="mt-6 rounded-card bg-glow-offline bg-radial-[at_100%_0%] from-success/25 to-transparent to-70% p-4 text-nav-ink"
    >
      <h2 id="offline-card-heading" className="flex items-center gap-2 text-sm font-semibold">
        {online ? (
          <CloudCheck aria-hidden="true" className="size-4 text-accent" />
        ) : (
          <CloudOff aria-hidden="true" className="size-4" />
        )}
        {online ? 'Offline ready' : 'You’re offline'}
      </h2>
      <p className="mt-1.5 text-xs leading-relaxed">{summary}</p>
      <p aria-live="polite" className={`text-xs leading-relaxed ${progress === null ? 'sr-only' : 'mt-1.5'}`}>
        {online ? progress : 'Sync now needs a connection.'}
      </p>
      <button
        type="button"
        onClick={() => void startSyncNow()}
        disabled={!online || busy}
        className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-control bg-accent px-3 text-sm font-semibold text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50 disabled:hover:opacity-50"
      >
        {busy ? (
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
        ) : (
          <RefreshCw aria-hidden="true" className="size-4" />
        )}
        {busy ? 'Syncing…' : 'Sync now'}
      </button>
    </section>
  )
}

/** The tablet rail's form of the card (Tablet boards): one button with a status dot. */
export function OfflineRailButton({ online }: { online: boolean }) {
  const sync = useSyncNow()
  const busy = isSyncing(sync)
  const label = !online ? 'You’re offline. Sync now needs a connection' : busy ? 'Syncing…' : 'Offline ready. Sync now'
  return (
    <button
      type="button"
      onClick={() => void startSyncNow()}
      disabled={!online || busy}
      aria-label={label}
      title={label}
      className="relative mt-4 inline-flex size-11 shrink-0 items-center justify-center rounded-control bg-glow-offline text-nav-ink transition-colors hover:bg-nav-raised disabled:opacity-60"
    >
      {busy ? (
        <LoaderCircle aria-hidden="true" className="size-5 animate-spin" />
      ) : online ? (
        <RefreshCw aria-hidden="true" className="size-5" />
      ) : (
        <CloudOff aria-hidden="true" className="size-5" />
      )}
      <span
        aria-hidden="true"
        className={`absolute top-2 right-2 size-2 rounded-full ${online ? 'bg-accent' : 'bg-nav-muted'}`}
      />
    </button>
  )
}

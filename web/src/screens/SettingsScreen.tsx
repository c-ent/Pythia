import { HardDrive, LoaderCircle, LogOut, PinOff, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ScreenHeader } from '../components/Screen'
import { offlineDb } from '../offline/db'
import {
  formatBytes,
  readCacheCounts,
  readStorageInfo,
  requestPersistence,
  type CacheCounts,
  type StorageInfo,
} from '../offline/storage'
import { formatDate, plural } from '../repos/format'
import { setRepoPinned, usePinnedRepos } from '../repos/pins'
import { LlmExclusionsPanel } from './LlmExclusionsPanel'

export function SettingsScreen({ onSignOut }: { onSignOut: () => void }) {
  return (
    <>
      <ScreenHeader title="Settings" />
      <div className="space-y-4">
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface p-4">
          <div>
            <h2 className="text-base font-medium">Account</h2>
            <p className="mt-0.5 text-sm text-muted">Signing out ends this device’s session.</p>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            className="inline-flex min-h-11 items-center gap-2 rounded-control border border-line px-4 text-sm font-medium transition-colors hover:bg-raised"
          >
            <LogOut aria-hidden="true" className="size-4" />
            Sign out
          </button>
        </section>
        <LlmExclusionsPanel />
        <StoragePanel />
      </div>
    </>
  )
}

type Loaded = { status: 'loading' } | { status: 'done'; storage: StorageInfo; cache: CacheCounts | null }

function StoragePanel() {
  const pins = usePinnedRepos()
  const [state, setState] = useState<Loaded>({ status: 'loading' })
  const [persistMessage, setPersistMessage] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)

  useEffect(() => {
    let live = true
    const cache =
      typeof indexedDB === 'undefined' ? Promise.resolve(null) : readCacheCounts(offlineDb()).catch(() => null)
    void Promise.all([readStorageInfo(), cache]).then(([storage, counts]) => {
      if (live) setState({ status: 'done', storage, cache: counts })
    })
    return () => {
      live = false
    }
  }, [pins])

  const persist = (): void => {
    setAsking(true)
    setPersistMessage(null)
    void requestPersistence()
      .then((granted) => {
        setState((current) =>
          current.status === 'done' ? { ...current, storage: { ...current.storage, persisted: granted } } : current,
        )
        if (!granted) {
          setPersistMessage(
            'The browser said no. On iPhone and iPad, add Pythia to the Home Screen and open it from there.',
          )
        }
      })
      .finally(() => setAsking(false))
  }

  return (
    <section className="rounded-card border border-line bg-surface p-4" aria-labelledby="storage-heading">
      <div className="flex items-start gap-2">
        <HardDrive aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
        <div>
          <h2 id="storage-heading" className="text-base font-medium">
            Offline storage
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            Notes are kept on this device for offline search. Repo files are kept only for pinned repos.
          </p>
        </div>
      </div>

      {state.status === 'loading' ? (
        <p aria-live="polite" className="mt-4 flex items-center gap-2 text-sm text-muted">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          Checking storage…
        </p>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">Cached</dt>
            <dd>
              {state.cache === null
                ? 'Not available in this browser'
                : `${plural(state.cache.notes, 'note')} · ${plural(state.cache.repoFiles, 'repo file')}`}
            </dd>
            <dt className="text-muted">Last synced</dt>
            <dd>
              {state.cache?.syncedAt == null ? (
                'not yet'
              ) : (
                <time dateTime={state.cache.syncedAt}>{formatDate(state.cache.syncedAt)}</time>
              )}
            </dd>
            <dt className="text-muted">Storage used</dt>
            <dd className="tabular-nums">
              {state.storage.usage === null
                ? 'Unknown'
                : state.storage.quota === null
                  ? formatBytes(state.storage.usage)
                  : `${formatBytes(state.storage.usage)} of ${formatBytes(state.storage.quota)}`}
            </dd>
            <dt className="text-muted">Kept by the browser</dt>
            <dd>
              {state.storage.persisted === true
                ? 'Yes, offline data is not cleared under storage pressure'
                : state.storage.persisted === false
                  ? 'No, the browser may clear offline data when space runs low'
                  : 'Unknown'}
            </dd>
          </dl>
          {state.storage.persisted === false ? (
            <button
              type="button"
              onClick={persist}
              disabled={asking}
              className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-control border border-line px-4 text-sm font-medium transition-colors hover:bg-raised disabled:opacity-50"
            >
              <ShieldCheck aria-hidden="true" className="size-4" />
              Keep offline data
            </button>
          ) : null}
          <p aria-live="polite" className="mt-2 text-sm text-muted">
            {persistMessage}
          </p>
        </>
      )}

      <h3 className="mt-4 text-sm font-medium">Pinned repos</h3>
      {pins.length === 0 ? (
        <p className="mt-1 text-sm text-muted">None. Pin a repo on the Repos screen to search its files offline.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {pins.map((name) => (
            <li key={name} className="flex items-center justify-between gap-3">
              <span className="font-mono text-sm break-all">{name}</span>
              <button
                type="button"
                onClick={() => setRepoPinned(name, false)}
                aria-label={`Unpin ${name}`}
                className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-control px-3 text-sm text-muted transition-colors hover:bg-raised hover:text-ink"
              >
                <PinOff aria-hidden="true" className="size-4" />
                Unpin
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

import { FolderGit2, HardDrive, LoaderCircle, PinOff, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { STATUS_CHANGED } from '../api/status'
import { ScreenHeader } from '../components/Screen'
import { useOnline } from '../hooks/useOnline'
import { offlineDb } from '../offline/db'
import {
  formatBytes,
  readCacheBreakdown,
  readStorageInfo,
  requestPersistence,
  type CacheBreakdown,
  type StorageInfo,
} from '../offline/storage'
import { clearOfflineCache, OFFLINE_CACHE_CHANGED, offlineCacheChanged } from '../offline/sync'
import { formatDateTime, plural } from '../repos/format'
import { setRepoPinned, usePinnedRepos } from '../repos/pins'
import { followLink, pathFor } from '../router'
import { isSyncing, startSyncNow, syncProgressText, useSyncNow } from '../sources/syncNow'
import {
  CLEAR_DONE_MESSAGE,
  CLEAR_FAILED_MESSAGE,
  PERSIST_REFUSED_MESSAGE,
  pinnedRepoState,
  type PinnedRepoState,
} from './pinned'

const BUTTON =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-control border border-line bg-surface px-4 text-sm font-medium text-ink transition-colors hover:bg-raised disabled:opacity-50 disabled:hover:bg-surface'
const PRIMARY =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-control bg-strong px-4 text-sm font-semibold text-on-strong transition-opacity hover:opacity-90 disabled:opacity-50 disabled:hover:opacity-50'

type Device = { status: 'loading' } | { status: 'done'; storage: StorageInfo; cache: CacheBreakdown | null }

async function readDevice(): Promise<Device> {
  const [storage, cache] = await Promise.all([
    readStorageInfo(),
    typeof indexedDB === 'undefined' ? null : readCacheBreakdown(offlineDb()).catch(() => null),
  ])
  return { status: 'done', storage, cache }
}

/** This device's storage and offline copy; reread on pin changes, syncs and Clear. */
function useDevice(pins: readonly string[]): [Device, (update: (current: Device) => Device) => void, () => void] {
  const [state, setState] = useState<Device>({ status: 'loading' })
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion((n) => n + 1), [])

  useEffect(() => {
    window.addEventListener(STATUS_CHANGED, reload)
    window.addEventListener(OFFLINE_CACHE_CHANGED, reload)
    return () => {
      window.removeEventListener(STATUS_CHANGED, reload)
      window.removeEventListener(OFFLINE_CACHE_CHANGED, reload)
    }
  }, [reload])

  useEffect(() => {
    let live = true
    void readDevice().then((next) => {
      if (live) setState(next)
    })
    return () => {
      live = false
    }
  }, [pins, version])

  return [state, setState, reload]
}

/**
 * Pinned and offline (R11, ui.md): pinned repos with their cached size and
 * status, this device's offline storage and its breakdown, persistent storage,
 * Update all now (Sync now) and Clear offline cache. It replaces the old
 * Settings storage panel.
 */
export function PinnedScreen() {
  const online = useOnline()
  const pins = usePinnedRepos()
  const [device, setDevice] = useDevice(pins)
  const cache = device.status === 'done' ? device.cache : null

  return (
    <>
      <ScreenHeader
        title="Pinned"
        description="Pinned repos and every note are kept on this device, so they open and search without a connection."
      />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <PinnedRepos pins={pins} device={device} />
        <OfflineStorage online={online} device={device} cache={cache} setDevice={setDevice} />
      </div>
    </>
  )
}

function PinnedRepos({ pins, device }: { pins: readonly string[]; device: Device }) {
  const reposPath = pathFor('repos')
  const [pinError, setPinError] = useState<string | null>(null)
  const cache = device.status === 'done' ? device.cache : null

  const unpin = (name: string): void => {
    setPinError(setRepoPinned(name, false) ? null : 'This browser refused to save the change. Check its storage settings.')
  }

  return (
    <section aria-labelledby="pinned-repos-heading" className="rounded-card border border-line bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="pinned-repos-heading" className="text-base font-semibold">
          Pinned repos
        </h2>
        <a
          href={reposPath}
          onClick={(event) => followLink(event, reposPath)}
          className="text-sm text-muted transition-colors hover:text-ink hover:underline"
        >
          Pin more on Repos
        </a>
      </div>
      {pins.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          No repos pinned yet. Pin a repo on the{' '}
          <a
            href={reposPath}
            onClick={(event) => followLink(event, reposPath)}
            className="font-medium text-accent-ink underline underline-offset-4"
          >
            Repos
          </a>{' '}
          page to search its files offline.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {pins.map((name) => {
            const state = device.status === 'loading' ? null : pinnedRepoState(name, cache)
            const size = cache?.repos.get(name)
            return (
              <li key={name} className="flex items-center gap-3 py-2.5">
                <span className="grid size-9 shrink-0 place-items-center rounded-[0.625rem] bg-raised text-muted">
                  <FolderGit2 aria-hidden="true" className="size-[1.125rem]" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm break-all">{name}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {size === undefined
                      ? 'No files cached'
                      : `${plural(size.count, 'file')} · ${formatBytes(size.bytes)}`}
                  </p>
                </div>
                <RepoState state={state} />
                <button
                  type="button"
                  onClick={() => unpin(name)}
                  aria-label={`Unpin ${name}`}
                  title={`Unpin ${name}`}
                  className="inline-flex size-11 shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-raised hover:text-ink"
                >
                  <PinOff aria-hidden="true" className="size-4" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <p role={pinError === null ? undefined : 'alert'} className={pinError === null ? 'sr-only' : 'mt-2 text-sm text-danger'}>
        {pinError}
      </p>
    </section>
  )
}

function RepoState({ state }: { state: PinnedRepoState | null }) {
  if (state === null) return null
  const [label, tone] =
    state === 'cached'
      ? ['Cached', 'bg-success/15 text-success']
      : state === 'waiting'
        ? ['Waiting for sync', 'bg-warning/15 text-warning']
        : ['Not available', 'bg-raised text-muted']
  return <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${tone}`}>{label}</span>
}

function OfflineStorage({
  online,
  device,
  cache,
  setDevice,
}: {
  online: boolean
  device: Device
  cache: CacheBreakdown | null
  setDevice: (update: (current: Device) => Device) => void
}) {
  const sync = useSyncNow()
  const busy = isSyncing(sync)
  const progress = syncProgressText(sync)
  const [asking, setAsking] = useState(false)
  const [persistMessage, setPersistMessage] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearMessage, setClearMessage] = useState<{ text: string; error: boolean } | null>(null)

  const persist = (): void => {
    setAsking(true)
    setPersistMessage(null)
    void requestPersistence()
      .then((granted) => {
        setDevice((current) =>
          current.status === 'done' ? { ...current, storage: { ...current.storage, persisted: granted } } : current,
        )
        if (!granted) setPersistMessage(PERSIST_REFUSED_MESSAGE)
      })
      .finally(() => setAsking(false))
  }

  const clear = (): void => {
    setClearing(true)
    setClearMessage(null)
    clearOfflineCache(offlineDb())
      .then(
        () => setClearMessage({ text: CLEAR_DONE_MESSAGE, error: false }),
        () => setClearMessage({ text: CLEAR_FAILED_MESSAGE, error: true }),
      )
      .finally(() => {
        setClearing(false)
        setConfirming(false)
        offlineCacheChanged()
      })
  }

  const repoBytes = cache === null ? 0 : [...cache.repos.values()].reduce((sum, size) => sum + size.bytes, 0)
  const repoFiles = cache === null ? 0 : [...cache.repos.values()].reduce((sum, size) => sum + size.count, 0)
  const empty = cache === null || (cache.notes.count === 0 && repoFiles === 0)

  return (
    <section aria-labelledby="offline-storage-heading" className="rounded-card border border-line bg-surface p-4">
      <div className="flex items-start gap-2">
        <HardDrive aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
        <h2 id="offline-storage-heading" className="text-base font-semibold">
          Offline storage
        </h2>
      </div>

      {device.status === 'loading' ? (
        <p aria-live="polite" className="mt-4 flex items-center gap-2 text-sm text-muted">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          Checking storage…
        </p>
      ) : (
        <>
          <p className="mt-3 text-2xl font-semibold tabular-nums">
            {device.storage.usage === null ? 'Unknown' : `${formatBytes(device.storage.usage)} used`}
          </p>
          {device.storage.usage !== null && device.storage.quota !== null ? (
            <p className="text-sm text-muted tabular-nums">of {formatBytes(device.storage.quota)} the browser allows</p>
          ) : null}

          <dl className="mt-4 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
            {cache === null ? (
              <>
                <dt className="text-muted">Offline copy</dt>
                <dd>Not available in this browser</dd>
              </>
            ) : (
              <>
                <dt className="text-muted">Notes · {cache.notes.count.toLocaleString('en-US')}</dt>
                <dd className="tabular-nums">{formatBytes(cache.notes.bytes)}</dd>
                <dt className="text-muted">Repo files · {repoFiles.toLocaleString('en-US')}</dt>
                <dd className="tabular-nums">{formatBytes(repoBytes)}</dd>
                <dt className="text-muted">Last synced</dt>
                <dd>
                  {cache.syncedAt === null ? (
                    'Not yet'
                  ) : (
                    <time dateTime={cache.syncedAt}>{formatDateTime(cache.syncedAt)}</time>
                  )}
                </dd>
              </>
            )}
            <dt className="text-muted">Persistent storage</dt>
            <dd>
              {device.storage.persisted === true
                ? 'Granted'
                : device.storage.persisted === false
                  ? 'Not granted'
                  : 'Unknown'}
            </dd>
          </dl>
          <p className="mt-2 text-xs text-muted">
            {device.storage.persisted === false
              ? 'The browser may clear offline data when space runs low.'
              : device.storage.persisted === true
                ? 'Offline data is not cleared under storage pressure.'
                : null}{' '}
            Only text is cached. Images and attachments stay on the server.
          </p>
          {device.storage.persisted === false ? (
            <button type="button" onClick={persist} disabled={asking} className={`${BUTTON} mt-3 w-full`}>
              <ShieldCheck aria-hidden="true" className="size-4" />
              Keep offline data
            </button>
          ) : null}
          <p aria-live="polite" className={persistMessage === null ? 'sr-only' : 'mt-2 text-sm text-muted'}>
            {persistMessage}
          </p>
        </>
      )}

      <div className="mt-4 space-y-2 border-t border-line pt-4">
        <button
          type="button"
          onClick={() => void startSyncNow()}
          disabled={!online || busy}
          className={`${PRIMARY} w-full`}
        >
          {busy ? (
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <RefreshCw aria-hidden="true" className="size-4" />
          )}
          {busy ? 'Updating…' : 'Update all now'}
        </button>
        <p aria-live="polite" className={`text-sm text-muted ${online && progress === null ? 'sr-only' : ''}`}>
          {online ? progress : 'Updating needs a connection.'}
        </p>

        {confirming ? (
          <div role="group" aria-labelledby="clear-confirm" className="rounded-control border border-danger/40 p-3">
            <p id="clear-confirm" className="text-sm">
              Remove every note and repo file kept on this device?
              {online ? '' : ' You’re offline, so offline search will find nothing until the next sync.'} Pins are kept.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={clear}
                disabled={clearing}
                className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-control bg-danger px-4 text-sm font-semibold text-on-strong transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {clearing ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}
                Clear
              </button>
              <button type="button" onClick={() => setConfirming(false)} disabled={clearing} className={`${BUTTON} flex-1`}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setClearMessage(null)
              setConfirming(true)
            }}
            disabled={device.status === 'loading' || cache === null || (empty && cache.syncedAt === null)}
            className={`${BUTTON} w-full text-danger`}
          >
            <Trash2 aria-hidden="true" className="size-4" />
            Clear offline cache
          </button>
        )}
        <p
          role={clearMessage?.error === true ? 'alert' : undefined}
          aria-live="polite"
          className={clearMessage === null ? 'sr-only' : `text-sm ${clearMessage.error ? 'text-danger' : 'text-muted'}`}
        >
          {clearMessage?.text}
        </p>
      </div>
    </section>
  )
}

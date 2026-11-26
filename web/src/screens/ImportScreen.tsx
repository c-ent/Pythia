import { CheckCircle2, Database, LoaderCircle, RefreshCw, RotateCw, TriangleAlert, Upload } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { getIndexStatus, importKeepZip, startReindex, type IndexStatus, type KeepImportResult } from '../api/imports'
import { ScreenHeader } from '../components/Screen'
import { useOnline } from '../hooks/useOnline'
import { formatDate, plural } from '../repos/format'
import { importErrorMessage, importSummary, statusErrorMessage } from './importMessages'

/** How often the status refreshes while a re-index is running. */
export const REINDEX_POLL_MS = 3000

const KIND_LABELS: Record<string, string> = { obsidian: 'Obsidian', repo: 'Repo', keep: 'Keep', chat: 'Chat' }

type UploadState =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'done'; result: KeepImportResult }
  | { status: 'error'; message: string }

type StatusState = { status: 'loading' } | { status: 'done'; index: IndexStatus } | { status: 'error'; message: string }

export function ImportScreen() {
  const online = useOnline()
  const [status, setStatus] = useState<StatusState>({ status: 'loading' })
  const [reindexError, setReindexError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!online) return
    const controller = new AbortController()
    getIndexStatus(controller.signal)
      .then((index) => {
        if (!controller.signal.aborted) setStatus({ status: 'done', index })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setStatus({ status: 'error', message: statusErrorMessage(error) })
      })
    return () => controller.abort()
  }, [online, attempt])

  const refresh = useCallback(() => setAttempt((n) => n + 1), [])

  // Poll while a re-index runs, so the counts and the button catch up on their own.
  const running =
    status.status === 'done' && (status.index.reindex.vault === 'running' || status.index.reindex.repos === 'running')
  useEffect(() => {
    if (!running || !online) return
    const timer = window.setTimeout(refresh, REINDEX_POLL_MS)
    return () => window.clearTimeout(timer)
  }, [running, online, refresh, status])

  const reindex = (): void => {
    setReindexError(null)
    startReindex()
      .then((reindexState) => {
        setStatus((current) =>
          current.status === 'done' ? { status: 'done', index: { ...current.index, reindex: reindexState } } : current,
        )
      })
      .catch((error: unknown) => setReindexError(importErrorMessage(error)))
  }

  return (
    <>
      <ScreenHeader title="Import" description="Google Keep exports and index status." />
      <div className="space-y-4">
        <KeepUpload online={online} onImported={refresh} />
        <section className="rounded-card border border-line bg-surface p-4" aria-labelledby="index-status-heading">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="index-status-heading" className="text-base font-medium">
                Index status
              </h2>
              <p className="mt-0.5 text-sm text-muted">Documents and chunks per source.</p>
            </div>
            <ReindexButton status={status} online={online} onClick={reindex} />
          </div>
          {reindexError === null ? null : <Alert message={reindexError} />}
          <div className="mt-4">
            {online ? (
              <StatusTable state={status} onRetry={refresh} />
            ) : (
              <p className="text-sm text-muted">You’re offline. Index status needs a connection.</p>
            )}
          </div>
        </section>
      </div>
    </>
  )
}

function KeepUpload({ online, onImported }: { online: boolean; onImported: () => void }) {
  const inputId = useId()
  const hintId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [upload, setUpload] = useState<UploadState>({ status: 'idle' })

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (file === null || upload.status === 'uploading') return
    setUpload({ status: 'uploading' })
    importKeepZip(file)
      .then((result) => {
        setUpload({ status: 'done', result })
        setFile(null)
        if (input.current !== null) input.current.value = ''
        onImported()
      })
      .catch((error: unknown) => setUpload({ status: 'error', message: importErrorMessage(error) }))
  }

  const busy = upload.status === 'uploading'

  return (
    <section className="rounded-card border border-line bg-surface p-4" aria-labelledby={`${inputId}-heading`}>
      <h2 id={`${inputId}-heading`} className="text-base font-medium">
        Google Keep
      </h2>
      <p id={hintId} className="mt-0.5 text-sm text-muted">
        Upload the <span className="font-mono">.zip</span> from Google Takeout. Each upload replaces all Keep notes.
        Like Obsidian notes, Keep notes can be used by Gemini to answer questions.
      </p>
      <form onSubmit={submit} className="mt-4 flex flex-wrap items-center gap-3">
        <label htmlFor={inputId} className="sr-only">
          Keep Takeout zip
        </label>
        <input
          ref={input}
          id={inputId}
          type="file"
          accept=".zip,application/zip"
          aria-describedby={hintId}
          disabled={busy}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null)
            setUpload({ status: 'idle' })
          }}
          className="min-h-11 max-w-full flex-1 text-sm text-muted file:mr-3 file:min-h-11 file:rounded-control file:border file:border-line file:bg-raised file:px-4 file:text-sm file:font-medium file:text-ink"
        />
        <button
          type="submit"
          disabled={file === null || busy || !online}
          className="inline-flex min-h-11 items-center gap-2 rounded-control bg-accent px-4 text-sm font-medium text-canvas transition-opacity disabled:opacity-50"
        >
          {busy ? (
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <Upload aria-hidden="true" className="size-4" />
          )}
          {busy ? 'Importing…' : 'Import'}
        </button>
      </form>
      {!online ? <p className="mt-3 text-sm text-muted">You’re offline. Importing needs a connection.</p> : null}
      <div aria-live="polite">
        {upload.status === 'done' ? (
          <p className="mt-3 flex items-start gap-2 text-sm text-ink">
            <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
            <span>
              {importSummary(upload.result)}
              {upload.result.failed > 0
                ? ` ${plural(upload.result.failed, 'note')} could not be indexed and will be retried on the next import.`
                : ''}
            </span>
          </p>
        ) : null}
        {upload.status === 'uploading' ? (
          <p className="mt-3 text-sm text-muted">Reading and indexing notes. Large exports take a few minutes.</p>
        ) : null}
      </div>
      {upload.status === 'error' ? <Alert message={upload.message} /> : null}
    </section>
  )
}

function ReindexButton({ status, online, onClick }: { status: StatusState; online: boolean; onClick: () => void }) {
  const reindex = status.status === 'done' ? status.index.reindex : null
  const available = reindex !== null && (reindex.vault !== 'off' || reindex.repos !== 'off')
  const running = reindex !== null && (reindex.vault === 'running' || reindex.repos === 'running')
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!online || !available || running}
      title={available ? 'Rescan the vault and fetch repos now' : 'No vault or repos are configured on the server'}
      className="inline-flex min-h-11 items-center gap-2 rounded-control border border-line px-4 text-sm font-medium transition-colors hover:bg-raised disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <RefreshCw aria-hidden="true" className={`size-4 ${running ? 'animate-spin' : ''}`} />
      {running ? 'Re-indexing…' : 'Re-index'}
    </button>
  )
}

function StatusTable({ state, onRetry }: { state: StatusState; onRetry: () => void }) {
  if (state.status === 'loading') {
    return (
      <p aria-live="polite" className="flex items-center gap-2 text-sm text-muted">
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
        Loading index status…
      </p>
    )
  }
  if (state.status === 'error') return <Alert message={state.message} onRetry={onRetry} />
  const { sources } = state.index
  if (sources.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Database aria-hidden="true" className="size-4" />
        Nothing indexed yet.
      </p>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-muted">
          <tr>
            <th scope="col" className="py-2 pr-3 font-medium">
              Source
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              Documents
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              Chunks
            </th>
            <th scope="col" className="py-2 font-medium">
              Last updated
            </th>
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => (
            <tr key={`${source.kind}:${source.name}`} className="border-t border-line">
              <th scope="row" className="py-2 pr-3 font-normal">
                <span className="text-muted">{KIND_LABELS[source.kind] ?? source.kind}</span>{' '}
                <span className="font-mono break-all">{source.name}</span>
                {source.enabled ? null : <span className="ml-1 text-xs text-muted">(off)</span>}
              </th>
              <td className="py-2 pr-3 text-right tabular-nums">{source.documents.toLocaleString('en-US')}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{source.chunks.toLocaleString('en-US')}</td>
              <td className="py-2 text-muted">
                {source.updatedAt === null ? 'never' : <time dateTime={source.updatedAt}>{formatDate(source.updatedAt)}</time>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Alert({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="mt-3 flex items-start gap-2 rounded-card border border-danger/40 bg-surface px-4 py-3 text-sm text-danger"
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span className="flex-1">{message}</span>
      {onRetry === undefined ? null : (
        <button
          type="button"
          onClick={onRetry}
          className="-my-2 inline-flex min-h-11 items-center gap-1.5 rounded-control px-3 text-ink hover:bg-raised"
        >
          <RotateCw aria-hidden="true" className="size-4" />
          Retry
        </button>
      )}
    </div>
  )
}

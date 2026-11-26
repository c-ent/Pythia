import { EyeOff, FileText, Folder, LoaderCircle, Plus, RotateCw, Trash2, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import { getLlmExclusions, saveLlmExclusions, type LlmExclusion, type LlmExclusionKind } from '../api/settings'
import { useOnline } from '../hooks/useOnline'
import { checkExclusionPath, exclusionErrorMessage } from './exclusionPaths'

type ListState = { status: 'loading' } | { status: 'done'; list: LlmExclusion[] } | { status: 'error'; message: string }

export function LlmExclusionsPanel() {
  const online = useOnline()
  const headingId = useId()
  const [state, setState] = useState<ListState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (!online) return
    const controller = new AbortController()
    getLlmExclusions(controller.signal)
      .then((list) => {
        if (!controller.signal.aborted) setState({ status: 'done', list })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: exclusionErrorMessage(error, 'load') })
      })
    return () => controller.abort()
  }, [online, attempt])

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    setAttempt((n) => n + 1)
  }, [])

  /** Saves the whole list; on failure the shown list stays as it was. Resolves true when saved. */
  const save = async (next: LlmExclusion[]): Promise<boolean> => {
    setSaving(true)
    setSaveError(null)
    try {
      const list = await saveLlmExclusions(next)
      setState({ status: 'done', list })
      return true
    } catch (error) {
      setSaveError(exclusionErrorMessage(error, 'save'))
      return false
    } finally {
      setSaving(false)
    }
  }

  const list = state.status === 'done' ? state.list : []

  return (
    <section className="rounded-card border border-line bg-surface p-4" aria-labelledby={headingId}>
      <div className="flex items-start gap-2">
        <EyeOff aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
        <div>
          <h2 id={headingId} className="text-base font-medium">
            Kept away from Gemini
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            Notes in these folders, and these single notes, stay searchable but are never sent to Gemini. Notes with{' '}
            <span className="font-mono">llm: false</span> in their frontmatter are always kept away.
          </p>
        </div>
      </div>

      {!online ? (
        <p className="mt-4 text-sm text-muted">You’re offline. This list needs a connection.</p>
      ) : state.status === 'loading' ? (
        <p aria-live="polite" className="mt-4 flex items-center gap-2 text-sm text-muted">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          Loading the list…
        </p>
      ) : state.status === 'error' ? (
        <Alert message={state.message} onRetry={retry} />
      ) : (
        <>
          {list.length === 0 ? (
            <p className="mt-4 text-sm text-muted">Nothing is kept away. Gemini may read every note.</p>
          ) : (
            <ul className="mt-4 space-y-1" aria-label="Kept away from Gemini">
              {list.map((item) => (
                <li key={`${item.kind}:${item.path}`} className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    {item.kind === 'folder' ? (
                      <Folder aria-hidden="true" className="size-4 shrink-0 text-muted" />
                    ) : (
                      <FileText aria-hidden="true" className="size-4 shrink-0 text-muted" />
                    )}
                    <span className="sr-only">{item.kind === 'folder' ? 'Folder' : 'Note'}</span>
                    <span className="font-mono text-sm break-all">
                      {item.path}
                      {item.kind === 'folder' ? '/' : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void save(list.filter((other) => other !== item))}
                    aria-label={`Remove ${item.path}`}
                    className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-control px-3 text-sm text-muted transition-colors hover:bg-raised hover:text-ink disabled:opacity-50"
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <AddForm list={list} saving={saving} onAdd={(item) => save([...list, item])} />
          {saveError === null ? null : <Alert message={saveError} />}
          <p className="mt-3 text-sm text-muted">
            A change applies without re-indexing. Removed items may take a moment to become readable again.
          </p>
        </>
      )}
    </section>
  )
}

function AddForm({
  list,
  saving,
  onAdd,
}: {
  list: readonly LlmExclusion[]
  saving: boolean
  onAdd: (item: LlmExclusion) => Promise<boolean>
}) {
  const kindId = useId()
  const pathId = useId()
  const errorId = useId()
  const [kind, setKind] = useState<LlmExclusionKind>('folder')
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (saving) return
    const checked = checkExclusionPath(kind, path, list)
    if ('error' in checked) {
      setError(checked.error)
      return
    }
    setError(null)
    void onAdd({ kind, path: checked.path }).then((saved) => {
      if (saved) setPath('')
    })
  }

  return (
    <form onSubmit={submit} className="mt-4 flex flex-wrap items-end gap-3" noValidate>
      <div className="flex flex-col gap-1">
        <label htmlFor={kindId} className="text-sm text-muted">
          Type
        </label>
        <select
          id={kindId}
          value={kind}
          disabled={saving}
          onChange={(event) => {
            setKind(event.target.value as LlmExclusionKind)
            setError(null)
          }}
          className="min-h-11 rounded-control border border-line bg-canvas px-3 text-base text-ink"
        >
          <option value="folder">Folder</option>
          <option value="note">Single note</option>
        </select>
      </div>
      <div className="flex min-w-48 flex-1 flex-col gap-1">
        <label htmlFor={pathId} className="text-sm text-muted">
          Path in the vault
        </label>
        <input
          id={pathId}
          type="text"
          value={path}
          disabled={saving}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={kind === 'folder' ? 'Private' : 'Journal/2026-11-26.md'}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : errorId}
          onChange={(event) => {
            setPath(event.target.value)
            setError(null)
          }}
          className="min-h-11 rounded-control border border-line bg-canvas px-3 font-mono text-base text-ink placeholder:text-muted"
        />
      </div>
      <button
        type="submit"
        disabled={saving}
        className="inline-flex min-h-11 items-center gap-2 rounded-control bg-accent px-4 text-sm font-medium text-on-accent transition-opacity disabled:opacity-50"
      >
        {saving ? (
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
        ) : (
          <Plus aria-hidden="true" className="size-4" />
        )}
        {saving ? 'Saving…' : 'Add'}
      </button>
      {error === null ? null : (
        <p id={errorId} role="alert" className="w-full text-sm text-danger">
          {error}
        </p>
      )}
    </form>
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

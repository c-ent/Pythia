import {
  CircleCheck,
  Cloud,
  Hash,
  FileText,
  Folder,
  FolderGit2,
  KeyRound,
  LoaderCircle,
  Lock,
  LockOpen,
  Plus,
  RotateCw,
  StickyNote,
  Trash2,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import {
  geminiChanged,
  getGeminiStatus,
  removeGeminiKey,
  saveGeminiKey,
  testGeminiKey,
  type GeminiStatus,
} from '../../api/gemini'
import { listRepos, type RepoInfo } from '../../api/repos'
import {
  getLlmExclusions,
  saveLlmExclusions,
  type CountedLlmExclusion,
  type LlmExclusion,
  type LlmExclusionKind,
} from '../../api/settings'
import { useOnline } from '../../hooks/useOnline'
import { plural } from '../../repos/format'
import { checkExclusionPath, exclusionErrorMessage } from '../exclusionPaths'
import {
  buildRuleRows,
  checkKey,
  countText,
  isRemovable,
  KIND_LABELS,
  keyErrorMessage,
  keyStatusText,
  keyWarningText,
  ruleLabel,
  sameRule,
  testResultText,
  type RuleRow,
} from './gemini'

const CARD = 'rounded-card border border-line bg-surface p-4 sm:p-5'
const BUTTON =
  'inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-control border border-line px-4 text-sm font-medium transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50'
const STRONG_BUTTON =
  'inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-control bg-strong px-4 text-sm font-semibold text-on-strong transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50'
const FIELD =
  'block min-h-11 w-full min-w-0 flex-1 rounded-control border border-line bg-canvas px-3 text-base text-ink placeholder:text-muted disabled:opacity-50'

const KIND_ICONS: Record<LlmExclusionKind, LucideIcon> = {
  folder: Folder,
  note: FileText,
  tag: Hash,
  repo: FolderGit2,
  keep: StickyNote,
  gdrive: Cloud,
}

/** Settings › Gemini access (R16): the API key, today's usage, and what Ask may send to Gemini. */
export function GeminiSection() {
  const online = useOnline()
  return (
    <>
      <header>
        <h2 className="text-lg font-semibold">Gemini access</h2>
        <p className="mt-0.5 text-sm text-muted">What Ask may send to Gemini. Search never sends anything.</p>
      </header>
      {online ? null : (
        <p className="flex items-center gap-2 rounded-card border border-warning/40 bg-surface px-4 py-3 text-sm text-warning">
          <WifiOff aria-hidden="true" className="size-4 shrink-0" />
          You’re offline. Gemini access needs a connection.
        </p>
      )}
      <ApiKeyCard online={online} />
      <RulesCard online={online} />
    </>
  )
}

type StatusState = { status: 'loading' } | { status: 'ready'; gemini: GeminiStatus } | { status: 'error'; message: string }

type Notice = { tone: 'success' | 'danger'; text: string } | null

function ApiKeyCard({ online }: { online: boolean }) {
  const keyId = useId()
  const noteId = useId()
  const [state, setState] = useState<StatusState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null)
  const [notice, setNotice] = useState<Notice>(null)

  useEffect(() => {
    if (!online) return
    const controller = new AbortController()
    getGeminiStatus(controller.signal).then(
      (gemini) => {
        if (!controller.signal.aborted) setState({ status: 'ready', gemini })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: keyErrorMessage(error, 'load the key status') })
      },
    )
    return () => controller.abort()
  }, [online, attempt])

  const updated = (gemini: GeminiStatus): void => {
    setState({ status: 'ready', gemini })
    geminiChanged()
  }

  const save = (event: FormEvent): void => {
    event.preventDefault()
    if (busy !== null) return
    const checked = checkKey(typed)
    if ('error' in checked) {
      setNotice({ tone: 'danger', text: checked.error })
      return
    }
    setBusy('save')
    setNotice(null)
    saveGeminiKey(checked.key)
      .then(
        (gemini) => {
          // The key leaves the page once the server has it.
          setTyped('')
          updated(gemini)
          setNotice({ tone: 'success', text: 'Saved. Test checks that Gemini accepts it.' })
        },
        (error: unknown) => setNotice({ tone: 'danger', text: keyErrorMessage(error, 'save the key') }),
      )
      .finally(() => setBusy(null))
  }

  const test = (): void => {
    setBusy('test')
    setNotice(null)
    testGeminiKey()
      .then(
        (result) => {
          setNotice({ tone: result.ok ? 'success' : 'danger', text: testResultText(result) })
          // The test call counts as a request.
          setAttempt((n) => n + 1)
        },
        (error: unknown) => setNotice({ tone: 'danger', text: keyErrorMessage(error, 'test the key') }),
      )
      .finally(() => setBusy(null))
  }

  const remove = (): void => {
    setBusy('remove')
    setNotice(null)
    removeGeminiKey()
      .then(
        (gemini) => {
          updated(gemini)
          setNotice({ tone: 'success', text: 'The saved key was removed.' })
        },
        (error: unknown) => setNotice({ tone: 'danger', text: keyErrorMessage(error, 'remove the key') }),
      )
      .finally(() => setBusy(null))
  }

  const gemini = state.status === 'ready' ? state.gemini : null
  const warning = gemini === null ? null : keyWarningText(gemini)
  const canSave = gemini?.canSave === true
  const hasSaved = gemini !== null && (gemini.source === 'settings' || gemini.savedAt !== null)

  return (
    <section className={`space-y-3 ${CARD}`} aria-labelledby="gemini-key-heading">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound aria-hidden="true" className="size-4 text-muted" />
        <h3 id="gemini-key-heading" className="flex-1 text-base font-semibold">
          API key
        </h3>
        {gemini === null ? null : gemini.configured ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-raised px-3 py-1 text-sm text-success">
            <CircleCheck aria-hidden="true" className="size-4" />
            Connected
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-raised px-3 py-1 text-sm text-muted">Not set</span>
        )}
      </div>

      {!online && state.status === 'loading' ? (
        <p className="text-sm text-muted">The key status needs a connection.</p>
      ) : state.status === 'loading' ? (
        <p aria-live="polite" className="flex items-center gap-2 text-sm text-muted">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          Checking the key…
        </p>
      ) : state.status === 'error' ? (
        <Alert
          message={state.message}
          onRetry={() => {
            setState({ status: 'loading' })
            setAttempt((n) => n + 1)
          }}
        />
      ) : (
        <>
          <p className="text-sm">
            {keyStatusText(state.gemini)}
            {state.gemini.configured && state.gemini.model !== '' ? (
              <span className="text-muted"> Model: {state.gemini.model}.</span>
            ) : null}
          </p>
          {state.gemini.envOverridesSaved ? (
            <p className="text-sm text-muted">
              A key is also saved here, but GEMINI_API_KEY in .env wins. Remove it from .env to use the saved key.
            </p>
          ) : null}
          {warning === null ? null : (
            <p role="alert" className="flex items-start gap-2 text-sm text-warning">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {warning}
            </p>
          )}

          <form onSubmit={save} noValidate>
            <label htmlFor={keyId} className="text-sm font-medium">
              {state.gemini.configured ? 'Replace with a new key' : 'Gemini API key'}
            </label>
            <div className="mt-1.5 flex flex-wrap gap-2 sm:flex-nowrap">
              <input
                id={keyId}
                type="password"
                value={typed}
                disabled={!online || !canSave || busy !== null}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder={
                  state.gemini.last4 === null ? 'Paste the key from Google AI Studio' : `${'•'.repeat(12)}${state.gemini.last4}`
                }
                aria-describedby={noteId}
                onChange={(event) => {
                  setTyped(event.target.value)
                  setNotice(null)
                }}
                className={`${FIELD} font-mono`}
              />
              <button
                type="button"
                onClick={test}
                disabled={!online || !state.gemini.configured || busy !== null}
                className={BUTTON}
              >
                {busy === 'test' ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}
                Test
              </button>
              <button type="submit" disabled={!online || !canSave || busy !== null} className={STRONG_BUTTON}>
                {busy === 'save' ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}
                Save
              </button>
              {hasSaved ? (
                <button type="button" onClick={remove} disabled={!online || busy !== null} className={BUTTON}>
                  {busy === 'remove' ? (
                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                  ) : (
                    <Trash2 aria-hidden="true" className="size-4" />
                  )}
                  Remove
                </button>
              ) : null}
            </div>
            <p id={noteId} className="mt-1.5 text-sm text-muted">
              {canSave
                ? 'The key is stored encrypted on the server. Only its last 4 characters are ever shown.'
                : 'Saving a key here needs PYTHIA_SECRETS_KEY in .env (printed by pnpm --filter server auth-env). Set it and restart the server, or put the key in GEMINI_API_KEY.'}
            </p>
          </form>
          <p role="status" className={notice === null ? 'sr-only' : `text-sm ${notice.tone === 'success' ? 'text-success' : 'text-danger'}`}>
            {notice?.text ?? ''}
          </p>
        </>
      )}

      <p className="flex items-start gap-2 rounded-control bg-raised px-3.5 py-3 text-sm text-ink">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
        On the free tier, Google may use what Ask sends to Gemini, and its answers, to improve its products. That is why the
        list below exists: lock anything private.
      </p>
      {gemini === null ? null : (
        <p className="text-sm text-muted tabular-nums">Used today: {plural(gemini.usedToday, 'request')}</p>
      )}
    </section>
  )
}

type ListState =
  | { status: 'loading' }
  | { status: 'done'; list: CountedLlmExclusion[] }
  | { status: 'error'; message: string }

function RulesCard({ online }: { online: boolean }) {
  const [state, setState] = useState<ListState>({ status: 'loading' })
  // Repos are listed so each can be locked; null when repo indexing is off or the list failed.
  const [repos, setRepos] = useState<RepoInfo[] | null>(null)
  // Rules unlocked on this visit stay as Allowed rows, so a slip can be undone.
  const [released, setReleased] = useState<CountedLlmExclusion[]>([])
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
    listRepos(controller.signal).then(
      (list) => {
        if (!controller.signal.aborted) setRepos(list)
      },
      () => {},
    )
    return () => controller.abort()
  }, [online, attempt])

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    setAttempt((n) => n + 1)
  }, [])

  const list = state.status === 'done' ? state.list : []

  /** Saves the whole list; on failure the shown list stays as it was. Resolves true when saved. */
  const save = async (next: LlmExclusion[]): Promise<boolean> => {
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await saveLlmExclusions(next)
      // Remember the counts of rules that just came off the list.
      const gone = list.filter((rule) => !saved.some((other) => sameRule(rule, other)))
      setReleased((prev) => [...prev.filter((rule) => !saved.some((other) => sameRule(rule, other))), ...gone])
      setState({ status: 'done', list: saved })
      return true
    } catch (error) {
      setSaveError(exclusionErrorMessage(error, 'save'))
      return false
    } finally {
      setSaving(false)
    }
  }

  const setLocked = (row: RuleRow, locked: boolean): void => {
    if (locked === row.locked) return
    void save(locked ? [...list, { kind: row.kind, path: row.path }] : list.filter((rule) => !sameRule(rule, row)))
  }

  const remove = (row: RuleRow): void => {
    void save(list.filter((rule) => !sameRule(rule, row))).then((saved) => {
      if (saved) setReleased((prev) => prev.filter((rule) => !sameRule(rule, row)))
    })
  }

  const rows = buildRuleRows(list, released, repos)

  return (
    <section className={CARD} aria-labelledby="gemini-rules-heading">
      <div className="flex items-start gap-2">
        <Lock aria-hidden="true" className="mt-1 size-4 shrink-0 text-muted" />
        <div>
          <h3 id="gemini-rules-heading" className="text-base font-semibold">
            Kept away from Gemini
          </h3>
          <p className="mt-0.5 text-sm text-muted">
            Locked folders, notes, tags, repos and Google Keep stay searchable but are never sent to Gemini. Notes with{' '}
            <span className="font-mono">llm: false</span> in their frontmatter are always kept away. Anything no rule
            covers is allowed.
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
            <p className="mt-4 text-sm text-muted">Nothing is locked. Gemini may read every note.</p>
          ) : null}
          <ul className="mt-3" aria-label="Rules">
            {rows.map((row) => (
              <RuleItem
                key={`${row.kind}:${row.path}`}
                row={row}
                saving={saving}
                onLocked={(locked) => setLocked(row, locked)}
                onRemove={() => remove(row)}
              />
            ))}
          </ul>
          <AddForm list={list} saving={saving} onAdd={(item) => save([...list, item])} />
          {saveError === null ? null : <Alert message={saveError} />}
          <p className="mt-3 text-sm text-muted">
            A change applies without re-indexing. Unlocked notes may take a moment to become readable again.
          </p>
        </>
      )}
    </section>
  )
}

function RuleItem({
  row,
  saving,
  onLocked,
  onRemove,
}: {
  row: RuleRow
  saving: boolean
  onLocked: (locked: boolean) => void
  onRemove: () => void
}) {
  const Icon = KIND_ICONS[row.kind]
  const label = ruleLabel(row)
  const count = countText(row)
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line py-2.5 first:border-t-0">
      <span className="flex min-w-0 flex-1 basis-48 items-center gap-2">
        <Icon aria-hidden="true" className="size-4 shrink-0 text-muted" />
        <span className="sr-only">{KIND_LABELS[row.kind]}</span>
        <span className={`text-sm break-all ${row.kind === 'keep' ? '' : 'font-mono'}`}>{label}</span>
      </span>
      {count === null ? null : <span className="text-sm text-muted tabular-nums">{count}</span>}
      <div
        role="radiogroup"
        aria-label={`Gemini access for ${label}`}
        className="flex rounded-control bg-raised p-0.5"
      >
        <AccessButton checked={!row.locked} disabled={saving} onClick={() => onLocked(false)} icon={LockOpen}>
          Allowed
        </AccessButton>
        <AccessButton checked={row.locked} disabled={saving} onClick={() => onLocked(true)} icon={Lock}>
          Locked
        </AccessButton>
      </div>
      {isRemovable(row) ? (
        <button
          type="button"
          disabled={saving}
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-raised hover:text-ink disabled:opacity-50"
        >
          <Trash2 aria-hidden="true" className="size-4" />
        </button>
      ) : (
        <span aria-hidden="true" className="hidden min-w-11 sm:inline-block" />
      )}
    </li>
  )
}

function AccessButton({
  checked,
  disabled,
  onClick,
  icon: Icon,
  children,
}: {
  checked: boolean
  disabled: boolean
  onClick: () => void
  icon: LucideIcon
  children: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex min-h-10 items-center gap-1.5 rounded-[0.625rem] px-3 text-sm text-muted transition-colors hover:text-ink disabled:cursor-not-allowed aria-checked:bg-strong aria-checked:font-medium aria-checked:text-on-strong"
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {children}
    </button>
  )
}

const ADD_KINDS: { kind: Exclude<LlmExclusionKind, 'keep'>; label: string; field: string; placeholder: string }[] = [
  { kind: 'folder', label: 'Folder', field: 'Path in the vault', placeholder: 'Private' },
  { kind: 'note', label: 'Single note', field: 'Path in the vault', placeholder: 'Journal/2026-11-26.md' },
  { kind: 'tag', label: 'Tag', field: 'Tag', placeholder: 'private' },
  { kind: 'repo', label: 'Repo', field: 'Repo name', placeholder: 'my-repo' },
  { kind: 'gdrive', label: 'Drive folder', field: 'Folder in My Drive', placeholder: 'Clients/Acme' },
]

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
  const [kind, setKind] = useState<Exclude<LlmExclusionKind, 'keep'>>('folder')
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const current = ADD_KINDS.find((item) => item.kind === kind) ?? ADD_KINDS[0]!

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
    <form onSubmit={submit} className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4" noValidate>
      <div className="flex flex-col gap-1">
        <label htmlFor={kindId} className="text-sm text-muted">
          Lock a
        </label>
        <select
          id={kindId}
          value={kind}
          disabled={saving}
          onChange={(event) => {
            setKind(event.target.value as Exclude<LlmExclusionKind, 'keep'>)
            setError(null)
          }}
          className="min-h-11 rounded-control border border-line bg-canvas px-3 text-base text-ink"
        >
          {ADD_KINDS.map((item) => (
            <option key={item.kind} value={item.kind}>
              {item.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex min-w-48 flex-1 flex-col gap-1">
        <label htmlFor={pathId} className="text-sm text-muted">
          {current.field}
        </label>
        <input
          id={pathId}
          type="text"
          value={path}
          disabled={saving}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={current.placeholder}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : errorId}
          onChange={(event) => {
            setPath(event.target.value)
            setError(null)
          }}
          className={`${FIELD} font-mono`}
        />
      </div>
      <button
        type="submit"
        disabled={saving}
        className="inline-flex min-h-11 items-center gap-2 rounded-control bg-accent px-4 text-sm font-medium text-on-accent transition-opacity disabled:opacity-50"
      >
        {saving ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <Plus aria-hidden="true" className="size-4" />}
        {saving ? 'Saving…' : 'Add rule'}
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

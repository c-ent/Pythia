import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Cloud,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderGit2,
  Hash,
  KeyRound,
  LoaderCircle,
  Lock,
  LockOpen,
  Plus,
  RotateCw,
  Search,
  StickyNote,
  Trash2,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
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
  EMPTY_EXCLUSION_CATALOG,
  getLlmExclusionCatalog,
  getLlmExclusions,
  saveLlmExclusions,
  type CountedLlmExclusion,
  type LlmExclusion,
  type LlmExclusionCatalog,
  type LlmExclusionKind,
} from '../../api/settings'
import { useOnline } from '../../hooks/useOnline'
import { plural } from '../../repos/format'
import { checkExclusionPath, DRIVE_ROOT_RULE_PATH, exclusionErrorMessage, KEEP_RULE_PATH } from '../exclusionPaths'
import {
  buildDriveView,
  buildKeepRow,
  buildObsidianView,
  buildRepoRows,
  checkKey,
  keyErrorMessage,
  keyStatusText,
  keyWarningText,
  sameRule,
  testResultText,
} from './gemini'

const CARD = 'rounded-card border border-line bg-surface p-4 sm:p-5'
const BUTTON =
  'inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-control border border-line px-4 text-sm font-medium transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50'
const STRONG_BUTTON =
  'inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-control bg-strong px-4 text-sm font-semibold text-on-strong transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50'
const FIELD =
  'block min-h-11 w-full min-w-0 flex-1 rounded-control border border-line bg-canvas px-3 text-base text-ink placeholder:text-muted disabled:opacity-50'

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
  const [catalog, setCatalog] = useState<LlmExclusionCatalog>(EMPTY_EXCLUSION_CATALOG)
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
    getLlmExclusionCatalog(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setCatalog(data)
      },
      () => {},
    )
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

  const toggleRule = (kind: LlmExclusionKind, path: string, locked: boolean): void => {
    const target: LlmExclusion = { kind, path }
    const exists = list.some((rule) => sameRule(rule, target))
    if (locked === exists) return
    void save(locked ? [...list, target] : list.filter((rule) => !sameRule(rule, target)))
  }

  const removeRule = (kind: LlmExclusionKind, path: string): void => {
    const target: LlmExclusion = { kind, path }
    void save(list.filter((rule) => !sameRule(rule, target))).then((saved) => {
      if (saved) setReleased((prev) => prev.filter((rule) => !sameRule(rule, target)))
    })
  }

  const obsidian = buildObsidianView(catalog.obsidian, list, released)
  const repoRows = buildRepoRows(repos, list, released)
  const drive = buildDriveView(catalog.gdrive, list, released)
  const keep = buildKeepRow(catalog.keep, list)

  return (
    <section className={CARD} aria-labelledby="gemini-rules-heading">
      <div className="flex items-start gap-2">
        <Lock aria-hidden="true" className="mt-1 size-4 shrink-0 text-muted" />
        <div>
          <h3 id="gemini-rules-heading" className="text-base font-semibold">
            Kept away from Gemini
          </h3>
          <p className="mt-0.5 text-sm text-muted">
            Locked folders, notes, tags, repos, Google Drive and Google Keep stay searchable but are never sent to Gemini.
            Notes with <span className="font-mono">llm: false</span> in their frontmatter are always kept away. Anything no
            rule covers is allowed.
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

          <div className="mt-4 space-y-2.5">
            <ObsidianSection
              view={obsidian}
              list={list}
              saving={saving}
              onToggle={(kind, path, locked) => toggleRule(kind, path, locked)}
              onRemove={(kind, path) => removeRule(kind, path)}
              onAdd={(item) => save([...list, item])}
            />
            <GitHubSection
              rows={repoRows}
              reposEnabled={repos !== null}
              list={list}
              saving={saving}
              onToggle={(name, locked) => toggleRule('repo', name, locked)}
              onRemove={(name) => removeRule('repo', name)}
              onAdd={(item) => save([...list, item])}
            />
            <DriveSection
              view={drive}
              list={list}
              saving={saving}
              onToggle={(path, locked) => toggleRule('gdrive', path, locked)}
              onRemove={(path) => removeRule('gdrive', path)}
              onAdd={(item) => save([...list, item])}
            />
            <KeepRow
              locked={keep.locked}
              documents={keep.documents}
              saving={saving}
              onLocked={(locked) => toggleRule('keep', KEEP_RULE_PATH, locked)}
            />
          </div>

          {saveError === null ? null : <Alert message={saveError} />}
          <p className="mt-3 text-sm text-muted">
            A change applies without re-indexing. Unlocked notes may take a moment to become readable again.
          </p>
        </>
      )}
    </section>
  )
}

function SourceAccordion({
  icon: Icon,
  title,
  summary,
  lockedCount,
  defaultOpen = false,
  children,
}: {
  icon: LucideIcon
  title: string
  summary: string
  lockedCount: number
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const panelId = useId()
  return (
    <div className="rounded-control border border-line bg-canvas">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((prev) => !prev)}
        className="flex min-h-11 w-full flex-wrap items-center gap-x-2.5 gap-y-1 px-3.5 py-2.5 text-left transition-colors hover:bg-raised"
      >
        {open ? (
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted" />
        ) : (
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted" />
        )}
        <Icon aria-hidden="true" className="size-4 shrink-0 text-muted" />
        <span className="text-sm font-semibold text-ink">{title}</span>
        <span className="text-xs text-muted">{summary}</span>
        <span
          className={`ml-auto rounded-full px-2.5 py-0.5 text-xs font-medium tabular-nums ${
            lockedCount > 0 ? 'bg-strong text-on-strong' : 'bg-raised text-muted'
          }`}
        >
          {lockedCount > 0 ? `${lockedCount} locked` : 'All allowed'}
        </span>
      </button>
      {open ? (
        <div id={panelId} className="border-t border-line bg-surface p-3.5">
          {children}
        </div>
      ) : null}
    </div>
  )
}

function ObsidianSection({
  view,
  list,
  saving,
  onToggle,
  onRemove,
  onAdd,
}: {
  view: ReturnType<typeof buildObsidianView>
  list: readonly LlmExclusion[]
  saving: boolean
  onToggle: (kind: 'folder' | 'note' | 'tag', path: string, locked: boolean) => void
  onRemove: (kind: 'folder' | 'note' | 'tag', path: string) => void
  onAdd: (item: LlmExclusion) => Promise<boolean>
}) {
  const [tab, setTab] = useState<'folders' | 'tags' | 'notes'>('folders')
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()

  const summaryParts = [
    plural(view.folders.length, 'folder'),
    plural(view.tags.length, 'tag'),
    plural(view.notes.length, 'note'),
  ]

  const folders = view.folders.filter((item) => needle === '' || item.path.toLowerCase().includes(needle))
  const tags = view.tags.filter((item) => needle === '' || item.tag.toLowerCase().includes(needle))
  const notes = view.notes.filter((item) => needle === '' || item.path.toLowerCase().includes(needle))
  const activeTotal = tab === 'folders' ? view.folders.length : tab === 'tags' ? view.tags.length : view.notes.length

  return (
    <SourceAccordion
      icon={FileText}
      title="Obsidian"
      summary={summaryParts.join(' · ')}
      lockedCount={view.lockedCount}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Obsidian catalog" className="inline-flex rounded-control bg-raised p-0.5">
          {(
            [
              { id: 'folders', label: `Folders (${view.folders.length})` },
              { id: 'tags', label: `Tags (${view.tags.length})` },
              { id: 'notes', label: `Notes (${view.notes.length})` },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className="min-h-10 rounded-[0.625rem] px-3 text-xs font-medium text-muted transition-colors hover:text-ink aria-selected:bg-strong aria-selected:text-on-strong"
            >
              {item.label}
            </button>
          ))}
        </div>
        {activeTotal > 6 ? (
          <FilterInput value={query} onChange={setQuery} placeholder="Filter Obsidian…" label="Filter Obsidian items" />
        ) : null}
      </div>

      {tab === 'folders' ? (
        folders.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            {view.folders.length === 0 ? 'No vault folders indexed yet.' : 'No folders match that filter.'}
          </p>
        ) : (
          <ul className="mt-3" aria-label="Obsidian folders">
            {folders.map((folder) => (
              <RuleRowItem
                key={folder.path}
                icon={Folder}
                kindLabel="Folder"
                label={`${folder.path}/`}
                count={folder.documents === null ? null : plural(folder.documents, 'note')}
                badge={folder.coveredByParent === null ? null : `Inside ${folder.coveredByParent}/`}
                locked={folder.locked}
                saving={saving}
                onLocked={(locked) => onToggle('folder', folder.path, locked)}
                onRemove={folder.inCatalog ? undefined : () => onRemove('folder', folder.path)}
              />
            ))}
          </ul>
        )
      ) : tab === 'tags' ? (
        tags.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            {view.tags.length === 0 ? 'No vault tags indexed yet.' : 'No tags match that filter.'}
          </p>
        ) : (
          <ul className="mt-3" aria-label="Obsidian tags">
            {tags.map((item) => (
              <RuleRowItem
                key={item.tag}
                icon={Hash}
                kindLabel="Tag"
                label={`#${item.tag}`}
                count={item.documents === null ? null : plural(item.documents, 'note')}
                badge={item.coveredByParent === null ? null : `Covered by #${item.coveredByParent}`}
                locked={item.locked}
                saving={saving}
                onLocked={(locked) => onToggle('tag', item.tag, locked)}
                onRemove={item.inCatalog ? undefined : () => onRemove('tag', item.tag)}
              />
            ))}
          </ul>
        )
      ) : notes.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          {view.notes.length === 0 ? 'No vault notes indexed yet.' : 'No notes match that filter.'}
        </p>
      ) : (
        <ul className="mt-3" aria-label="Obsidian notes">
          {notes.map((note) => (
            <RuleRowItem
              key={note.path}
              icon={FileText}
              kindLabel="Note"
              label={note.path}
              count={null}
              badge={note.coveredByFolder === null ? null : `Inside ${note.coveredByFolder}/`}
              locked={note.locked}
              saving={saving}
              onLocked={(locked) => onToggle('note', note.path, locked)}
              onRemove={note.inCatalog ? undefined : () => onRemove('note', note.path)}
            />
          ))}
        </ul>
      )}

      <ObsidianAddForm list={list} saving={saving} onAdd={onAdd} />
    </SourceAccordion>
  )
}

function GitHubSection({
  rows,
  reposEnabled,
  list,
  saving,
  onToggle,
  onRemove,
  onAdd,
}: {
  rows: ReturnType<typeof buildRepoRows>
  reposEnabled: boolean
  list: readonly LlmExclusion[]
  saving: boolean
  onToggle: (name: string, locked: boolean) => void
  onRemove: (name: string) => void
  onAdd: (item: LlmExclusion) => Promise<boolean>
}) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const filtered = rows.filter((repo) => needle === '' || repo.name.toLowerCase().includes(needle))
  const lockedCount = rows.filter((repo) => repo.locked).length

  return (
    <SourceAccordion
      icon={FolderGit2}
      title="GitHub"
      summary={reposEnabled || rows.length > 0 ? plural(rows.length, 'repo') : 'Not configured'}
      lockedCount={lockedCount}
    >
      {rows.length > 6 ? (
        <FilterInput value={query} onChange={setQuery} placeholder="Filter repositories…" label="Filter repositories" />
      ) : null}
      {filtered.length === 0 ? (
        <p className="mt-2 text-sm text-muted">
          {rows.length === 0 ? 'No repositories indexed yet.' : 'No repositories match that filter.'}
        </p>
      ) : (
        <ul className={rows.length > 6 ? 'mt-2' : ''} aria-label="GitHub repositories">
          {filtered.map((repo) => (
            <RuleRowItem
              key={repo.name}
              icon={FolderGit2}
              kindLabel="Repo"
              label={repo.name}
              count={plural(repo.files, 'file')}
              badge={repo.inIndex ? null : 'Not in repos.json'}
              locked={repo.locked}
              saving={saving}
              onLocked={(locked) => onToggle(repo.name, locked)}
              onRemove={repo.inIndex ? undefined : () => onRemove(repo.name)}
            />
          ))}
        </ul>
      )}
      <SingleKindAddForm
        kind="repo"
        fieldLabel="Lock a repo by name"
        placeholder="my-repo"
        buttonLabel="Add repo"
        list={list}
        saving={saving}
        onAdd={onAdd}
      />
    </SourceAccordion>
  )
}

function DriveSection({
  view,
  list,
  saving,
  onToggle,
  onRemove,
  onAdd,
}: {
  view: ReturnType<typeof buildDriveView>
  list: readonly LlmExclusion[]
  saving: boolean
  onToggle: (path: string, locked: boolean) => void
  onRemove: (path: string) => void
  onAdd: (item: LlmExclusion) => Promise<boolean>
}) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const lockedCount = (view.allLocked ? 1 : 0) + view.lockedFolderCount

  const matchingFolders = view.folders.filter(
    (folder) =>
      needle === '' ||
      folder.path.toLowerCase().includes(needle) ||
      folder.files.some((file) => file.name.toLowerCase().includes(needle)),
  )
  const matchingRootFiles = view.rootFiles.filter(
    (file) => needle === '' || file.name.toLowerCase().includes(needle),
  )

  return (
    <SourceAccordion
      icon={Cloud}
      title="Google Drive"
      summary={`${plural(view.allDocuments, 'file')} · ${plural(view.folders.length, 'folder')}`}
      lockedCount={lockedCount}
    >
      <ul aria-label="Google Drive rules">
        <RuleRowItem
          icon={Cloud}
          kindLabel="Google Drive"
          label="All of Google Drive"
          count={plural(view.allDocuments, 'file')}
          badge={null}
          locked={view.allLocked}
          saving={saving}
          onLocked={(locked) => onToggle(DRIVE_ROOT_RULE_PATH, locked)}
        />
      </ul>
      <p className="mt-1 text-xs text-muted">
        Drive rules lock either the whole Drive or a folder and its subfolders. Files inside each folder are listed below.
      </p>

      {view.folders.length + view.rootFiles.length > 6 ? (
        <div className="mt-3">
          <FilterInput
            value={query}
            onChange={setQuery}
            placeholder="Filter Drive folders or files…"
            label="Filter Google Drive folders or files"
          />
        </div>
      ) : null}

      {matchingFolders.length > 0 ? (
        <ul className="mt-2" aria-label="Google Drive folders">
          {matchingFolders.map((folder) => (
            <DriveFolderItem
              key={folder.path}
              folder={folder}
              needle={needle}
              saving={saving}
              onLocked={(locked) => onToggle(folder.path, locked)}
              onRemove={folder.inCatalog ? undefined : () => onRemove(folder.path)}
            />
          ))}
        </ul>
      ) : view.folders.length > 0 && needle !== '' && matchingRootFiles.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No Drive folders or files match that filter.</p>
      ) : null}

      {matchingRootFiles.length > 0 ? (
        <div className="mt-2 border-t border-line pt-2.5">
          <p className="text-xs font-medium text-muted">My Drive root files (covered by All of Google Drive)</p>
          <ul className="mt-1.5 space-y-1 pl-2" aria-label="Google Drive root files">
            {matchingRootFiles.map((file) => (
              <li key={file.path} className="flex items-center gap-2 text-xs text-muted">
                <FileSpreadsheet aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="font-mono break-all text-ink">{file.name}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <SingleKindAddForm
        kind="gdrive"
        fieldLabel="Add Drive folder"
        placeholder="Clients/Acme"
        buttonLabel="Add folder"
        list={list}
        saving={saving}
        onAdd={onAdd}
      />
    </SourceAccordion>
  )
}

function DriveFolderItem({
  folder,
  needle,
  saving,
  onLocked,
  onRemove,
}: {
  folder: ReturnType<typeof buildDriveView>['folders'][number]
  needle: string
  saving: boolean
  onLocked: (locked: boolean) => void
  onRemove?: () => void
}) {
  const [showAllFiles, setShowAllFiles] = useState(false)
  const visibleFiles =
    needle === ''
      ? folder.files
      : folder.files.filter((file) => file.name.toLowerCase().includes(needle) || folder.path.toLowerCase().includes(needle))
  const cappedFiles = showAllFiles || visibleFiles.length <= 5 ? visibleFiles : visibleFiles.slice(0, 5)

  return (
    <li className="border-t border-line py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex min-w-0 flex-1 basis-48 items-center gap-2">
          <Folder aria-hidden="true" className="size-4 shrink-0 text-muted" />
          <span className="sr-only">Google Drive folder</span>
          <span className="font-mono text-sm break-all">{folder.path}/</span>
          {folder.coveredByParent === null ? null : (
            <span className="rounded-full bg-raised px-2 py-0.5 text-xs text-muted">
              {folder.coveredByParent === DRIVE_ROOT_RULE_PATH ? 'Covered by Drive lock' : `Inside ${folder.coveredByParent}/`}
            </span>
          )}
        </span>
        {folder.documents === null ? null : (
          <span className="text-sm text-muted tabular-nums">{plural(folder.documents, 'file')}</span>
        )}
        <AccessToggle
          label={`Drive: ${folder.path}/`}
          locked={folder.locked}
          saving={saving}
          onLocked={onLocked}
        />
        {onRemove === undefined ? null : (
          <RemoveButton label={`Drive: ${folder.path}/`} saving={saving} onRemove={onRemove} />
        )}
      </div>
      {visibleFiles.length > 0 ? (
        <ul className="mt-1.5 space-y-1 pl-6" aria-label={`Files in ${folder.path}`}>
          {cappedFiles.map((file) => (
            <li key={file.path} className="flex items-center gap-2 text-xs text-muted">
              <FileSpreadsheet aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="font-mono break-all">{file.name}</span>
            </li>
          ))}
          {visibleFiles.length > 5 && !showAllFiles ? (
            <li>
              <button
                type="button"
                onClick={() => setShowAllFiles(true)}
                className="min-h-11 text-xs font-medium text-accent-ink hover:underline"
              >
                Show all {visibleFiles.length} files
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  )
}

function KeepRow({
  locked,
  documents,
  saving,
  onLocked,
}: {
  locked: boolean
  documents: number
  saving: boolean
  onLocked: (locked: boolean) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-control border border-line bg-canvas px-3.5 py-2.5">
      <span className="flex min-w-0 flex-1 basis-48 items-center gap-2">
        <StickyNote aria-hidden="true" className="size-4 shrink-0 text-muted" />
        <span className="text-sm font-semibold text-ink">Google Keep</span>
      </span>
      <span className="text-sm text-muted tabular-nums">{plural(documents, 'note')}</span>
      <AccessToggle label="Google Keep" locked={locked} saving={saving} onLocked={onLocked} />
    </div>
  )
}

function RuleRowItem({
  icon: Icon,
  kindLabel,
  label,
  count,
  badge,
  locked,
  saving,
  onLocked,
  onRemove,
}: {
  icon: LucideIcon
  kindLabel: string
  label: string
  count: string | null
  badge: string | null
  locked: boolean
  saving: boolean
  onLocked: (locked: boolean) => void
  onRemove?: () => void
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line py-2.5 first:border-t-0">
      <span className="flex min-w-0 flex-1 basis-48 items-center gap-2">
        <Icon aria-hidden="true" className="size-4 shrink-0 text-muted" />
        <span className="sr-only">{kindLabel}</span>
        <span className="font-mono text-sm break-all">{label}</span>
        {badge === null ? null : <span className="rounded-full bg-raised px-2 py-0.5 text-xs text-muted">{badge}</span>}
      </span>
      {count === null ? null : <span className="text-sm text-muted tabular-nums">{count}</span>}
      <AccessToggle label={label} locked={locked} saving={saving} onLocked={onLocked} />
      {onRemove === undefined ? null : <RemoveButton label={label} saving={saving} onRemove={onRemove} />}
    </li>
  )
}

function AccessToggle({
  label,
  locked,
  saving,
  onLocked,
}: {
  label: string
  locked: boolean
  saving: boolean
  onLocked: (locked: boolean) => void
}) {
  return (
    <div role="radiogroup" aria-label={`Gemini access for ${label}`} className="flex rounded-control bg-raised p-0.5">
      <AccessButton checked={!locked} disabled={saving} onClick={() => onLocked(false)} icon={LockOpen}>
        Allowed
      </AccessButton>
      <AccessButton checked={locked} disabled={saving} onClick={() => onLocked(true)} icon={Lock}>
        Locked
      </AccessButton>
    </div>
  )
}

function RemoveButton({ label, saving, onRemove }: { label: string; saving: boolean; onRemove: () => void }) {
  return (
    <button
      type="button"
      disabled={saving}
      onClick={onRemove}
      aria-label={`Remove ${label}`}
      className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-raised hover:text-ink disabled:opacity-50"
    >
      <Trash2 aria-hidden="true" className="size-4" />
    </button>
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

function FilterInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string
  onChange: (next: string) => void
  placeholder: string
  label: string
}) {
  return (
    <label className="relative flex min-w-44 items-center">
      <Search aria-hidden="true" className="pointer-events-none absolute left-3 size-4 text-muted" />
      <input
        type="search"
        value={value}
        aria-label={label}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11 w-full rounded-control border border-line bg-canvas pl-9 pr-3 text-base text-ink placeholder:text-muted"
      />
    </label>
  )
}

const OBSIDIAN_ADD_KINDS: { kind: 'folder' | 'note' | 'tag'; label: string; field: string; placeholder: string }[] = [
  { kind: 'folder', label: 'Folder', field: 'Path in the vault', placeholder: 'Private' },
  { kind: 'note', label: 'Single note', field: 'Path in the vault', placeholder: 'Journal/2026-11-26.md' },
  { kind: 'tag', label: 'Tag', field: 'Tag', placeholder: 'private' },
]

function ObsidianAddForm({
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
  const [kind, setKind] = useState<'folder' | 'note' | 'tag'>('folder')
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const current = OBSIDIAN_ADD_KINDS.find((item) => item.kind === kind) ?? OBSIDIAN_ADD_KINDS[0]!

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
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-3 border-t border-line pt-3" noValidate>
      <div className="flex flex-col gap-1">
        <label htmlFor={kindId} className="text-sm text-muted">
          Lock a
        </label>
        <select
          id={kindId}
          value={kind}
          disabled={saving}
          onChange={(event) => {
            setKind(event.target.value as 'folder' | 'note' | 'tag')
            setError(null)
          }}
          className="min-h-11 rounded-control border border-line bg-canvas px-3 text-base text-ink"
        >
          {OBSIDIAN_ADD_KINDS.map((item) => (
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

function SingleKindAddForm({
  kind,
  fieldLabel,
  placeholder,
  buttonLabel,
  list,
  saving,
  onAdd,
}: {
  kind: 'repo' | 'gdrive'
  fieldLabel: string
  placeholder: string
  buttonLabel: string
  list: readonly LlmExclusion[]
  saving: boolean
  onAdd: (item: LlmExclusion) => Promise<boolean>
}) {
  const pathId = useId()
  const errorId = useId()
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
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-3 border-t border-line pt-3" noValidate>
      <div className="flex min-w-48 flex-1 flex-col gap-1">
        <label htmlFor={pathId} className="text-sm text-muted">
          {fieldLabel}
        </label>
        <input
          id={pathId}
          type="text"
          value={path}
          disabled={saving}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={placeholder}
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
        {saving ? 'Saving…' : buttonLabel}
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

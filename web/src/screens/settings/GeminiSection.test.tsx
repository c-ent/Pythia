import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client'
import { GEMINI_CHANGED, type GeminiStatus } from '../../api/gemini'
import { EMPTY_EXCLUSION_CATALOG, type CountedLlmExclusion, type LlmExclusion, type LlmExclusionCatalog } from '../../api/settings'
import { checkExclusionPath, exclusionErrorMessage, normalizeTag, normalizeVaultPath } from '../exclusionPaths'
import {
  buildDriveView,
  buildKeepRow,
  buildObsidianView,
  buildRepoRows,
  buildRuleRows,
  checkKey,
  keyErrorMessage,
  keyStatusText,
  keyWarningText,
  testResultText,
} from './gemini'
import { GeminiSection } from './GeminiSection'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const failure = (status: number, code: string, message: string) => json(status, { error: { code, message } })

type Handler = (init?: RequestInit) => Response | Promise<Response>

const STATUS_URL = '/api/settings/gemini'
const KEY_URL = '/api/settings/gemini/key'
const TEST_URL = '/api/settings/gemini/test'
const RULES_URL = '/api/settings/llm-exclusions'
const CATALOG_URL = '/api/settings/llm-exclusions/catalog'
const REPOS_URL = '/api/repos'

// Built by concatenation so no key-like literal is committed.
const TYPED_KEY = 'AIza' + 'x'.repeat(31) + 'k3Y9'

function status(extra: Partial<GeminiStatus> = {}): GeminiStatus {
  return {
    configured: false,
    source: null,
    last4: null,
    savedAt: null,
    envOverridesSaved: false,
    canSave: true,
    warning: null,
    model: 'gemini-test-model',
    usedToday: 0,
    ...extra,
  }
}

const KIND_ORDER = { folder: 0, note: 1, tag: 2, repo: 3, keep: 4, gdrive: 5 } as const

/** A server that keeps the key status and the rule list in memory, like the real one. */
function stubServer({
  gemini = status(),
  rules = [] as LlmExclusion[],
  counts = {} as Record<string, number>,
  catalog = EMPTY_EXCLUSION_CATALOG as LlmExclusionCatalog,
  repos = [] as { name: string; files: number }[] | null,
  routes = {} as Record<string, Handler>,
} = {}) {
  let current = gemini
  let stored = [...rules]
  const calls: { key: string; init?: RequestInit }[] = []
  const puts: LlmExclusion[][] = []
  const counted = (): CountedLlmExclusion[] =>
    [...stored]
      .sort((a, b) => (a.kind !== b.kind ? KIND_ORDER[a.kind] - KIND_ORDER[b.kind] : a.path.localeCompare(b.path)))
      .map((rule) => ({ ...rule, documents: counts[`${rule.kind}:${rule.path}`] ?? 0 }))
  const all: Record<string, Handler> = {
    [`GET ${STATUS_URL}`]: () => json(200, current),
    [`PUT ${KEY_URL}`]: (init) => {
      const body = JSON.parse(String(init?.body)) as { apiKey: string }
      current = { ...current, configured: true, source: 'settings', last4: body.apiKey.slice(-4), savedAt: '2026-11-26T08:00:00.000Z' }
      return json(200, current)
    },
    [`DELETE ${KEY_URL}`]: () => {
      current = { ...current, configured: false, source: null, last4: null, savedAt: null }
      return json(200, current)
    },
    [`POST ${TEST_URL}`]: () => json(200, { ok: true }),
    [`GET ${RULES_URL}`]: () => json(200, { exclusions: counted() }),
    [`GET ${CATALOG_URL}`]: () => json(200, catalog),
    [`PUT ${RULES_URL}`]: (init) => {
      const body = JSON.parse(String(init?.body)) as { exclusions: LlmExclusion[] }
      puts.push(body.exclusions)
      stored = body.exclusions
      return json(200, { exclusions: counted() })
    },
    [`GET ${REPOS_URL}`]: () =>
      repos === null
        ? failure(404, 'not_found', 'Not found')
        : json(200, { repos: repos.map((repo) => ({ ...repo, chunks: 0, updatedAt: null })) }),
    ...routes,
  }
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`
    calls.push({ key, init })
    const route = all[key]
    return route === undefined ? failure(404, 'not_found', 'Not found') : route(init)
  })
  vi.stubGlobal('fetch', fn)
  return { calls, puts }
}

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
}

const keyCard = (): HTMLElement => screen.getByRole('region', { name: 'API key' })
const rulesCard = (): HTMLElement => screen.getByRole('region', { name: 'Kept away from Gemini' })

function access(label: string): HTMLElement {
  return within(rulesCard()).getByRole('radiogroup', { name: `Gemini access for ${label}` })
}

function checked(label: string): string | undefined {
  return within(access(label))
    .getAllByRole('radio')
    .find((radio) => radio.getAttribute('aria-checked') === 'true')?.textContent ?? undefined
}

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  Reflect.deleteProperty(navigator, 'onLine')
  vi.restoreAllMocks()
})

describe('GeminiSection: API key', () => {
  it('shows a saved key by its last 4 characters, saved date and today’s usage', async () => {
    stubServer({
      gemini: status({ configured: true, source: 'settings', last4: '7Q2f', savedAt: '2026-11-20T08:00:00.000Z', usedToday: 12 }),
    })
    render(<GeminiSection />)
    const card = keyCard()
    expect(await within(card).findByText(/The key ending in 7Q2f was saved here on/)).toBeTruthy()
    expect(within(card).getByText('Connected')).toBeTruthy()
    expect(within(card).getByText('Used today: 12 requests')).toBeTruthy()
    expect(within(card).getByText(/Google may use what Ask sends to Gemini/)).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Remove' })).toBeTruthy()
  })

  it('says when the .env key wins over a saved one', async () => {
    stubServer({
      gemini: status({ configured: true, source: 'env', last4: 'ab12', savedAt: '2026-11-20T08:00:00.000Z', envOverridesSaved: true }),
    })
    render(<GeminiSection />)
    expect(await within(keyCard()).findByText(/comes from GEMINI_API_KEY in \.env/)).toBeTruthy()
    expect(within(keyCard()).getByText(/GEMINI_API_KEY in \.env wins/)).toBeTruthy()
  })

  it('shows the server’s warning when the saved key cannot be opened', async () => {
    stubServer({ gemini: status({ warning: 'undecryptable', savedAt: '2026-11-20T08:00:00.000Z' }) })
    render(<GeminiSection />)
    expect(await within(keyCard()).findByText(/PYTHIA_SECRETS_KEY can’t open it/)).toBeTruthy()
    expect(within(keyCard()).getByText('Not set')).toBeTruthy()
  })

  it('saves a typed key from a password field and clears the field', async () => {
    const server = stubServer()
    const changed = vi.fn()
    window.addEventListener(GEMINI_CHANGED, changed)
    render(<GeminiSection />)
    const field = (await within(keyCard()).findByLabelText('Gemini API key')) as HTMLInputElement
    expect(field.type).toBe('password')
    fireEvent.change(field, { target: { value: `  ${TYPED_KEY} ` } })
    fireEvent.click(within(keyCard()).getByRole('button', { name: 'Save' }))
    expect(await within(keyCard()).findByText(/The key ending in k3Y9 was saved here/)).toBeTruthy()
    const put = server.calls.find((call) => call.key === `PUT ${KEY_URL}`)
    expect(JSON.parse(String(put?.init?.body))).toEqual({ apiKey: TYPED_KEY })
    expect((within(keyCard()).getByLabelText('Replace with a new key') as HTMLInputElement).value).toBe('')
    expect(changed).toHaveBeenCalled()
    window.removeEventListener(GEMINI_CHANGED, changed)
  })

  it('refuses a key that is clearly wrong without calling the server', async () => {
    const server = stubServer()
    render(<GeminiSection />)
    fireEvent.change(await within(keyCard()).findByLabelText('Gemini API key'), { target: { value: 'short' } })
    fireEvent.click(within(keyCard()).getByRole('button', { name: 'Save' }))
    expect(await within(keyCard()).findByText(/doesn’t look like a Gemini API key/)).toBeTruthy()
    expect(server.calls.some((call) => call.key === `PUT ${KEY_URL}`)).toBe(false)
  })

  it('explains that saving needs PYTHIA_SECRETS_KEY and shows the server’s 409 message', async () => {
    stubServer({
      routes: {
        [`PUT ${KEY_URL}`]: () => failure(409, 'secrets_key_missing', 'Set PYTHIA_SECRETS_KEY in .env and restart.'),
      },
    })
    render(<GeminiSection />)
    const field = (await within(keyCard()).findByLabelText('Gemini API key')) as HTMLInputElement
    fireEvent.change(field, { target: { value: TYPED_KEY } })
    fireEvent.click(within(keyCard()).getByRole('button', { name: 'Save' }))
    expect(await within(keyCard()).findByText('Set PYTHIA_SECRETS_KEY in .env and restart.')).toBeTruthy()
    // A failed save keeps the typed key so the owner can try again.
    expect(field.value).toBe(TYPED_KEY)
  })

  it('disables saving when the server has no secrets key', async () => {
    stubServer({ gemini: status({ canSave: false }) })
    render(<GeminiSection />)
    expect(await within(keyCard()).findByText(/Saving a key here needs PYTHIA_SECRETS_KEY/)).toBeTruthy()
    expect(within(keyCard()).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
    expect(within(keyCard()).getByLabelText('Gemini API key')).toHaveProperty('disabled', true)
  })

  it.each([
    [{ ok: true }, 'Gemini answered. The key works.'],
    [{ ok: false, error: 'invalid_key' }, /Invalid key/],
    [{ ok: false, error: 'rate_limited' }, /Rate limited/],
    [{ ok: false, error: 'unreachable' }, /Unreachable/],
  ])('tests the key and reports %j', async (result, text) => {
    const server = stubServer({
      gemini: status({ configured: true, source: 'env', last4: 'ab12' }),
      routes: { [`POST ${TEST_URL}`]: () => json(200, result) },
    })
    render(<GeminiSection />)
    fireEvent.click(await within(keyCard()).findByRole('button', { name: 'Test' }))
    expect(await within(keyCard()).findByText(text)).toBeTruthy()
    // The test call counts as a request, so the status reloads.
    await waitFor(() => expect(server.calls.filter((call) => call.key === `GET ${STATUS_URL}`)).toHaveLength(2))
  })

  it('removes the saved key', async () => {
    const server = stubServer({ gemini: status({ configured: true, source: 'settings', last4: '7Q2f', savedAt: '2026-11-20T08:00:00.000Z' }) })
    render(<GeminiSection />)
    fireEvent.click(await within(keyCard()).findByRole('button', { name: 'Remove' }))
    expect(await within(keyCard()).findByText(/No key yet/)).toBeTruthy()
    expect(server.calls.some((call) => call.key === `DELETE ${KEY_URL}`)).toBe(true)
    expect(within(keyCard()).queryByRole('button', { name: 'Remove' })).toBeNull()
  })
})

describe('GeminiSection: rules', () => {
  const sampleCatalog: LlmExclusionCatalog = {
    obsidian: {
      folders: [
        { path: 'Journal', documents: 64 },
        { path: 'Health', documents: 4 },
      ],
      notes: ['Health/Doctor.md', 'Journal/Today.md'],
      tags: [{ tag: 'private', documents: 9 }],
    },
    gdrive: {
      totalDocuments: 3,
      folders: [{ path: 'Finance', documents: 2 }],
      files: ['Finance/Budget.xlsx', 'Finance/Summary.docx', 'Notes.pdf'],
    },
    keep: { documents: 126 },
  }

  it('groups rules into Obsidian, GitHub, Google Drive and Google Keep with locked counts', async () => {
    stubServer({
      rules: [
        { kind: 'folder', path: 'Journal' },
        { kind: 'note', path: 'Health/Doctor.md' },
        { kind: 'tag', path: 'private' },
        { kind: 'repo', path: 'secret-repo' },
      ],
      counts: { 'folder:Journal': 64, 'note:Health/Doctor.md': 1, 'tag:private': 9, 'repo:secret-repo': 40 },
      catalog: sampleCatalog,
      repos: [
        { name: 'secret-repo', files: 40 },
        { name: 'open-repo', files: 12 },
      ],
    })
    render(<GeminiSection />)
    const card = rulesCard()

    const obsidianBtn = await within(card).findByRole('button', { name: /Obsidian/ })
    const githubBtn = within(card).getByRole('button', { name: /GitHub/ })
    const driveBtn = within(card).getByRole('button', { name: /Google Drive/ })
    expect(obsidianBtn.getAttribute('aria-expanded')).toBe('false')
    expect(obsidianBtn.textContent).toContain('3 locked')
    expect(githubBtn.textContent).toContain('2 repos')
    expect(githubBtn.textContent).toContain('1 locked')
    expect(driveBtn.textContent).toContain('All allowed')
    expect(checked('Google Keep')).toBe('Allowed')
    expect(within(card).getByText('126 notes')).toBeTruthy()

    // Expanding GitHub reveals the repository catalog.
    fireEvent.click(githubBtn)
    expect(githubBtn.getAttribute('aria-expanded')).toBe('true')
    const repoList = within(card).getByRole('list', { name: 'GitHub repositories' })
    expect(within(repoList).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('open-repo'),
      expect.stringContaining('secret-repo'),
    ])
    expect(checked('open-repo')).toBe('Allowed')
    expect(checked('secret-repo')).toBe('Locked')

    // Expanding Obsidian shows Folders, Tags and Notes tabs.
    fireEvent.click(obsidianBtn)
    expect(checked('Journal/')).toBe('Locked')
    fireEvent.click(within(card).getByRole('tab', { name: /Tags/ }))
    expect(checked('#private')).toBe('Locked')
    fireEvent.click(within(card).getByRole('tab', { name: /Notes/ }))
    expect(checked('Health/Doctor.md')).toBe('Locked')
    expect(within(card).getByText('Inside Journal/')).toBeTruthy()
  })

  it('locks a repo from the GitHub catalog and Google Keep, sending the whole list', async () => {
    const server = stubServer({
      repos: [{ name: 'open-repo', files: 12 }],
      catalog: sampleCatalog,
      counts: { 'keep:keep': 126 },
    })
    render(<GeminiSection />)
    const card = rulesCard()
    fireEvent.click(await within(card).findByRole('button', { name: /GitHub/ }))
    fireEvent.click(within(access('open-repo')).getByRole('radio', { name: 'Locked' }))
    await waitFor(() => expect(checked('open-repo')).toBe('Locked'))
    fireEvent.click(within(access('Google Keep')).getByRole('radio', { name: 'Locked' }))
    await waitFor(() => expect(checked('Google Keep')).toBe('Locked'))
    expect(server.puts).toEqual([
      [{ kind: 'repo', path: 'open-repo' }],
      [
        { kind: 'repo', path: 'open-repo' },
        { kind: 'keep', path: 'keep' },
      ],
    ])
  })

  it('expands Google Drive to show files inside folders and root files, and toggles Drive locks', async () => {
    const server = stubServer({ catalog: sampleCatalog })
    render(<GeminiSection />)
    const card = rulesCard()
    fireEvent.click(await within(card).findByRole('button', { name: /Google Drive/ }))
    expect(within(card).getByText('Budget.xlsx')).toBeTruthy()
    expect(within(card).getByText('Summary.docx')).toBeTruthy()
    expect(within(card).getByText('Notes.pdf')).toBeTruthy()

    fireEvent.click(within(access('Drive: Finance/')).getByRole('radio', { name: 'Locked' }))
    await waitFor(() => expect(checked('Drive: Finance/')).toBe('Locked'))
    fireEvent.click(within(access('All of Google Drive')).getByRole('radio', { name: 'Locked' }))
    await waitFor(() => expect(checked('All of Google Drive')).toBe('Locked'))
    expect(within(card).getByText('Covered by Drive lock')).toBeTruthy()
    expect(server.puts).toEqual([
      [{ kind: 'gdrive', path: 'Finance' }],
      [
        { kind: 'gdrive', path: 'Finance' },
        { kind: 'gdrive', path: '/' },
      ],
    ])
  })

  it('unlocks a folder and keeps an unindexed rule as an Allowed row until removed', async () => {
    const server = stubServer({ rules: [{ kind: 'folder', path: 'Journal' }], counts: { 'folder:Journal': 64 } })
    render(<GeminiSection />)
    const card = rulesCard()
    fireEvent.click(await within(card).findByRole('button', { name: /Obsidian/ }))
    await within(card).findByText('Journal/')
    fireEvent.click(within(access('Journal/')).getByRole('radio', { name: 'Allowed' }))
    await waitFor(() => expect(checked('Journal/')).toBe('Allowed'))
    expect(within(card).getByText('64 notes')).toBeTruthy()
    fireEvent.click(within(access('Journal/')).getByRole('radio', { name: 'Locked' }))
    await waitFor(() => expect(checked('Journal/')).toBe('Locked'))
    fireEvent.click(within(card).getByRole('button', { name: 'Remove Journal/' }))
    await waitFor(() => expect(within(card).queryByText('Journal/')).toBeNull())
    expect(server.puts).toEqual([[], [{ kind: 'folder', path: 'Journal' }], []])
  })

  it('adds Obsidian folder and tag rules manually with cleaned paths', async () => {
    const server = stubServer()
    render(<GeminiSection />)
    const card = rulesCard()
    await within(card).findByText(/Nothing is locked/)
    fireEvent.click(within(card).getByRole('button', { name: /Obsidian/ }))
    fireEvent.change(within(card).getByLabelText('Path in the vault'), { target: { value: ' ./Work\\Clients/ ' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Add rule' }))
    expect(await within(card).findByText('Work/Clients/')).toBeTruthy()
    expect((within(card).getByLabelText('Path in the vault') as HTMLInputElement).value).toBe('')

    fireEvent.change(within(card).getByLabelText('Lock a'), { target: { value: 'tag' } })
    fireEvent.change(within(card).getByLabelText('Tag'), { target: { value: '#Private/' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Add rule' }))
    fireEvent.click(within(card).getByRole('tab', { name: /Tags/ }))
    expect(await within(card).findByText('#private')).toBeTruthy()
    expect(server.puts).toEqual([
      [{ kind: 'folder', path: 'Work/Clients' }],
      [
        { kind: 'folder', path: 'Work/Clients' },
        { kind: 'tag', path: 'private' },
      ],
    ])
  })

  it('adds a repo rule by name when repo indexing is off and adds a Drive folder manually', async () => {
    const server = stubServer({ repos: null })
    render(<GeminiSection />)
    const card = rulesCard()
    await within(card).findByText(/Nothing is locked/)
    fireEvent.click(within(card).getByRole('button', { name: /GitHub/ }))
    fireEvent.change(within(card).getByLabelText('Lock a repo by name'), { target: { value: ' old-repo ' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Add repo' }))
    await waitFor(() => expect(checked('old-repo')).toBe('Locked'))

    fireEvent.click(within(card).getByRole('button', { name: /Google Drive/ }))
    fireEvent.change(within(card).getByLabelText('Add Drive folder'), { target: { value: '/Clients/Acme/' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Add folder' }))
    expect(await within(card).findByText('Clients/Acme/')).toBeTruthy()
    expect(server.puts).toEqual([
      [{ kind: 'repo', path: 'old-repo' }],
      [
        { kind: 'repo', path: 'old-repo' },
        { kind: 'gdrive', path: 'Clients/Acme' },
      ],
    ])
  })

  it('refuses a note path without .md and does not call the server', async () => {
    const server = stubServer()
    render(<GeminiSection />)
    const card = rulesCard()
    await within(card).findByText(/Nothing is locked/)
    fireEvent.click(within(card).getByRole('button', { name: /Obsidian/ }))
    fireEvent.change(within(card).getByLabelText('Lock a'), { target: { value: 'note' } })
    fireEvent.change(within(card).getByLabelText('Path in the vault'), { target: { value: 'Health/Doctor' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Add rule' }))
    expect(await within(card).findByText(/A note path ends in .md/)).toBeTruthy()
    expect(server.puts).toEqual([])
  })

  it('keeps the list and shows an error when saving fails', async () => {
    stubServer({
      rules: [{ kind: 'folder', path: 'Journal' }],
      routes: { [`PUT ${RULES_URL}`]: () => failure(500, 'internal', 'Internal server error') },
    })
    render(<GeminiSection />)
    const card = rulesCard()
    fireEvent.click(await within(card).findByRole('button', { name: /Obsidian/ }))
    fireEvent.click(within(card).getByRole('button', { name: 'Remove Journal/' }))
    expect(await within(card).findByText('Couldn’t save the change. Try again.')).toBeTruthy()
    expect(within(card).getByText('Journal/')).toBeTruthy()
    expect(checked('Journal/')).toBe('Locked')
  })

  it('shows a load error and retries', async () => {
    let first = true
    stubServer({
      routes: {
        [`GET ${RULES_URL}`]: () => {
          if (first) {
            first = false
            return failure(500, 'internal', 'Internal server error')
          }
          return json(200, { exclusions: [{ kind: 'folder', path: 'Journal', documents: 3 }] })
        },
      },
    })
    render(<GeminiSection />)
    expect(await within(rulesCard()).findByText('Couldn’t load the list. Try again.')).toBeTruthy()
    fireEvent.click(within(rulesCard()).getByRole('button', { name: 'Retry' }))
    const obsidianBtn = await within(rulesCard()).findByRole('button', { name: /Obsidian/ })
    expect(obsidianBtn.textContent).toContain('1 locked')
  })
})

describe('GeminiSection offline', () => {
  it('says it needs a connection and calls nothing', () => {
    setOnline(false)
    const server = stubServer()
    render(<GeminiSection />)
    expect(screen.getByText(/You’re offline. Gemini access needs a connection./)).toBeTruthy()
    expect(within(rulesCard()).getByText(/This list needs a connection/)).toBeTruthy()
    expect(within(keyCard()).getByText(/The key status needs a connection/)).toBeTruthy()
    expect(server.calls).toEqual([])
  })
})

describe('Gemini access helpers', () => {
  it('checks typed rules like the server does', () => {
    const list: LlmExclusion[] = [
      { kind: 'folder', path: 'Private' },
      { kind: 'tag', path: 'private' },
    ]
    expect(normalizeVaultPath(' ./a\\b//c/ ')).toBe('a/b/c')
    expect(normalizeVaultPath('a/../b')).toBeNull()
    expect(checkExclusionPath('folder', '/Work/', list)).toEqual({ path: 'Work' })
    expect(checkExclusionPath('folder', '  ', list)).toEqual({ error: 'Type a folder or note path.' })
    expect(checkExclusionPath('folder', 'private/', list)).toEqual({ error: 'That is already on the list.' })
    expect(checkExclusionPath('note', 'Private.MD', list)).toEqual({ path: 'Private.MD' })
    expect(checkExclusionPath('folder', 'a\u0007b', list)).toEqual({ error: 'That path can’t be used.' })
    expect(normalizeTag('#Private/Health/')).toBe('private/health')
    expect(normalizeTag('#2026')).toBeNull()
    expect(normalizeTag('a//b')).toBeNull()
    expect(checkExclusionPath('tag', '#PRIVATE', list)).toEqual({ error: 'That is already on the list.' })
    expect(checkExclusionPath('tag', 'with space', list)).toHaveProperty('error')
    expect(checkExclusionPath('repo', ' pythia ', list)).toEqual({ path: 'pythia' })
    expect(checkExclusionPath('repo', '../pythia', list)).toHaveProperty('error')
    expect(checkExclusionPath('repo', 'pythia.git', list)).toHaveProperty('error')
    expect(checkExclusionPath('gdrive', ' /Clients/Acme/ ', list)).toEqual({ path: 'Clients/Acme' })
    expect(checkExclusionPath('gdrive', '', list)).toEqual({ path: '/' })
    expect(checkExclusionPath('gdrive', ' // ', list)).toEqual({ path: '/' })
    expect(checkExclusionPath('gdrive', 'Clients//Acme', list)).toHaveProperty('error')
    expect(checkExclusionPath('gdrive', 'Clients/../Acme', list)).toHaveProperty('error')
    expect(checkExclusionPath('gdrive', 'clients/acme', [{ kind: 'gdrive', path: 'Clients/Acme' }])).toEqual({
      error: 'That is already on the list.',
    })
  })

  it('maps errors to messages', () => {
    expect(exclusionErrorMessage(new ApiError(0, 'network', 'x'), 'load')).toMatch(/Can’t reach the server/)
    expect(exclusionErrorMessage(new ApiError(400, 'invalid_input', 'exclusions.0.path: bad'), 'save')).toBe(
      'The server refused the list: exclusions.0.path: bad',
    )
    expect(keyErrorMessage(new ApiError(409, 'secrets_key_missing', 'Set it'), 'save the key')).toBe('Set it')
    expect(keyErrorMessage(new Error('x'), 'save the key')).toBe('Couldn’t save the key. Try again.')
    expect(testResultText({ ok: false, error: 'no_key' })).toMatch(/Save one first/)
    expect(keyWarningText(status({ warning: 'secrets_key_missing' }))).toMatch(/PYTHIA_SECRETS_KEY is not set/)
    expect(keyWarningText(status())).toBeNull()
  })

  it('describes the key without ever needing more than its last 4 characters', () => {
    expect(keyStatusText(status())).toMatch(/No key yet/)
    expect(keyStatusText(status({ configured: true, source: 'env', last4: 'ab12' }))).toBe(
      'The key ending in ab12 comes from GEMINI_API_KEY in .env.',
    )
    expect(checkKey('  ')).toEqual({ error: 'Paste a Gemini API key.' })
    expect(checkKey(` ${TYPED_KEY} `)).toEqual({ key: TYPED_KEY })
  })

  it('builds rows with Keep always present and locked rules winning over allowed ones', () => {
    const rows = buildRuleRows(
      [{ kind: 'repo', path: 'Alpha', documents: 5 }],
      [{ kind: 'folder', path: 'Old', documents: 2 }],
      [
        { name: 'alpha', files: 5, chunks: 0, updatedAt: null },
        { name: 'beta', files: 1, chunks: 0, updatedAt: null },
      ],
    )
    expect(rows.map((row) => [row.kind, row.path, row.locked, row.documents])).toEqual([
      ['folder', 'Old', false, 2],
      ['repo', 'Alpha', true, 5],
      ['repo', 'beta', false, 1],
      ['keep', 'keep', false, null],
    ])
  })

  it('builds separated Obsidian, GitHub, Drive and Keep views with parent coverage', () => {
    const obsidian = buildObsidianView(
      {
        folders: [
          { path: 'Work', documents: 3 },
          { path: 'Work/Clients', documents: 1 },
        ],
        notes: ['Work/Clients/Acme.md', 'Home.md'],
        tags: [
          { tag: 'private', documents: 2 },
          { tag: 'private/health', documents: 1 },
        ],
      },
      [
        { kind: 'folder', path: 'Work', documents: 3 },
        { kind: 'tag', path: 'private', documents: 2 },
      ],
      [],
    )
    expect(obsidian.lockedCount).toBe(2)
    expect(obsidian.folders[1]).toMatchObject({ path: 'Work/Clients', coveredByParent: 'Work', locked: false })
    expect(obsidian.tags[1]).toMatchObject({ tag: 'private/health', coveredByParent: 'private', locked: false })
    expect(obsidian.notes[1]).toMatchObject({ path: 'Work/Clients/Acme.md', coveredByFolder: 'Work', locked: false })

    const repos = buildRepoRows(
      [{ name: 'alpha', files: 5, chunks: 0, updatedAt: null }],
      [{ kind: 'repo', path: 'removed-repo', documents: 2 }],
      [],
    )
    expect(repos).toEqual([
      { name: 'alpha', files: 5, locked: false, inIndex: true },
      { name: 'removed-repo', files: 2, locked: true, inIndex: false },
    ])

    const drive = buildDriveView(
      {
        totalDocuments: 3,
        folders: [
          { path: 'Finance', documents: 2 },
          { path: 'Finance/2026', documents: 1 },
        ],
        files: ['Finance/Summary.docx', 'Finance/2026/Budget.xlsx', 'Root.pdf'],
      },
      [{ kind: 'gdrive', path: 'Finance', documents: 2 }],
      [],
    )
    expect(drive.folders[0]?.files.map((f) => f.name)).toEqual(['Summary.docx'])
    expect(drive.folders[1]).toMatchObject({
      path: 'Finance/2026',
      coveredByParent: 'Finance',
      files: [{ path: 'Finance/2026/Budget.xlsx', name: 'Budget.xlsx' }],
    })
    expect(drive.rootFiles).toEqual([{ path: 'Root.pdf', name: 'Root.pdf' }])

    expect(buildKeepRow({ documents: 12 }, [])).toEqual({ locked: false, documents: 12 })
    expect(buildKeepRow({ documents: 12 }, [{ kind: 'keep', path: 'keep', documents: 15 }])).toEqual({
      locked: true,
      documents: 15,
    })
  })
})

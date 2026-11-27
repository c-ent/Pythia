import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client'
import { GEMINI_CHANGED, type GeminiStatus } from '../../api/gemini'
import type { CountedLlmExclusion, LlmExclusion } from '../../api/settings'
import { checkExclusionPath, exclusionErrorMessage, normalizeTag, normalizeVaultPath } from '../exclusionPaths'
import { buildRuleRows, checkKey, keyErrorMessage, keyStatusText, keyWarningText, testResultText } from './gemini'
import { GeminiSection } from './GeminiSection'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const failure = (status: number, code: string, message: string) => json(status, { error: { code, message } })

type Handler = (init?: RequestInit) => Response | Promise<Response>

const STATUS_URL = '/api/settings/gemini'
const KEY_URL = '/api/settings/gemini/key'
const TEST_URL = '/api/settings/gemini/test'
const RULES_URL = '/api/settings/llm-exclusions'
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

const KIND_ORDER = { folder: 0, note: 1, tag: 2, repo: 3, keep: 4 } as const

/** A server that keeps the key status and the rule list in memory, like the real one. */
function stubServer({
  gemini = status(),
  rules = [] as LlmExclusion[],
  counts = {} as Record<string, number>,
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
  it('lists every rule kind with its count and Locked state, plus repos and Keep as Allowed', async () => {
    stubServer({
      rules: [
        { kind: 'folder', path: 'Journal' },
        { kind: 'note', path: 'Health/Doctor.md' },
        { kind: 'tag', path: 'private' },
        { kind: 'repo', path: 'secret-repo' },
      ],
      counts: { 'folder:Journal': 64, 'note:Health/Doctor.md': 1, 'tag:private': 9, 'repo:secret-repo': 40 },
      repos: [
        { name: 'secret-repo', files: 40 },
        { name: 'open-repo', files: 12 },
      ],
    })
    render(<GeminiSection />)
    const list = await within(rulesCard()).findByRole('list', { name: 'Rules' })
    const items = within(list).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Journal/'),
      expect.stringContaining('Health/Doctor.md'),
      expect.stringContaining('#private'),
      expect.stringContaining('open-repo'),
      expect.stringContaining('secret-repo'),
      expect.stringContaining('Google Keep'),
    ])
    expect(items[0]!.textContent).toContain('64 notes')
    expect(items[1]!.textContent).toContain('1 note')
    expect(items[2]!.textContent).toContain('9 notes')
    expect(items[3]!.textContent).toContain('12 files')
    expect(items[4]!.textContent).toContain('40 files')
    // The kind is named for screen readers, not only shown as an icon.
    expect(items[2]!.textContent).toContain('Tag')
    expect(checked('Journal/')).toBe('Locked')
    expect(checked('#private')).toBe('Locked')
    expect(checked('secret-repo')).toBe('Locked')
    expect(checked('open-repo')).toBe('Allowed')
    expect(checked('Google Keep')).toBe('Allowed')
  })

  it('locks a repo and Google Keep, sending the whole list', async () => {
    const server = stubServer({ repos: [{ name: 'open-repo', files: 12 }], counts: { 'keep:keep': 126 } })
    render(<GeminiSection />)
    await within(rulesCard()).findByRole('list', { name: 'Rules' })
    fireEvent.click(within(access('open-repo')).getByRole('radio', { name: 'Locked' }))
    await waitFor(() => expect(checked('open-repo')).toBe('Locked'))
    fireEvent.click(within(access('Google Keep')).getByRole('radio', { name: 'Locked' }))
    await waitFor(() => expect(checked('Google Keep')).toBe('Locked'))
    expect(within(rulesCard()).getByText('126 notes')).toBeTruthy()
    expect(server.puts).toEqual([
      [{ kind: 'repo', path: 'open-repo' }],
      [
        { kind: 'repo', path: 'open-repo' },
        { kind: 'keep', path: 'keep' },
      ],
    ])
  })

  it('unlocks a folder and keeps it as an Allowed row that can be locked again', async () => {
    const server = stubServer({ rules: [{ kind: 'folder', path: 'Journal' }], counts: { 'folder:Journal': 64 } })
    render(<GeminiSection />)
    await within(rulesCard()).findByText('Journal/')
    fireEvent.click(within(access('Journal/')).getByRole('radio', { name: 'Allowed' }))
    await waitFor(() => expect(checked('Journal/')).toBe('Allowed'))
    expect(within(rulesCard()).getByText('64 notes')).toBeTruthy()
    fireEvent.click(within(access('Journal/')).getByRole('radio', { name: 'Locked' }))
    await waitFor(() => expect(checked('Journal/')).toBe('Locked'))
    expect(server.puts).toEqual([[], [{ kind: 'folder', path: 'Journal' }]])
  })

  it('removes a folder rule from the list', async () => {
    const server = stubServer({ rules: [{ kind: 'folder', path: 'Journal' }, { kind: 'folder', path: 'Health' }] })
    render(<GeminiSection />)
    fireEvent.click(await within(rulesCard()).findByRole('button', { name: 'Remove Journal/' }))
    await waitFor(() => expect(within(rulesCard()).queryByText('Journal/')).toBeNull())
    expect(within(rulesCard()).getByText('Health/')).toBeTruthy()
    expect(server.puts).toEqual([[{ kind: 'folder', path: 'Health' }]])
    // Repos and Keep have no Remove: they stay as Allowed rows.
    expect(within(rulesCard()).queryByRole('button', { name: 'Remove Google Keep' })).toBeNull()
  })

  it('adds a folder with the path cleaned, and clears the field', async () => {
    const server = stubServer()
    render(<GeminiSection />)
    const card = rulesCard()
    await within(card).findByText(/Nothing is locked/)
    fireEvent.change(within(card).getByLabelText('Path in the vault'), { target: { value: ' ./Work\\Clients/ ' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Add rule' }))
    expect(await within(card).findByText('Work/Clients/')).toBeTruthy()
    expect(server.puts).toEqual([[{ kind: 'folder', path: 'Work/Clients' }]])
    expect((within(card).getByLabelText('Path in the vault') as HTMLInputElement).value).toBe('')
  })

  it('adds a tag rule, written with or without #', async () => {
    const server = stubServer()
    render(<GeminiSection />)
    const card = rulesCard()
    await within(card).findByText(/Nothing is locked/)
    fireEvent.change(within(card).getByLabelText('Lock a'), { target: { value: 'tag' } })
    fireEvent.change(within(card).getByLabelText('Tag'), { target: { value: '#Private/' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Add rule' }))
    expect(await within(card).findByText('#private')).toBeTruthy()
    expect(server.puts).toEqual([[{ kind: 'tag', path: 'private' }]])
  })

  it('adds a repo rule by name', async () => {
    const server = stubServer({ repos: null })
    render(<GeminiSection />)
    const card = rulesCard()
    await within(card).findByText(/Nothing is locked/)
    fireEvent.change(within(card).getByLabelText('Lock a'), { target: { value: 'repo' } })
    fireEvent.change(within(card).getByLabelText('Repo name'), { target: { value: ' old-repo ' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Add rule' }))
    await waitFor(() => expect(checked('old-repo')).toBe('Locked'))
    expect(server.puts).toEqual([[{ kind: 'repo', path: 'old-repo' }]])
  })

  it('refuses a note path without .md and does not call the server', async () => {
    const server = stubServer()
    render(<GeminiSection />)
    const card = rulesCard()
    await within(card).findByText(/Nothing is locked/)
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
    fireEvent.click(await within(rulesCard()).findByRole('button', { name: 'Remove Journal/' }))
    expect(await within(rulesCard()).findByText('Couldn’t save the change. Try again.')).toBeTruthy()
    expect(within(rulesCard()).getByText('Journal/')).toBeTruthy()
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
    expect(await within(rulesCard()).findByText('Journal/')).toBeTruthy()
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
})

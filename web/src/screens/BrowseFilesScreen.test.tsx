import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentInfo } from '../api/documents'
import type { RepoOverview } from '../api/repos'
import { offlineDb } from '../offline/db'
import { BrowseFilesScreen } from './BrowseFilesScreen'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const doc = (over: Partial<DocumentInfo> & Pick<DocumentInfo, 'id' | 'path' | 'title'>): DocumentInfo => ({
  source: { kind: 'repo', name: 'kitchen-app' },
  language: 'typescript',
  allowLlm: true,
  mtime: '2026-11-21T08:00:00.000Z',
  updatedAt: '2026-11-21T08:00:00.000Z',
  ...over,
})

const overview: RepoOverview = {
  name: 'kitchen-app',
  files: 4,
  chunks: 10,
  updatedAt: '2026-11-21T08:00:00.000Z',
  summary: {
    documentId: 30,
    allowLlm: true,
    text: [
      'Repository: kitchen-app (branch main)',
      'Indexed files: 4',
      'Languages: typescript (2)',
      'README:\n# kitchen-app\n\nRecipe planner app.',
    ].join('\n\n'),
  },
}

const repoDocs: DocumentInfo[] = [
  doc({ id: 1, path: 'README.md', title: 'README.md', language: 'markdown' }),
  doc({ id: 2, path: 'package.json', title: 'package.json', language: 'json' }),
  doc({ id: 3, path: 'src/app.ts', title: 'src/app.ts', language: 'typescript' }),
  doc({ id: 4, path: 'src/routes/api.ts', title: 'src/routes/api.ts', language: 'typescript', allowLlm: false }),
]

describe('BrowseFilesScreen', () => {
  beforeEach(async () => {
    localStorage.clear()
    window.history.replaceState(null, '', '/repos/kitchen-app')
    const db = offlineDb()
    await db.documents.clear()
    await db.state.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('browses folders and files in a repo, filters paths, and runs scoped Search and Ask', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })
        if (url === '/api/files?source=repo&name=kitchen-app') return json(200, { documents: repoDocs, total: repoDocs.length })
        if (url === '/api/repos/kitchen-app') return json(200, overview)
        if (url === '/api/status') return json(200, { reachable: true, sources: [], repos: [], activity: [] })
        if (url === '/api/search') {
          return json(200, {
            degraded: false,
            results: [
              {
                chunkId: 91,
                documentId: 3,
                source: { kind: 'repo', name: 'kitchen-app' },
                path: 'src/app.ts',
                title: 'src/app.ts',
                headingPath: 'src/app.ts',
                startLine: 1,
                endLine: 5,
                allowLlm: true,
                score: 0.9,
                ftsRank: 1,
                vectorRank: 1,
                snippet: { text: 'export function start() {}', highlights: [[16, 21]] },
              },
            ],
          })
        }
        if (url === '/api/ask') {
          return json(200, {
            answer: 'It starts in [1].',
            engine: 'gemini',
            model: 'gemini-2.5-flash',
            fallbacks: [],
            citations: [
              {
                n: 1,
                chunkId: 91,
                documentId: 3,
                source: { kind: 'repo', name: 'kitchen-app' },
                path: 'src/app.ts',
                title: 'src/app.ts',
                headingPath: 'src/app.ts',
                startLine: 1,
                endLine: 5,
                allowLlm: true,
                snippet: { text: 'export function start() {}', highlights: [] },
              },
            ],
            withheld: 0,
            degraded: false,
          })
        }
        return json(404, { error: { code: 'not_found', message: 'Not found' } })
      }),
    )

    render(<BrowseFilesScreen source="repo" repoName="kitchen-app" />)

    expect(await screen.findByRole('heading', { level: 1, name: 'kitchen-app' })).toBeTruthy()
    expect(await screen.findByText(/Recipe planner app/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('href')).toBe('/doc/30')

    const filesSection = screen.getByRole('region', { name: 'Files in kitchen-app' })
    const srcFolder = await within(filesSection).findByRole('link', { name: /src\// })
    expect(srcFolder.getAttribute('href')).toBe('/repos/kitchen-app?folder=src')
    expect(within(filesSection).getByRole('link', { name: /README\.md/ }).getAttribute('href')).toBe('/doc/1')

    // Click into src/ folder.
    fireEvent.click(srcFolder)
    expect(window.location.search).toBe('?folder=src')
    expect(await within(filesSection).findByRole('link', { name: /routes\// })).toBeTruthy()
    expect(within(filesSection).getByRole('link', { name: /app\.ts/ }).getAttribute('href')).toBe('/doc/3')

    // Filter files across the whole repo.
    fireEvent.change(within(filesSection).getByLabelText('Filter files'), { target: { value: 'api.ts' } })
    expect(within(filesSection).getByRole('link', { name: /src\/routes\/api\.ts/ }).getAttribute('href')).toBe('/doc/4')
    expect(within(filesSection).queryByRole('link', { name: /README\.md/ })).toBeNull()

    // Scoped Search.
    const querySection = screen.getByRole('region', { name: 'Search or ask in kitchen-app' })
    fireEvent.change(within(querySection).getByLabelText('Search in kitchen-app'), { target: { value: 'start' } })
    fireEvent.click(within(querySection).getByRole('button', { name: 'Search' }))
    expect(await within(querySection).findByText('1 result in kitchen-app')).toBeTruthy()
    expect(calls.find((c) => c.url === '/api/search')?.body).toEqual({
      query: 'start',
      sources: ['repo'],
      repo: 'kitchen-app',
      limit: 20,
    })

    // Scoped Ask.
    fireEvent.click(within(querySection).getByRole('radio', { name: 'Ask' }))
    fireEvent.change(within(querySection).getByLabelText('Ask a question about kitchen-app'), {
      target: { value: 'Where does it start?' },
    })
    fireEvent.click(within(querySection).getByRole('button', { name: 'Ask' }))
    expect(await within(querySection).findByText(/It starts in/)).toBeTruthy()
    expect(calls.find((c) => c.url === '/api/ask')?.body).toEqual({
      question: 'Where does it start?',
      sources: ['repo'],
      repo: 'kitchen-app',
    })
  })

  it('browses Obsidian vault, Google Keep, and Google Drive files', async () => {
    window.history.replaceState(null, '', '/sources/obsidian')
    const obsidianDocs: DocumentInfo[] = [
      doc({ id: 11, source: { kind: 'obsidian', name: 'vault' }, path: 'Projects/Pythia.md', title: 'Pythia', language: 'markdown' }),
      doc({ id: 12, source: { kind: 'obsidian', name: 'vault' }, path: 'Daily.md', title: 'Daily', language: 'markdown' }),
    ]
    const keepDocs: DocumentInfo[] = [
      doc({ id: 21, source: { kind: 'keep', name: 'keep' }, path: 'Keep/Groceries.json', title: 'Groceries', language: null }),
    ]
    const gdriveDocs: DocumentInfo[] = [
      doc({ id: 31, source: { kind: 'gdrive', name: 'gdrive' }, path: 'Tax/2026.pdf', title: '2026', language: null }),
    ]

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/files?source=obsidian') return json(200, { documents: obsidianDocs, total: 2 })
        if (url === '/api/files?source=keep') return json(200, { documents: keepDocs, total: 1 })
        if (url === '/api/files?source=gdrive') return json(200, { documents: gdriveDocs, total: 1 })
        return json(404, {})
      }),
    )

    const { rerender } = render(<BrowseFilesScreen source="obsidian" />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Obsidian vault' })).toBeTruthy()
    expect(await screen.findByRole('link', { name: /Projects\// })).toBeTruthy()
    expect(screen.getByRole('link', { name: /Daily\.md/ }).getAttribute('href')).toBe('/doc/12')

    window.history.replaceState(null, '', '/sources/keep')
    rerender(<BrowseFilesScreen key="keep" source="keep" />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Google Keep' })).toBeTruthy()
    expect(await screen.findByRole('link', { name: /Groceries/ })).toBeTruthy()

    window.history.replaceState(null, '', '/sources/gdrive')
    rerender(<BrowseFilesScreen key="gdrive" source="gdrive" />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Google Drive' })).toBeTruthy()
    expect(await screen.findByRole('link', { name: /Tax\// })).toBeTruthy()
  })

  it('reads cached files and searches offline', async () => {
    window.history.replaceState(null, '', '/sources/obsidian')
    await offlineDb().documents.put({
      id: 50,
      sourceKind: 'obsidian',
      sourceName: 'vault',
      path: 'Notes/Sourdough.md',
      title: 'Sourdough',
      language: 'markdown',
      allowLlm: true,
      mtime: null,
      updatedAt: '2026-11-26T00:00:00.000Z',
      content: 'Feed the starter with flour and water.',
      truncated: false,
    })
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const fn = vi.fn()
    vi.stubGlobal('fetch', fn)

    render(<BrowseFilesScreen source="obsidian" />)
    expect(await screen.findByText('Saved copy')).toBeTruthy()
    expect(await screen.findByRole('link', { name: /Notes\// })).toBeTruthy()
    expect(fn).not.toHaveBeenCalled()

    const querySection = screen.getByRole('region', { name: 'Search or ask in Obsidian vault' })
    fireEvent.change(within(querySection).getByLabelText('Search in Obsidian vault'), { target: { value: 'starter' } })
    fireEvent.click(within(querySection).getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(within(querySection).getByText('1 result in Obsidian vault')).toBeTruthy())
    expect(within(querySection).getByRole('link', { name: 'Sourdough' }).getAttribute('href')).toBe('/doc/50')
  })
})

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MapScreen } from './MapScreen'
import { resetMapMemory } from './map'

vi.mock('../map/GraphCanvas', () => ({ GraphCanvas: ({ graph }: { graph: { nodes: unknown[] } }) => <div data-testid="vault-canvas">{graph.nodes.length} nodes</div> }))

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const vaultGraph = {
  nodes: [
    { id: 'doc:1', type: 'document', label: 'Pythia README', documentId: 1, source: { kind: 'repo', name: 'pythia' }, sourceLabel: 'pythia', path: 'README.md', allowLlm: true, links: 2 },
    { id: 'tag:typescript', type: 'tag', label: 'typescript', documentId: null, source: null, sourceLabel: null, path: null, allowLlm: null, links: 1 },
    { id: 'repo:1', type: 'repo', label: 'pythia', documentId: null, source: { kind: 'repo', name: 'pythia' }, sourceLabel: 'pythia', path: null, allowLlm: null, links: 1 },
  ],
  edges: [
    { source: 'doc:1', target: 'tag:typescript', kind: 'tag', score: null },
    { source: 'repo:1', target: 'doc:1', kind: 'repo', score: null },
  ],
  truncated: false,
}

function setNarrow(matches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('639px') ? matches : false, media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })))
}

function stubFetch() {
  const calls: Array<{ url: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
    return url.startsWith('/api/graph') ? json(200, vaultGraph) : json(200, { topic: 'focus', branches: [] })
  }))
  return calls
}

describe('MapScreen', () => {
  beforeEach(() => {
    resetMapMemory()
    setNarrow(false)
  })
  afterEach(() => vi.restoreAllMocks())

  it('sends topic, selected source filters and repository filter to the REST API', async () => {
    const calls = stubFetch()
    render(<MapScreen />)
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'focus' } })
    fireEvent.click(screen.getByRole('button', { name: 'Build map' }))
    await screen.findByRole('region', { name: /Map for focus/ })
    expect(calls.some((call) => call.url === '/api/topic-map')).toBe(true)
  })

  it('shows the whole-vault graph with source and repository filters', async () => {
    const calls = stubFetch()
    render(<MapScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'Whole vault' }))
    fireEvent.click(screen.getByRole('button', { name: 'Repos' }))
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'pythia' } })
    await screen.findByTestId('vault-canvas')
    expect(screen.getByText('3 nodes')).toBeTruthy()
    expect(calls).toContainEqual({ url: '/api/graph?sources=repo&repo=pythia', body: null })
  })

  it('uses the document and tag list by default below 640px and offers a graph toggle', async () => {
    const calls = stubFetch()
    setNarrow(true)
    render(<MapScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'Whole vault' }))
    await screen.findByRole('list', { name: 'Whole-vault graph items' })
    expect(screen.getByText('#typescript')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Pythia README' }).getAttribute('href')).toBe('/doc/1')
    fireEvent.click(screen.getByRole('button', { name: 'Show graph' }))
    expect(await screen.findByTestId('vault-canvas')).toBeTruthy()
    expect(calls.some((call) => call.url.startsWith('/api/graph'))).toBe(true)
  })

  it('rebuilds the map when a branch is chosen and shows the offline note for the vault graph', async () => {
    const calls = stubFetch()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) as { topic?: string } : null
      calls.push({ url, body })
      if (url.startsWith('/api/graph')) return json(200, vaultGraph)
      return json(200, {
        topic: body?.topic ?? 'focus',
        branches: [
          {
            label: 'Deep work',
            documents: [
              { documentId: 1, title: 'Note', path: 'Note.md', source: { kind: 'obsidian' }, allowLlm: true },
              { documentId: 2, title: 'Note 2', path: 'Note2.md', source: { kind: 'obsidian' }, allowLlm: true },
            ],
          },
          {
            label: 'Habits',
            documents: [
              { documentId: 3, title: 'Note 3', path: 'Note3.md', source: { kind: 'obsidian' }, allowLlm: true },
              { documentId: 4, title: 'Note 4', path: 'Note4.md', source: { kind: 'obsidian' }, allowLlm: true },
            ],
          },
        ],
      })
    }))
    render(<MapScreen />)
    setNarrow(true)
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'focus' } })
    fireEvent.click(screen.getByRole('button', { name: 'Build map' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Explore Deep work' }))
    await screen.findByRole('region', { name: /Map for Deep work/ })
    expect((screen.getByLabelText('Topic') as HTMLInputElement).value).toBe('Deep work')
    expect(screen.getByText('Inside focus')).toBeTruthy()
    expect(calls.at(-1)).toMatchObject({ url: '/api/topic-map', body: { topic: 'Deep work', context: 'focus' } })

    fireEvent.click(screen.getByRole('button', { name: /Back to focus/ }))
    await screen.findByRole('region', { name: /Map for focus/ })
    expect(calls.at(-1)).toMatchObject({ url: '/api/topic-map', body: { topic: 'focus' } })
    expect((calls.at(-1)?.body as { context?: string }).context).toBeUndefined()

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    fireEvent.click(screen.getByRole('button', { name: 'Whole vault' }))
    expect(screen.getByText('The whole-vault graph needs the server.')).toBeTruthy()
  })

  it('defaults to the 2D mindmap on wide screens, supports 2D/3D/List switching, AI labels, and node filtering', async () => {
    const calls = stubFetch()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) as { topic?: string; aiLabels?: boolean } : null
      calls.push({ url, body })
      return json(200, {
        topic: body?.topic ?? 'job',
        branches: [
          {
            label: body?.aiLabels ? 'Career Planning' : 'just · not',
            documents: [
              { documentId: 1, title: 'Job Search Strategy', path: 'Job Search Strategy.md', source: { kind: 'obsidian', name: 'vault' }, allowLlm: true },
              { documentId: 3, title: 'Resume Checklist', path: 'Resume.md', source: { kind: 'obsidian', name: 'vault' }, allowLlm: true },
            ],
          },
          {
            label: 'Interviews',
            documents: [
              { documentId: 2, title: 'System Design Prep', path: 'Prep.md', source: { kind: 'obsidian', name: 'vault' }, allowLlm: true },
              { documentId: 4, title: 'Behavioral Questions', path: 'Behavioral.md', source: { kind: 'obsidian', name: 'vault' }, allowLlm: true },
            ],
          },
        ],
      })
    }))
    setNarrow(false)
    render(<MapScreen />)
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'job' } })
    fireEvent.click(screen.getByRole('button', { name: 'Build map' }))

    await screen.findByRole('img', { name: /2D mindmap for job/ })
    expect(screen.getByRole('button', { name: 'Full screen' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reset view' })).toBeTruthy()
    expect(screen.getByText('Where these branches come from')).toBeTruthy()
    fireEvent.click(screen.getByText('Where these branches come from'))
    expect(screen.getByRole('link', { name: /Job Search Strategy/ }).getAttribute('href')).toBe('/doc/1')

    // Switch to 3D and List
    fireEvent.click(screen.getByRole('button', { name: '3D' }))
    expect(await screen.findByRole('img', { name: /3D topic map for job/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    expect(screen.getByRole('list', { name: 'Topic map outline' })).toBeTruthy()

    // Quick node filter on Topic Map
    fireEvent.change(screen.getByLabelText('Filter nodes'), { target: { value: 'System Design' } })
    expect(screen.queryByRole('link', { name: /Job Search Strategy/ })).toBeNull()
    expect(screen.getByRole('link', { name: /System Design Prep/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }))

    // AI labels toggle
    fireEvent.click(screen.getByRole('button', { name: 'AI labels' }))
    expect(await screen.findByText('Career Planning')).toBeTruthy()
    expect(calls.at(-1)).toMatchObject({ url: '/api/topic-map', body: { topic: 'job', aiLabels: true } })

    fireEvent.click(screen.getByRole('button', { name: '2D' }))
    expect(await screen.findByRole('img', { name: /2D mindmap for job/ })).toBeTruthy()
  })

  it('provides Filters, Display, Forces, and 2D/3D switcher on Whole Vault', async () => {
    stubFetch()
    setNarrow(false)
    render(<MapScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'Whole vault' }))
    await screen.findByTestId('vault-canvas')

    fireEvent.click(screen.getByRole('button', { name: '2D' }))
    expect(screen.getByRole('button', { name: '2D' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
    expect(screen.getByRole('region', { name: 'Graph filters' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Tags' }))
    expect(screen.getByText('2 nodes')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Display' }))
    expect(screen.getByRole('region', { name: 'Graph display settings' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Arrows' }))

    fireEvent.click(screen.getByRole('button', { name: 'Forces' }))
    expect(screen.getByRole('region', { name: 'Graph force settings' })).toBeTruthy()
    expect(screen.getByLabelText('Center force')).toBeTruthy()
  })

  it('restores the topic map, drill-down trail, and whole-vault view after remounting without refetching', async () => {
    const calls = vi.fn(async (url: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) as { topic?: string } : null
      if (url.startsWith('/api/graph')) return json(200, vaultGraph)
      return json(200, {
        topic: body?.topic ?? 'ikigai',
        branches: [
          {
            label: 'Purpose',
            documents: [
              { documentId: 1, title: 'Ikigai', path: 'Books/Ikigai.md', source: { kind: 'obsidian' }, allowLlm: true },
              { documentId: 2, title: 'Meaning', path: 'Books/Meaning.md', source: { kind: 'obsidian' }, allowLlm: true },
            ],
          },
          {
            label: 'Craft',
            documents: [
              { documentId: 3, title: 'Mastery', path: 'Books/Mastery.md', source: { kind: 'obsidian' }, allowLlm: true },
              { documentId: 4, title: 'Flow', path: 'Books/Flow.md', source: { kind: 'obsidian' }, allowLlm: true },
            ],
          },
        ],
      })
    })
    vi.stubGlobal('fetch', calls)
    setNarrow(true)
    const first = render(<MapScreen />)
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'ikigai' } })
    fireEvent.click(screen.getByRole('button', { name: 'Build map' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Explore Purpose' }))
    await screen.findByRole('region', { name: /Map for Purpose/ })
    expect(calls).toHaveBeenCalledTimes(2)

    first.unmount()
    const second = render(<MapScreen />)
    expect(screen.getByRole('region', { name: /Map for Purpose/ })).toBeTruthy()
    expect(screen.getByText('Inside ikigai')).toBeTruthy()
    expect((screen.getByLabelText('Topic') as HTMLInputElement).value).toBe('Purpose')
    expect(calls).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: 'Whole vault' }))
    await screen.findByRole('list', { name: 'Whole-vault graph items' })
    expect(calls).toHaveBeenCalledTimes(3)

    second.unmount()
    render(<MapScreen />)
    expect(screen.getByRole('list', { name: 'Whole-vault graph items' })).toBeTruthy()
    expect(calls).toHaveBeenCalledTimes(3)
  })
})

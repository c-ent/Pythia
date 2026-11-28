import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MapScreen } from './MapScreen'

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
  beforeEach(() => setNarrow(false))

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
})

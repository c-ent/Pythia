import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalGraphNode, LocalGraphResponse } from '../api/graph'
import { offlineLocalGraph } from '../offline/offlineMap'
import { GRAPH_DEFAULT_QUERY, LocalGraphPanel } from './LocalGraphPanel'

// The offline copy is tested in offlineMap.test.ts; here only what the panel does with it.
vi.mock('../offline/offlineMap', () => ({ offlineLocalGraph: vi.fn(async () => null) }))

// Cytoscape needs a real canvas; the panel's own logic is what is tested here.
vi.mock('./GraphCanvas', () => ({
  GraphCanvas: ({ graph }: { graph: LocalGraphResponse }) => <div data-testid="graph-canvas">{graph.nodes.length} nodes</div>,
}))

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const node = (over: Partial<LocalGraphNode> & Pick<LocalGraphNode, 'id'>): LocalGraphNode => ({
  type: 'document',
  label: over.id,
  documentId: null,
  source: { kind: 'obsidian', name: 'vault' },
  sourceLabel: 'Obsidian',
  path: null,
  allowLlm: true,
  links: 1,
  depth: 1,
  ...over,
})

const body = (over: Partial<LocalGraphResponse> = {}): LocalGraphResponse => ({
  documentId: 7,
  inMap: true,
  center: 'doc:7',
  nodes: [
    node({ id: 'doc:7', label: 'Pythia', documentId: 7, depth: 0, links: 3 }),
    node({ id: 'doc:9', label: 'Bread', documentId: 9, source: { kind: 'keep', name: 'keep' }, sourceLabel: 'Keep', allowLlm: false }),
    node({ id: 'tag:baking', type: 'tag', label: 'baking', source: null, sourceLabel: null, path: null, allowLlm: null }),
    node({ id: 'ghost:1:sourdough', type: 'ghost', label: 'Sourdough', allowLlm: null }),
  ],
  edges: [
    { source: 'doc:7', target: 'doc:9', kind: 'neighbour', score: 0.71 },
    { source: 'doc:7', target: 'tag:baking', kind: 'tag', score: null },
    { source: 'doc:7', target: 'ghost:1:sourdough', kind: 'link', score: null },
  ],
  truncated: false,
  ...over,
})

function stubFetch(respond: () => Response | Promise<Response>) {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url)
      return respond()
    }),
  )
  return urls
}

/** `matchMedia` where the graph-default width matches (wide) or nothing does. */
function stubWidth(wide: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: wide && query === GRAPH_DEFAULT_QUERY,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  )
}

const region = () => screen.getByRole('region', { name: 'Graph' })

describe('LocalGraphPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('asks for the document’s graph and shows the list by default on narrow screens', async () => {
    const urls = stubFetch(() => json(200, body()))
    stubWidth(false)
    render(<LocalGraphPanel id={7} />)

    const bread = await screen.findByRole('link', { name: 'Bread' })
    expect(urls).toEqual(['/api/documents/7/graph'])
    expect(bread.getAttribute('href')).toBe('/doc/9')
    expect(screen.queryByTestId('graph-canvas')).toBeNull()
    expect(within(region()).getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('true')

    // The opened document is not listed; tags and ghosts are text, not links.
    expect(screen.queryByRole('link', { name: 'Pythia' })).toBeNull()
    expect(screen.getByText('#baking')).toBeTruthy()
    expect(screen.getByText('Sourdough').closest('a')).toBeNull()
    expect(screen.getByText('Similar content')).toBeTruthy()
    expect(screen.getByText('Tag on this note')).toBeTruthy()
    expect(screen.getByText('Linked from this note')).toBeTruthy()
    expect(within(region()).getByText('Local only')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Connected directly' })).toBeTruthy()

    // The legend names every colour in the graph.
    const legend = screen.getByRole('list', { name: 'Colours' })
    expect(within(legend).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Obsidian',
      'Keep',
      'Tag',
      'Missing note',
    ])
  })

  it('shows the graph by default on wide screens and switches with the toggle', async () => {
    stubFetch(() => json(200, body()))
    stubWidth(true)
    render(<LocalGraphPanel id={7} />)

    expect((await screen.findByTestId('graph-canvas')).textContent).toBe('4 nodes')
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
    fireEvent.click(screen.getByRole('button', { name: 'Existing files only' }))
    expect(screen.getByTestId('graph-canvas').textContent).toBe('3 nodes')
    fireEvent.click(screen.getByRole('button', { name: '2D' }))
    expect(screen.getByRole('button', { name: '2D' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    expect(screen.queryByTestId('graph-canvas')).toBeNull()
    expect(screen.getByRole('link', { name: 'Bread' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    expect(await screen.findByTestId('graph-canvas')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Graph' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('says when the server cut the graph', async () => {
    stubFetch(() => json(200, body({ truncated: true })))
    stubWidth(false)
    render(<LocalGraphPanel id={7} />)
    expect(await screen.findByText(/Only the best connected items are shown/)).toBeTruthy()
  })

  it('explains a document outside the map, with no toggle', async () => {
    stubFetch(() => json(200, body({ inMap: false, nodes: [], edges: [] })))
    stubWidth(true)
    render(<LocalGraphPanel id={7} />)
    expect(await screen.findByText(/isn’t part of the knowledge map/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'List' })).toBeNull()
    expect(screen.queryByTestId('graph-canvas')).toBeNull()
  })

  it('says when nothing is connected yet', async () => {
    stubFetch(() => json(200, body({ nodes: [body().nodes[0]!], edges: [] })))
    stubWidth(true)
    render(<LocalGraphPanel id={7} />)
    expect(await screen.findByText(/Nothing is connected to this document yet/)).toBeTruthy()
    expect(screen.queryByTestId('graph-canvas')).toBeNull()
  })

  it('shows an error with Retry, and Retry loads again', async () => {
    let calls = 0
    const urls = stubFetch(() => (++calls === 1 ? json(500, { error: { code: 'internal', message: 'boom' } }) : json(200, body())))
    stubWidth(false)
    render(<LocalGraphPanel id={7} />)

    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t load the graph.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('link', { name: 'Bread' })).toBeTruthy()
    expect(urls).toHaveLength(2)
  })

  it('says the server can’t be reached on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    stubWidth(false)
    render(<LocalGraphPanel id={7} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Can’t reach the server')
  })

  it('treats an unexpected answer as an error', async () => {
    stubFetch(() => json(200, { related: [] }))
    stubWidth(false)
    render(<LocalGraphPanel id={7} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t load the graph.')
  })

  it('asks for nothing offline and says it needs a connection when this device has no copy', async () => {
    const urls = stubFetch(() => json(200, body()))
    stubWidth(true)
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    vi.mocked(offlineLocalGraph).mockResolvedValue(null)
    render(<LocalGraphPanel id={7} />)
    expect(await screen.findByText('The graph needs a connection.')).toBeTruthy()
    expect(urls).toEqual([])
  })

  it('builds the graph offline from the synced copy (T72)', async () => {
    const urls = stubFetch(() => json(200, body()))
    stubWidth(false)
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    vi.mocked(offlineLocalGraph).mockResolvedValue(body())
    render(<LocalGraphPanel id={7} />)
    expect(await screen.findByRole('link', { name: 'Bread' })).toBeTruthy()
    expect(offlineLocalGraph).toHaveBeenCalledWith(7)
    expect(urls).toEqual([])
  })
})

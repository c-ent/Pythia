import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { GraphResponse } from '../api/graph'
import { NetworkGraphView } from './NetworkGraphView'

vi.mock('./GraphCanvas', () => ({
  GraphCanvas: ({ title, dimension }: { title?: string; dimension?: string }) => (
    <div data-testid="mock-canvas">{`${title}:${dimension}`}</div>
  ),
}))

const sampleGraph: GraphResponse = {
  nodes: [
    {
      id: 'doc:1',
      type: 'document',
      label: 'Architecture',
      documentId: 1,
      source: { kind: 'obsidian', name: 'vault' },
      sourceLabel: 'Obsidian',
      path: 'Architecture.md',
      allowLlm: true,
      links: 2,
    },
    {
      id: 'tag:design',
      type: 'tag',
      label: 'design',
      documentId: null,
      source: null,
      sourceLabel: null,
      path: null,
      allowLlm: null,
      links: 1,
    },
  ],
  edges: [{ source: 'doc:1', target: 'tag:design', kind: 'tag', score: null }],
  truncated: false,
}

describe('NetworkGraphView', () => {
  it('hides 2D-only Display and Forces controls in 3D mode and shows them in 2D mode', () => {
    const { rerender } = render(
      <NetworkGraphView
        graph={sampleGraph}
        view="graph"
        dimension="3d"
        canvasTitle="Vault Atlas"
        renderList={() => <div>list</div>}
      />,
    )

    expect(screen.getByRole('button', { name: 'Filters' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Display' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Forces' })).toBeNull()

    rerender(
      <NetworkGraphView
        graph={sampleGraph}
        view="graph"
        dimension="2d"
        canvasTitle="Vault Network"
        renderList={() => <div>list</div>}
      />,
    )

    expect(screen.getByRole('button', { name: 'Display' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Forces' })).toBeTruthy()
  })

  it('renders the legend and delegates list view through renderList', () => {
    render(
      <NetworkGraphView
        graph={sampleGraph}
        view="list"
        dimension="2d"
        canvasTitle="Vault Network"
        renderList={(filtered) => <div data-testid="custom-list">{filtered.nodes.length}</div>}
      />,
    )

    expect(screen.getByTestId('custom-list').textContent).toBe('2')
    expect(screen.getByRole('list', { name: 'Graph colours' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Display' })).toBeNull()
  })
})

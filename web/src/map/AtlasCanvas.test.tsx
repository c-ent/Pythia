import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AtlasCanvas } from './AtlasCanvas'
import { buildTopicAtlasGraph } from './atlas3d'
import { safeTopicBranches } from './topicMapModel'

function mockCanvasContext() {
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    roundRect: vi.fn(),
    setLineDash: vi.fn(),
    strokeText: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 6 })),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    textAlign: 'center',
    textBaseline: 'top',
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
  return ctx
}

describe('AtlasCanvas', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders HUD title, interaction hint, zoom/reset buttons and handles zoom and keyboard controls', () => {
    const ctx = mockCanvasContext()
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const branches = safeTopicBranches([
      {
        label: 'career',
        documents: [
          { documentId: 1, source: { kind: 'obsidian', name: 'vault' }, path: 'Note.md', title: 'Note', allowLlm: true },
        ],
      },
    ])
    const atlas = buildTopicAtlasGraph('job', branches)
    const onSelectBranch = vi.fn()

    render(
      <AtlasCanvas
        nodes={atlas.nodes}
        edges={atlas.edges}
        worldRadius={atlas.worldRadius}
        title="TOPIC MAP · job"
        subtitle="1 document · 1 branch"
        ariaLabel="3D topic map"
        onSelectBranch={onSelectBranch}
      />,
    )

    expect(screen.getByText(/TOPIC MAP · job/i)).toBeTruthy()
    expect(screen.getByText(/DRAG - rotate/i)).toBeTruthy()
    const canvas = screen.getByRole('img', { name: '3D topic map' })
    expect(canvas).toBeTruthy()

    const zoomIn = screen.getByRole('button', { name: 'Zoom in' })
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' })
    const reset = screen.getByRole('button', { name: 'Reset view' })

    const callsBefore = ctx.fillRect.mock.calls.length
    fireEvent.click(zoomIn)
    fireEvent.click(zoomOut)
    fireEvent.click(reset)
    fireEvent.wheel(canvas, { deltaY: -120 })
    fireEvent.keyDown(canvas, { key: '+' })
    fireEvent.keyDown(canvas, { key: '-' })
    fireEvent.keyDown(canvas, { key: 'ArrowRight' })
    fireEvent.keyDown(canvas, { key: '0' })

    expect(ctx.fillRect.mock.calls.length).toBeGreaterThan(callsBefore)
  })
})

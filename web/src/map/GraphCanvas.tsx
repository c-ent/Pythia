import cytoscape from 'cytoscape'
import { Lock, Maximize2, Minus, Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { GraphNode, GraphResponse } from '../api/graph'
import { documentPath, navigate } from '../router'
import { NODE_TONES, TONE_LABELS, nodeTone, toElements } from './graphModel'

// The Cytoscape canvas for a knowledge map graph (R20, T71). This module is
// only reached through a lazy import, so Cytoscape gets its own chunk and the
// app shell, Search and the list view never load it.

const ZOOM_STEP = 1.25
const PADDING = 24

/** Reads a theme token from the page, so the graph follows Light and Dark like the rest of the app. */
function token(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(`--${name}`).trim() || fallback
}

function buildStyle(): cytoscape.StylesheetJson {
  const styles = getComputedStyle(document.documentElement)
  const color = (name: string, fallback: string): string => token(styles, `color-${name}`, fallback)
  const ink = color('ink', '#0f0f10')
  const line = color('line', '#dadad5')
  const surface = color('surface', '#ffffff')
  const font = token(styles, 'font-sans', 'sans-serif')
  return [
    {
      selector: 'node',
      style: {
        width: 'data(size)',
        height: 'data(size)',
        label: 'data(label)',
        color: ink,
        'font-family': font,
        'font-size': 11,
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'text-wrap': 'none',
        'text-background-color': surface,
        'text-background-opacity': 0.85,
        'text-background-padding': '2px',
        'text-background-shape': 'roundrectangle',
        'border-width': 0,
      },
    },
    ...NODE_TONES.map((tone) => ({
      selector: `node[tone = "${tone}"]`,
      style: { 'background-color': color(`map-${tone}`, '#85857f') },
    })),
    { selector: 'node[type = "tag"]', style: { shape: 'diamond' } },
    { selector: 'node[type = "repo"]', style: { shape: 'round-rectangle' } },
    {
      selector: 'node[type = "ghost"]',
      style: { 'background-opacity': 0.45, 'border-width': 1.5, 'border-style': 'dashed', 'border-color': color('map-ghost', '#85857f') },
    },
    { selector: 'node[center = "yes"]', style: { 'border-width': 3, 'border-color': ink, 'font-weight': 600 } },
    {
      selector: 'edge',
      style: { width: 1.5, 'line-color': line, 'curve-style': 'straight', opacity: 0.9 },
    },
    {
      selector: 'edge[kind = "link"]',
      style: { width: 2, 'target-arrow-shape': 'triangle', 'target-arrow-color': line, 'arrow-scale': 0.8 },
    },
    { selector: 'edge[kind = "neighbour"]', style: { 'line-style': 'dashed' } },
  ]
}

interface Preview {
  node: GraphNode
  x: number
  y: number
}

function previewKind(node: GraphNode): string {
  if (node.type === 'document') return node.sourceLabel ?? TONE_LABELS[nodeTone(node)]
  if (node.type === 'ghost') return 'Missing note: nothing has this name yet'
  return TONE_LABELS[nodeTone(node)]
}

/**
 * Force-directed graph: colour by source, size by links, click (tap) opens a
 * document, hover (long press on touch) shows a preview, zoom and pan with the
 * wheel, pinch or the buttons. Tags, repos and ghosts do not open anything.
 */
export function GraphCanvas({ graph, center }: { graph: Pick<GraphResponse, 'nodes' | 'edges'>; center?: string }) {
  const container = useRef<HTMLDivElement>(null)
  const cyRef = useRef<cytoscape.Core | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)

  useEffect(() => {
    const element = container.current
    if (element === null) return
    const byId = new Map(graph.nodes.map((node) => [node.id, node]))
    const cy = cytoscape({
      container: element,
      elements: toElements(graph, center),
      style: buildStyle(),
      layout: {
        name: 'cose',
        animate: false,
        fit: true,
        padding: PADDING,
        nodeDimensionsIncludeLabels: true,
        idealEdgeLength: () => 80,
        nodeRepulsion: () => 8000,
      },
      minZoom: 0.2,
      maxZoom: 3,
      boxSelectionEnabled: false,
      autoungrabify: false,
    })
    cyRef.current = cy

    const show = (event: cytoscape.EventObject): void => {
      const node = byId.get(event.target.id() as string)
      if (node === undefined) return
      const { x, y } = event.target.renderedPosition() as { x: number; y: number }
      setPreview({ node, x, y })
    }
    // A long press shows the preview; the tap that ends it must not open the document.
    let held = false
    cy.on('mouseover', 'node', (event) => {
      show(event)
      const node = byId.get(event.target.id() as string)
      element.style.cursor = node?.type === 'document' ? 'pointer' : 'default'
    })
    cy.on('mouseout', 'node', () => {
      setPreview(null)
      element.style.cursor = 'default'
    })
    cy.on('taphold', 'node', (event) => {
      held = true
      show(event)
    })
    cy.on('tap', 'node', (event) => {
      if (held) {
        held = false
        return
      }
      const node = byId.get(event.target.id() as string)
      if (node?.type === 'document' && node.documentId !== null && node.id !== center) {
        navigate(documentPath(node.documentId))
      }
    })
    cy.on('tap', (event) => {
      if (event.target === cy) setPreview(null)
    })
    cy.on('pan zoom', () => setPreview(null))

    // Light / Dark / System all end up as `data-theme` on <html>.
    const observer = new MutationObserver(() => cy.style(buildStyle()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    return () => {
      observer.disconnect()
      cy.destroy()
      cyRef.current = null
    }
  }, [center, graph])

  const zoomBy = (factor: number): void => {
    const cy = cyRef.current
    if (cy === null) return
    cy.zoom({ level: cy.zoom() * factor, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } })
  }
  const fit = (): void => {
    cyRef.current?.fit(undefined, PADDING)
  }

  return (
    <div className="relative">
      <div
        ref={container}
        role="img"
        aria-label={`Graph with ${graph.nodes.length} items. The list view has the same items.`}
        className="h-88 w-full overflow-hidden rounded-control border border-line bg-canvas md:h-112"
      />
      <div className="absolute top-2 right-2 flex flex-col gap-1">
        <ZoomButton label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>
          <Plus aria-hidden="true" className="size-4" />
        </ZoomButton>
        <ZoomButton label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>
          <Minus aria-hidden="true" className="size-4" />
        </ZoomButton>
        <ZoomButton label="Fit graph" onClick={fit}>
          <Maximize2 aria-hidden="true" className="size-4" />
        </ZoomButton>
      </div>
      {preview === null ? null : <NodePreview preview={preview} />}
    </div>
  )
}

function ZoomButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-11 items-center justify-center rounded-control border border-line bg-surface text-ink transition-colors hover:bg-raised"
    >
      {children}
    </button>
  )
}

function NodePreview({ preview }: { preview: Preview }) {
  const { node } = preview
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-10 max-w-64 -translate-x-1/2 rounded-control border border-line bg-surface px-3 py-2 text-sm shadow-[0_4px_16px_rgb(15_15_16/0.12)]"
      style={{ left: preview.x, top: preview.y + 18 }}
    >
      <p className="font-medium wrap-break-word text-ink">{node.label}</p>
      <p className="mt-0.5 text-xs text-muted">{previewKind(node)}</p>
      {node.path === null ? null : <p className="mt-0.5 truncate font-mono text-xs text-muted">{node.path}</p>}
      {node.allowLlm === false ? (
        <p className="mt-1 inline-flex items-center gap-1 text-xs text-muted">
          <Lock className="size-3.5" />
          Local only
        </p>
      ) : null}
      <p className="mt-0.5 text-xs text-muted">
        {node.links} {node.links === 1 ? 'link' : 'links'}
      </p>
    </div>
  )
}

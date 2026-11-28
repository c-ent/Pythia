import { Lock } from 'lucide-react'
import type { KeyboardEvent, PointerEvent, WheelEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GraphNode, GraphResponse } from '../api/graph'
import { documentPath, navigate, repoPath } from '../router'
import { buildForce2DLayout, type Node2D } from './force2d'
import {
  DEFAULT_GRAPH_DISPLAY,
  DEFAULT_GRAPH_FORCES,
  type GraphDisplaySettings,
  type GraphForceSettings,
} from './graphControls'
import { nodeTone, TONE_LABELS, type NodeTone } from './graphModel'
import { GraphViewportChrome } from './GraphViewportChrome'

const ZOOM_STEP = 1.25
const MIN_ZOOM = 0.25
const MAX_ZOOM = 4

const TONE_COLORS: Record<NodeTone | 'center', string> = {
  center: '#f2f5fa',
  obsidian: '#b794f6',
  keep: '#f5b454',
  gdrive: '#7ab4ff',
  repo: '#5fd3a8',
  tag: '#f48fb1',
  ghost: '#8a909b',
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function nodeDestination(node: GraphNode): string | null {
  if (node.type === 'document' && node.documentId !== null) return documentPath(node.documentId)
  if (node.type === 'repo') return repoPath(node.label)
  return null
}

/**
 * Interactive 2D force-directed network graph canvas for Whole-Vault and
 * Document Local graphs (T89, T90).
 */
export function GraphCanvas2D({
  graph,
  center,
  title = '2D Network',
  subtitle,
  ariaLabel,
  heightClassName = 'h-88 md:h-112',
  display = DEFAULT_GRAPH_DISPLAY,
  forces = DEFAULT_GRAPH_FORCES,
  layoutVersion = 0,
}: {
  graph: Pick<GraphResponse, 'nodes' | 'edges'>
  center?: string
  title?: string
  subtitle?: string
  ariaLabel?: string
  heightClassName?: string
  display?: GraphDisplaySettings
  forces?: GraphForceSettings
  layoutVersion?: number
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const layout = useMemo(
    () => buildForce2DLayout(graph, forces, center, layoutVersion),
    [center, forces, graph, layoutVersion],
  )
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 760, height: 480 })
  const [transform, setTransform] = useState<{ x: number; y: number; zoom: number }>({ x: 0, y: 0, zoom: 1 })
  const [hovered, setHovered] = useState<Node2D | null>(null)
  const [dragging, setDragging] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const dragRef = useRef<{ active: boolean; pointerId: number | null; lastX: number; lastY: number; moved: boolean }>({
    active: false,
    pointerId: null,
    lastX: 0,
    lastY: 0,
    moved: false,
  })

  useEffect(() => {
    const el = wrapperRef.current
    if (el === null) return
    const update = (): void => {
      const rect = el.getBoundingClientRect()
      setSize({
        width: Math.max(240, rect.width || 760),
        height: Math.max(200, rect.height || 480),
      })
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [fullscreen])

  useEffect(() => {
    if (!fullscreen) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    const { width, height } = size
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const targetW = Math.round(width * dpr)
    const targetH = Math.round(height * dpr)
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW
      canvas.height = targetH
    }

    ctx.save()
    ctx.scale(dpr, dpr)

    const bg = ctx.createRadialGradient(width * 0.5, height * 0.5, 20, width * 0.5, height * 0.5, Math.max(width, height) * 0.72)
    bg.addColorStop(0, '#12151d')
    bg.addColorStop(0.6, '#090b10')
    bg.addColorStop(1, '#050608')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, width, height)

    const cx = width / 2 + transform.x
    const cy = height / 2 + transform.y
    const zoom = transform.zoom
    const byId = new Map(layout.nodes.map((n) => [n.id, n]))

    // Edges
    ctx.lineCap = 'round'
    for (const edge of layout.edges) {
      const from = byId.get(edge.source)
      const to = byId.get(edge.target)
      if (!from || !to) continue
      const x1 = cx + from.x * zoom
      const y1 = cy + from.y * zoom
      const x2 = cx + to.x * zoom
      const y2 = cy + to.y * zoom
      const isHighlighted = hovered !== null && (hovered.id === from.id || hovered.id === to.id)
      ctx.save()
      ctx.beginPath()
      if (edge.kind === 'neighbour') ctx.setLineDash([4, 4])
      ctx.strokeStyle = isHighlighted ? 'rgba(204, 255, 0, 0.75)' : 'rgba(148, 163, 184, 0.28)'
      ctx.lineWidth = (isHighlighted ? 1.8 : 1.1) * display.linkThickness
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()

      if (display.arrows) {
        const angle = Math.atan2(y2 - y1, x2 - x1)
        const targetR = to.radius * display.nodeSize * zoom + 4
        const ax = x2 - Math.cos(angle) * targetR
        const ay = y2 - Math.sin(angle) * targetR
        const arrowLen = 6 * Math.min(1.4, Math.max(0.8, display.linkThickness))
        ctx.setLineDash([])
        ctx.beginPath()
        ctx.moveTo(ax, ay)
        ctx.lineTo(ax - Math.cos(angle - 0.45) * arrowLen, ay - Math.sin(angle - 0.45) * arrowLen)
        ctx.lineTo(ax - Math.cos(angle + 0.45) * arrowLen, ay - Math.sin(angle + 0.45) * arrowLen)
        ctx.closePath()
        ctx.fillStyle = isHighlighted ? 'rgba(204, 255, 0, 0.85)' : 'rgba(148, 163, 184, 0.48)'
        ctx.fill()
      }
      ctx.restore()
    }

    // Nodes
    const placedLabels: Array<{ x: number; y: number; w: number; h: number }> = []
    const sortedForLabels = [...layout.nodes].sort((a, b) => (a.isCenter ? -1 : b.isCenter ? 1 : b.node.links - a.node.links))

    for (const item of layout.nodes) {
      const sx = cx + item.x * zoom
      const sy = cy + item.y * zoom
      const r = item.radius * display.nodeSize * clamp(zoom, 0.75, 1.4)
      const tone = item.isCenter ? 'center' : nodeTone(item.node)
      const color = TONE_COLORS[tone]
      const isHovered = hovered?.id === item.id

      ctx.save()
      ctx.beginPath()
      ctx.arc(sx, sy, r, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      if (item.isCenter || isHovered) {
        ctx.lineWidth = 2
        ctx.strokeStyle = isHovered ? '#ccff00' : '#ffffff'
        ctx.stroke()
      }
      ctx.restore()
    }

    // Labels according to labelDensity (0 sparse, 1 balanced, 2 dense)
    ctx.font = '12px system-ui, -apple-system, sans-serif'
    ctx.textBaseline = 'middle'
    for (const item of sortedForLabels) {
      const isHovered = hovered?.id === item.id
      if (display.labelDensity === 0 && !item.isCenter && !isHovered && item.node.links < 3) continue
      const sx = cx + item.x * zoom
      const sy = cy + item.y * zoom
      const r = item.radius * display.nodeSize * clamp(zoom, 0.75, 1.4)
      const label = item.node.type === 'tag' ? `#${item.node.label}` : item.node.label
      const short = label.length > 26 ? `${label.slice(0, 25)}…` : label
      const w = ctx.measureText(short).width + 8
      const h = 16
      const lx = sx + r + 6
      const ly = sy - h / 2

      if (display.labelDensity < 2 && !item.isCenter && !isHovered) {
        const collides = placedLabels.some((box) => !(lx + w < box.x || lx > box.x + box.w || ly + h < box.y || ly > box.y + box.h))
        if (collides) continue
      }
      placedLabels.push({ x: lx, y: ly, w, h })
      ctx.fillStyle = isHovered ? '#ccff00' : '#e2e8f0'
      ctx.fillText(short, lx, sy)
    }

    ctx.restore()
  }, [display.arrows, display.labelDensity, display.linkThickness, display.nodeSize, hovered, layout.edges, layout.nodes, size, transform.x, transform.y, transform.zoom])

  useEffect(() => {
    draw()
  }, [draw])

  const hitTest = (clientX: number, clientY: number): Node2D | null => {
    const canvas = canvasRef.current
    if (canvas === null) return null
    const rect = canvas.getBoundingClientRect()
    const px = clientX - rect.left
    const py = clientY - rect.top
    const cx = size.width / 2 + transform.x
    const cy = size.height / 2 + transform.y
    const zoom = transform.zoom
    let best: Node2D | null = null
    let bestDist = Infinity
    for (const item of layout.nodes) {
      const sx = cx + item.x * zoom
      const sy = cy + item.y * zoom
      const r = Math.max(12, item.radius * display.nodeSize * zoom + 6)
      const d = Math.hypot(px - sx, py - sy)
      if (d <= r && d < bestDist) {
        best = item
        bestDist = d
      }
    }
    return best
  }

  const zoomBy = (factor: number): void => {
    setTransform((prev) => ({
      ...prev,
      zoom: clamp(prev.zoom * factor, MIN_ZOOM, MAX_ZOOM),
    }))
  }

  const resetView = (): void => {
    setTransform({ x: 0, y: 0, zoom: 1 })
  }

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0) return
    dragRef.current = { active: true, pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY, moved: false }
    setDragging(true)
  }

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>): void => {
    if (dragRef.current.active && dragRef.current.pointerId === event.pointerId) {
      const dx = event.clientX - dragRef.current.lastX
      const dy = event.clientY - dragRef.current.lastY
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragRef.current.moved = true
      dragRef.current.lastX = event.clientX
      dragRef.current.lastY = event.clientY
      setTransform((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }))
      return
    }
    setHovered(hitTest(event.clientX, event.clientY))
  }

  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>): void => {
    if (dragRef.current.pointerId === event.pointerId) {
      const moved = dragRef.current.moved
      dragRef.current.active = false
      dragRef.current.pointerId = null
      setDragging(false)
      if (!moved) {
        const hit = hitTest(event.clientX, event.clientY)
        if (hit !== null) {
          const dest = nodeDestination(hit.node)
          if (dest !== null) navigate(dest)
          else setHovered(hit)
        }
      }
    }
  }

  const onWheel = (event: WheelEvent<HTMLCanvasElement>): void => {
    event.preventDefault()
    zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>): void => {
    if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      zoomBy(ZOOM_STEP)
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault()
      zoomBy(1 / ZOOM_STEP)
    } else if (event.key === '0') {
      event.preventDefault()
      resetView()
    }
  }

  return (
    <GraphViewportChrome
      wrapperRef={wrapperRef}
      fullscreen={fullscreen}
      onFullscreenChange={setFullscreen}
      title={title}
      subtitle={subtitle}
      interactionHint="DRAG - pan   SCROLL - zoom"
      heightClassName={heightClassName}
      onZoomIn={() => zoomBy(ZOOM_STEP)}
      onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
      onResetView={resetView}
    >
      <canvas
        ref={canvasRef}
        role="img"
        tabIndex={0}
        aria-label={ariaLabel ?? `2D graph with ${graph.nodes.length} items. The list view has the same items.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setHovered(null)}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        className={`block h-full w-full touch-none select-none focus-visible:outline-2 focus-visible:outline-accent ${dragging ? 'cursor-grabbing' : hovered ? 'cursor-pointer' : 'cursor-grab'}`}
      />

      {hovered !== null ? (
        <div className="pointer-events-none absolute bottom-3 left-3.5 max-w-sm rounded-control border border-nav-line bg-nav/90 px-3 py-2 text-xs text-nav-ink backdrop-blur-sm">
          <p className="truncate font-medium">{hovered.node.type === 'tag' ? `#${hovered.node.label}` : hovered.node.label}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-nav-muted">
            <span>{hovered.node.sourceLabel ?? TONE_LABELS[nodeTone(hovered.node)]}</span>
            <span>{hovered.node.links} {hovered.node.links === 1 ? 'connection' : 'connections'}</span>
            {hovered.node.allowLlm === false ? (
              <span className="inline-flex items-center gap-1"><Lock aria-hidden="true" className="size-3" />Local only</span>
            ) : null}
          </p>
        </div>
      ) : null}
    </GraphViewportChrome>
  )
}

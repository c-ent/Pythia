import { Maximize2, Minimize2, Minus, Plus, RotateCcw } from 'lucide-react'
import type { KeyboardEvent, PointerEvent, ReactNode, WheelEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { documentPath, navigate } from '../router'
import { buildTopicMindmapLayout, type MindmapNode } from './mindmapLayout'
import { topicMapDocuments, type PartitionedTopicMap, type VisibleTopicBranch } from './topicMapModel'

const ZOOM_STEP = 1.25
const MIN_ZOOM = 0.35
const MAX_ZOOM = 3.2

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function collectNodes(root: MindmapNode): MindmapNode[] {
  const result: MindmapNode[] = []
  const visit = (node: MindmapNode): void => {
    result.push(node)
    for (const child of node.children) visit(child)
  }
  visit(root)
  return result
}

function bezierPath(fromX: number, fromY: number, toX: number, toY: number): string {
  const midX = (fromX + toX) / 2
  return `M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`
}

/**
 * Interactive 2D horizontal branching mindmap (Markmap-style) for Topic Map:
 * balanced left/right curved branches, colored underlines, pan, zoom, and
 * clickable branch drill-down or document links.
 */
export function TopicMindmap({
  topic,
  branches,
  partitioned,
  onBranch,
}: {
  topic: string
  branches: readonly VisibleTopicBranch[]
  partitioned: PartitionedTopicMap
  onBranch: (label: string) => void
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const layout = useMemo(() => buildTopicMindmapLayout(topic, partitioned), [partitioned, topic])
  const allNodes = useMemo(() => collectNodes(layout.root), [layout.root])
  const docCount = useMemo(() => topicMapDocuments(branches).length, [branches])
  const branchCount = partitioned.branches.length
  const docLabel = `${docCount} ${docCount === 1 ? 'document' : 'documents'}`
  const branchLabel = branchCount > 0 ? `${branchCount} ${branchCount === 1 ? 'branch' : 'branches'}` : null

  const [size, setSize] = useState<{ width: number; height: number }>({ width: 760, height: 520 })
  const [transformOverride, setTransformOverride] = useState<{
    key: string
    value: { x: number; y: number; zoom: number }
  } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const dragRef = useRef<{ active: boolean; pointerId: number | null; lastX: number; lastY: number; moved: boolean }>({
    active: false,
    pointerId: null,
    lastX: 0,
    lastY: 0,
    moved: false,
  })

  const computeFitTransform = useCallback(
    (width: number, height: number) => {
      const { minX, minY, width: bw, height: bh } = layout.bounds
      const padX = 48
      const padY = 64
      const usableW = Math.max(160, width - padX)
      const usableH = Math.max(140, height - padY)
      const zoom = clamp(Math.min(usableW / bw, usableH / bh), MIN_ZOOM, 1.35)
      const cx = minX + bw / 2
      const cy = minY + bh / 2
      return {
        x: width / 2 - cx * zoom,
        y: height / 2 - cy * zoom,
        zoom,
      }
    },
    [layout.bounds],
  )

  const layoutKey = `${topic}:${size.width}:${size.height}:${layout.bounds.width}:${layout.bounds.height}`
  const transform = useMemo(
    () => (transformOverride !== null && transformOverride.key === layoutKey ? transformOverride.value : computeFitTransform(size.width, size.height)),
    [computeFitTransform, layoutKey, size.height, size.width, transformOverride],
  )

  const updateTransform = (updater: (prev: { x: number; y: number; zoom: number }) => { x: number; y: number; zoom: number }): void => {
    setTransformOverride((prev) => {
      const base = prev !== null && prev.key === layoutKey ? prev.value : computeFitTransform(size.width, size.height)
      return { key: layoutKey, value: updater(base) }
    })
  }

  useEffect(() => {
    const el = wrapperRef.current
    if (el === null) return
    const update = (): void => {
      const rect = el.getBoundingClientRect()
      const w = Math.max(240, rect.width || 760)
      const h = Math.max(200, rect.height || 520)
      setSize({ width: w, height: h })
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

  const zoomBy = (factor: number): void => {
    updateTransform((prev) => {
      const nextZoom = clamp(prev.zoom * factor, MIN_ZOOM, MAX_ZOOM)
      const ratio = nextZoom / prev.zoom
      const cx = size.width / 2
      const cy = size.height / 2
      return {
        zoom: nextZoom,
        x: cx - (cx - prev.x) * ratio,
        y: cy - (cy - prev.y) * ratio,
      }
    })
  }

  const resetView = (): void => {
    setTransformOverride(null)
  }

  const onPointerDown = (event: PointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return
    dragRef.current = {
      active: true,
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
    }
    setDragging(true)
  }

  const onPointerMove = (event: PointerEvent<SVGSVGElement>): void => {
    if (!dragRef.current.active || dragRef.current.pointerId !== event.pointerId) return
    const dx = event.clientX - dragRef.current.lastX
    const dy = event.clientY - dragRef.current.lastY
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragRef.current.moved = true
    dragRef.current.lastX = event.clientX
    dragRef.current.lastY = event.clientY
    updateTransform((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }))
  }

  const onPointerUp = (event: PointerEvent<SVGSVGElement>): void => {
    if (dragRef.current.pointerId !== event.pointerId) return
    dragRef.current.active = false
    dragRef.current.pointerId = null
    setDragging(false)
  }

  const onWheel = (event: WheelEvent<SVGSVGElement>): void => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const px = event.clientX - rect.left
    const py = event.clientY - rect.top
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
    updateTransform((prev) => {
      const nextZoom = clamp(prev.zoom * factor, MIN_ZOOM, MAX_ZOOM)
      const ratio = nextZoom / prev.zoom
      return {
        zoom: nextZoom,
        x: px - (px - prev.x) * ratio,
        y: py - (py - prev.y) * ratio,
      }
    })
  }

  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>): void => {
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

  const activateNode = (node: MindmapNode): void => {
    if (dragRef.current.moved) return
    if (node.documentId !== null) {
      navigate(documentPath(node.documentId))
    } else if (node.branchQuery !== null) {
      onBranch(node.branchQuery)
    }
  }

  return (
    <div
      ref={wrapperRef}
      className={
        fullscreen
          ? 'fixed inset-0 z-50 m-0 h-dvh w-dvw overflow-hidden bg-nav'
          : 'relative mt-4 h-[62dvh] min-h-104 w-full overflow-hidden rounded-control border border-nav-line bg-nav md:h-[68dvh]'
      }
    >
      <svg
        role="img"
        tabIndex={0}
        aria-label={`2D mindmap for ${topic} with ${branchLabel === null ? docLabel : `${branchLabel} and ${docLabel}`}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        className={`block h-full w-full touch-none select-none focus-visible:outline-2 focus-visible:outline-accent ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      >
        <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.zoom})`}>
          {layout.edges.map((edge) => (
            <path
              key={edge.id}
              d={bezierPath(edge.fromX, edge.fromY, edge.toX, edge.toY)}
              fill="none"
              stroke={edge.color}
              strokeWidth={2}
              strokeLinecap="round"
              opacity={0.9}
            />
          ))}

          {allNodes.map((node) => {
            if (node.kind === 'root') {
              return (
                <g key={node.id}>
                  <title>{node.fullLabel}</title>
                  <rect
                    x={node.x}
                    y={-21}
                    width={node.width}
                    height={42}
                    rx={8}
                    fill="#f2f5fa"
                    stroke="#6366f1"
                    strokeWidth={1.5}
                  />
                  <text
                    x={node.x + node.width / 2}
                    y={1}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="#0f0f10"
                    fontSize={15}
                    fontWeight={600}
                  >
                    {node.label}
                  </text>
                </g>
              )
            }

            const isClickable = node.documentId !== null || node.branchQuery !== null
            const isLeafDoc = node.kind === 'document'
            const underlineY = node.y + 8
            const underlineX1 = node.side === 'right' ? node.inX : node.x
            const underlineX2 = node.side === 'right' ? node.x + node.width : node.inX
            const textX = node.side === 'right' ? node.x + 5 : node.inX - 5

            return (
              <g
                key={node.id}
                role={isClickable ? 'button' : undefined}
                tabIndex={isClickable ? 0 : undefined}
                aria-label={isClickable ? node.fullLabel : undefined}
                onClick={isClickable ? () => activateNode(node) : undefined}
                onKeyDown={
                  isClickable
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          activateNode(node)
                        }
                      }
                    : undefined
                }
                className={isClickable ? 'cursor-pointer' : undefined}
              >
                <title>{node.fullLabel}</title>
                <line
                  x1={underlineX1}
                  y1={underlineY}
                  x2={underlineX2}
                  y2={underlineY}
                  stroke={node.color}
                  strokeWidth={2}
                  strokeLinecap="round"
                />
                {node.children.length > 0 ? (
                  <circle cx={node.outX} cy={node.y} r={3.5} fill={node.color} />
                ) : null}
                <text
                  x={textX}
                  y={node.y - 2}
                  textAnchor={node.side === 'right' ? 'start' : 'end'}
                  dominantBaseline="auto"
                  fill={isLeafDoc ? '#93c5fd' : '#f2f5fa'}
                  fontSize={13}
                  fontWeight={isLeafDoc ? 400 : 500}
                >
                  {node.label}
                </text>
              </g>
            )
          })}
        </g>
      </svg>

      {/* Top-left HUD header */}
      <div className="pointer-events-none absolute top-3 left-3.5 flex max-w-[60%] items-center gap-2.5">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)]" />
        <p className="truncate font-mono text-xs tracking-wider text-nav-ink uppercase">
          MINDMAP · {topic}
          <span className="ml-2 font-normal text-nav-muted normal-case">
            {branchLabel === null ? docLabel : `${docLabel} · ${branchLabel}`}
          </span>
        </p>
      </div>

      {/* Top-right interaction hint, fullscreen toggle and zoom/reset buttons */}
      <div className="absolute top-2.5 right-2.5 flex items-start gap-2.5">
        <p className="pointer-events-none hidden pt-2 font-mono text-[11px] tracking-wider text-nav-muted md:block">
          DRAG - pan &nbsp; SCROLL - zoom{fullscreen ? '   ESC - exit' : ''}
        </p>
        <div className="flex flex-col items-end gap-1.5">
          {fullscreen ? (
            <button
              type="button"
              aria-label="Exit full screen"
              aria-pressed={true}
              title="Exit full screen (Esc)"
              onClick={() => setFullscreen(false)}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-nav-line bg-nav/85 px-3 text-xs font-medium text-nav-ink backdrop-blur-sm transition-colors hover:bg-nav-raised"
            >
              <Minimize2 aria-hidden="true" className="size-4" />
              <span>Exit</span>
            </button>
          ) : (
            <MindmapButton label="Full screen" pressed={false} onClick={() => setFullscreen(true)}>
              <Maximize2 aria-hidden="true" className="size-4" />
            </MindmapButton>
          )}
          <MindmapButton label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>
            <Plus aria-hidden="true" className="size-4" />
          </MindmapButton>
          <MindmapButton label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>
            <Minus aria-hidden="true" className="size-4" />
          </MindmapButton>
          <MindmapButton label="Reset view" onClick={resetView}>
            <RotateCcw aria-hidden="true" className="size-4" />
          </MindmapButton>
        </div>
      </div>
    </div>
  )
}

function MindmapButton({ label, pressed, onClick, children }: { label: string; pressed?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      className="inline-flex size-11 items-center justify-center rounded-control border border-nav-line bg-nav/85 text-nav-ink backdrop-blur-sm transition-colors hover:bg-nav-raised"
    >
      {children}
    </button>
  )
}

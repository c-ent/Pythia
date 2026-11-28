import { Compass, Lock, Maximize2, Minimize2, Minus, Plus, RotateCcw } from 'lucide-react'
import type { KeyboardEvent, PointerEvent, ReactNode, WheelEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SourceKind } from '../api/search'
import { documentPath, navigate } from '../router'
import { SOURCE_LABELS } from '../search/format'
import { buildTopicMindmapLayout, type MindmapNode } from './mindmapLayout'
import { topicMapDocuments, type PartitionedTopicMap, type VisibleTopicBranch } from './topicMapModel'

const ZOOM_STEP = 1.25
const MIN_ZOOM = 0.35
const MAX_ZOOM = 3.2

const SOURCE_DOT_COLORS: Record<SourceKind, string> = {
  obsidian: '#b794f6',
  keep: '#f5b454',
  gdrive: '#7ab4ff',
  repo: '#5fd3a8',
}

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
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null)
  const [hoveredDoc, setHoveredDoc] = useState<MindmapNode | null>(null)
  const layout = useMemo(() => buildTopicMindmapLayout(topic, partitioned, collapsedIds), [collapsedIds, partitioned, topic])
  const allNodes = useMemo(() => collectNodes(layout.root), [layout.root])
  const selectedBranch = useMemo(
    () => (selectedBranchId === null ? null : allNodes.find((node) => node.id === selectedBranchId && node.branchQuery !== null) ?? null),
    [allNodes, selectedBranchId],
  )
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

  const toggleCollapse = (nodeId: string): void => {
    setCollapsedIds((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }

  const activateNode = (node: MindmapNode): void => {
    if (dragRef.current.moved) return
    if (node.documentId !== null) {
      navigate(documentPath(node.documentId))
    } else if (node.kind === 'branch') {
      setSelectedBranchId(node.id)
      if (node.hasChildren) toggleCollapse(node.id)
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

            const isClickable = node.documentId !== null || node.kind === 'branch'
            const isLeafDoc = node.kind === 'document'
            const underlineY = node.y + 8
            const underlineX1 = node.side === 'right' ? node.inX : node.x
            const underlineX2 = node.side === 'right' ? node.x + node.width : node.inX
            const dotOffset = isLeafDoc && node.sourceKind !== null ? 10 : 0
            const textX = node.side === 'right' ? node.x + 5 + dotOffset : node.inX - 5 - dotOffset
            const dotX = node.side === 'right' ? node.x + 7 : node.inX - 7
            const forkX = node.outX

            return (
              <g
                key={node.id}
                role={isClickable ? 'button' : undefined}
                tabIndex={isClickable ? 0 : undefined}
                aria-label={isClickable ? (node.kind === 'branch' && node.hasChildren ? `${node.fullLabel} (${node.collapsed ? 'collapsed' : 'expanded'})` : node.fullLabel) : undefined}
                aria-expanded={node.kind === 'branch' && node.hasChildren ? !node.collapsed : undefined}
                onClick={isClickable ? () => activateNode(node) : undefined}
                onMouseEnter={isLeafDoc ? () => setHoveredDoc(node) : undefined}
                onMouseLeave={isLeafDoc ? () => setHoveredDoc((prev) => (prev?.id === node.id ? null : prev)) : undefined}
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
                {isLeafDoc && node.sourceKind !== null ? (
                  <circle
                    cx={dotX}
                    cy={node.y - 6}
                    r={3.2}
                    fill={SOURCE_DOT_COLORS[node.sourceKind]}
                  />
                ) : null}
                {node.hasChildren ? (
                  <g
                    role="button"
                    tabIndex={0}
                    aria-label={`${node.collapsed ? 'Expand' : 'Collapse'} ${node.fullLabel}`}
                    aria-expanded={!node.collapsed}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (!dragRef.current.moved) {
                        setSelectedBranchId(node.id)
                        toggleCollapse(node.id)
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        event.stopPropagation()
                        setSelectedBranchId(node.id)
                        toggleCollapse(node.id)
                      }
                    }}
                    className="cursor-pointer"
                  >
                    <circle
                      cx={forkX}
                      cy={node.y}
                      r={5}
                      fill={node.collapsed ? '#0f1218' : node.color}
                      stroke={node.color}
                      strokeWidth={1.75}
                    />
                    {node.collapsed ? (
                      <text
                        x={forkX}
                        y={node.y + 0.5}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill={node.color}
                        fontSize={9}
                        fontWeight={700}
                      >
                        +
                      </text>
                    ) : null}
                  </g>
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

      {/* Bottom-left branch action / document preview HUD */}
      {hoveredDoc !== null ? (
        <div className="pointer-events-none absolute bottom-3 left-3.5 max-w-sm rounded-control border border-nav-line bg-nav/90 px-3 py-2 text-xs text-nav-ink backdrop-blur-sm">
          <p className="truncate font-medium">{hoveredDoc.fullLabel}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-nav-muted">
            {hoveredDoc.sourceKind !== null ? <span>{SOURCE_LABELS[hoveredDoc.sourceKind]}</span> : null}
            {hoveredDoc.path !== null ? <span className="truncate font-mono">{hoveredDoc.path}</span> : null}
            {hoveredDoc.allowLlm === false ? (
              <span className="inline-flex items-center gap-1"><Lock aria-hidden="true" className="size-3" />Local only</span>
            ) : null}
          </p>
        </div>
      ) : selectedBranch !== null && selectedBranch.branchQuery !== null ? (
        <div className="absolute bottom-3 left-3.5 flex flex-wrap items-center gap-2 rounded-control border border-nav-line bg-nav/90 px-3 py-2 text-xs text-nav-ink backdrop-blur-sm">
          <span className="font-medium">{selectedBranch.fullLabel}</span>
          <span className="text-nav-muted">{selectedBranch.childCount} {selectedBranch.childCount === 1 ? 'item' : 'items'}</span>
          {selectedBranch.hasChildren ? (
            <button
              type="button"
              onClick={() => toggleCollapse(selectedBranch.id)}
              className="inline-flex min-h-9 items-center rounded-control border border-nav-line bg-nav-raised px-2.5 text-xs font-medium text-nav-ink hover:bg-nav"
            >
              {selectedBranch.collapsed ? 'Expand' : 'Collapse'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onBranch(selectedBranch.branchQuery!)}
            aria-label={`Explore ${selectedBranch.fullLabel}`}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-control bg-accent px-2.5 text-xs font-medium text-on-accent hover:opacity-90"
          >
            <Compass aria-hidden="true" className="size-3.5" />
            Explore
          </button>
        </div>
      ) : null}
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

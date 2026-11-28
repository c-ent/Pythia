import { Lock, Maximize2, Minimize2, Minus, Plus, RotateCcw } from 'lucide-react'
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { documentPath, navigate, repoPath } from '../router'
import {
  clamp,
  DEFAULT_CAMERA,
  generateStarfield,
  hitTestProjected,
  MAX_ZOOM,
  MIN_ZOOM,
  projectNodes,
  projectPoint,
  rotatePoint,
  selectVisibleLabels,
  type AtlasEdge,
  type AtlasNode,
  type AtlasTone,
  type Camera3D,
  type ProjectedNode,
} from './atlas3d'

const ZOOM_STEP = 1.28

interface AtlasPalette {
  monoFont: string
  tones: Record<AtlasTone, string>
}

interface PreviewState {
  node: AtlasNode
  x: number
  y: number
  width: number
  height: number
}

function readCssToken(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(`--${name}`).trim() || fallback
}

function parseHexRgb(hex: string): [number, number, number] | null {
  const clean = hex.trim().replace(/^#/, '')
  if (!/^[0-9a-f]{6}$/i.test(clean)) return null
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ]
}

/** Keeps source colors vivid and luminous against the dark cosmic atlas background in both Light and Dark app themes. */
function liftForDarkCanvas(hex: string, lift = 0.28): string {
  const rgb = parseHexRgb(hex)
  if (rgb === null) return hex
  const [r, g, b] = rgb
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  const amount = lum < 0.42 ? Math.max(lift, 0.42 - lum * 0.5) : lift * 0.35
  const nr = Math.round(r + (255 - r) * amount)
  const ng = Math.round(g + (255 - g) * amount)
  const nb = Math.round(b + (255 - b) * amount)
  return `rgb(${nr} ${ng} ${nb})`
}

function rgbaFromCssColor(color: string, alpha: number): string {
  const hex = parseHexRgb(color)
  if (hex !== null) return `rgba(${hex[0]}, ${hex[1]}, ${hex[2]}, ${alpha})`
  const match = color.match(/rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\)/i)
  if (match !== null) return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`
  return `rgba(210, 220, 235, ${alpha})`
}

function readPalette(): AtlasPalette {
  const styles = getComputedStyle(document.documentElement)
  const color = (name: string, fallback: string): string => readCssToken(styles, `color-${name}`, fallback)
  return {
    monoFont: readCssToken(styles, 'font-mono', 'ui-monospace, monospace'),
    tones: {
      center: '#f2f5fa',
      branch: liftForDarkCanvas(color('accent', '#ccff00'), 0.15),
      obsidian: liftForDarkCanvas(color('map-obsidian', '#b794f6')),
      keep: liftForDarkCanvas(color('map-keep', '#f5b454')),
      gdrive: liftForDarkCanvas(color('map-gdrive', '#7ab4ff')),
      repo: liftForDarkCanvas(color('map-repo', '#5fd3a8')),
      tag: liftForDarkCanvas(color('map-tag', '#f48fb1')),
      ghost: '#8a909b',
    },
  }
}

function nodeKindSummary(node: AtlasNode): string {
  if (node.kind === 'center') return 'Topic center'
  if (node.kind === 'branch' || node.kind === 'subbranch') return node.sourceLabel ?? 'Topic branch'
  if (node.kind === 'ghost') return 'Missing note: nothing has this name yet'
  if (node.kind === 'tag') return 'Tag'
  if (node.kind === 'repo') return 'Repository'
  return node.sourceLabel ?? 'Document'
}

export interface AtlasCanvasProps {
  nodes: readonly AtlasNode[]
  edges: readonly AtlasEdge[]
  worldRadius: number
  ariaLabel: string
  title: string
  subtitle?: string
  initialCamera?: Partial<Camera3D>
  onSelectBranch?: (query: string) => void
  heightClassName?: string
}

/**
 * Interactive 3D glowing constellation canvas used across Topic Map, Whole-Vault
 * Graph, and Document Local Graph: drag to rotate in 3D, scroll or pinch to
 * zoom, Shift+drag to pan, plus accessible zoom/reset buttons and live hover previews.
 */
export function AtlasCanvas({
  nodes,
  edges,
  worldRadius,
  ariaLabel,
  title,
  subtitle,
  initialCamera,
  onSelectBranch,
  heightClassName = 'h-104 md:h-136',
}: AtlasCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const defaultCamera = useMemo<Camera3D>(
    () => ({ ...DEFAULT_CAMERA, ...initialCamera }),
    [initialCamera],
  )
  const cameraRef = useRef<Camera3D>(defaultCamera)
  const projectedRef = useRef<ProjectedNode[]>([])
  const sizeRef = useRef<{ width: number; height: number }>({ width: 760, height: 520 })
  const paletteRef = useRef<AtlasPalette | null>(null)
  const stars = useMemo(() => generateStarfield(190, 101), [])

  const hoveredIdRef = useRef<string | null>(null)
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [dragging, setDragging] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const edge of edges) {
      let from = map.get(edge.source)
      if (from === undefined) {
        from = new Set()
        map.set(edge.source, from)
      }
      from.add(edge.target)

      let to = map.get(edge.target)
      if (to === undefined) {
        to = new Set()
        map.set(edge.target, to)
      }
      to.add(edge.source)
    }
    return map
  }, [edges])

  const rafRef = useRef<number | null>(null)
  const scheduledRef = useRef(false)

  const draw = useCallback(() => {
    scheduledRef.current = false
    rafRef.current = null
    const canvas = canvasRef.current
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return

    const { width, height } = sizeRef.current
    if (width <= 0 || height <= 0) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const targetW = Math.round(width * dpr)
    const targetH = Math.round(height * dpr)
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW
      canvas.height = targetH
    }

    const palette = paletteRef.current ?? readPalette()
    paletteRef.current = palette

    ctx.save()
    ctx.scale(dpr, dpr)

    // 1. Deep dark space background with subtle atmospheric nebula gradient.
    const bg = ctx.createRadialGradient(width * 0.5, height * 0.46, 20, width * 0.5, height * 0.5, Math.max(width, height) * 0.72)
    bg.addColorStop(0, '#12151d')
    bg.addColorStop(0.55, '#090b10')
    bg.addColorStop(1, '#050608')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, width, height)

    const camera = cameraRef.current
    const activeHover = hoveredIdRef.current
    const neighborIds = activeHover ? (adjacency.get(activeHover) ?? new Set<string>()) : new Set<string>()

    // 2. Ambient rotating 3D starfield dust.
    for (const star of stars) {
      const p = projectPoint(star.x, star.y, star.z, camera, width, height, worldRadius)
      if (p.sx < -4 || p.sx > width + 4 || p.sy < -4 || p.sy > height + 4) continue
      const depthAlpha = star.alpha * (0.45 + 0.55 * p.depthNorm)
      ctx.fillStyle = `rgba(210, 222, 240, ${depthAlpha.toFixed(3)})`
      ctx.beginPath()
      ctx.arc(p.sx, p.sy, star.size, 0, Math.PI * 2)
      ctx.fill()
    }

    // 3. Project nodes & sort back-to-front.
    const projected = projectNodes(nodes, camera, width, height, worldRadius)
    projectedRef.current = projected
    const byId = new Map(projected.map((item) => [item.node.id, item]))

    // 4. Draw delicate connecting filaments.
    const sortedEdges = edges
      .map((edge) => {
        const a = byId.get(edge.source)
        const b = byId.get(edge.target)
        if (a === undefined || b === undefined) return null
        return { edge, a, b, depth: (a.depthNorm + b.depthNorm) * 0.5 }
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((x, y) => x.depth - y.depth)

    for (const { edge, a, b, depth } of sortedEdges) {
      const isHighlighted = activeHover !== null && (a.node.id === activeHover || b.node.id === activeHover)
      const dimmed = activeHover !== null && !isHighlighted
      const baseAlpha = isHighlighted ? 0.8 : dimmed ? 0.05 : 0.1 + 0.24 * depth

      ctx.save()
      if (edge.kind === 'neighbour') ctx.setLineDash([3, 4])
      ctx.lineWidth = isHighlighted ? 1.5 : edge.kind === 'branch' ? 1.15 : 0.85
      ctx.strokeStyle = isHighlighted
        ? rgbaFromCssColor(palette.tones.branch, baseAlpha)
        : `rgba(186, 198, 220, ${baseAlpha.toFixed(3)})`
      ctx.beginPath()
      ctx.moveTo(a.sx, a.sy)
      ctx.lineTo(b.sx, b.sy)
      ctx.stroke()
      ctx.restore()
    }

    // 5. Draw glowing 3D nodes back-to-front.
    for (const item of projected) {
      const { node, sx, sy, depthNorm, screenRadius } = item
      if (sx < -40 || sx > width + 40 || sy < -40 || sy > height + 40) continue

      const isHovered = node.id === activeHover
      const isNeighbor = neighborIds.has(node.id)
      const dimmed = activeHover !== null && !isHovered && !isNeighbor
      const baseTone = palette.tones[node.tone] ?? '#d0d7e3'
      const alphaScale = dimmed ? 0.25 : 0.45 + 0.55 * depthNorm

      // Outer luminous halo.
      const haloRadius = screenRadius * (node.kind === 'center' ? 3.8 : isHovered ? 4 : 2.9)
      const halo = ctx.createRadialGradient(sx, sy, screenRadius * 0.2, sx, sy, haloRadius)
      halo.addColorStop(0, rgbaFromCssColor(baseTone, (isHovered ? 0.65 : 0.38) * alphaScale))
      halo.addColorStop(0.5, rgbaFromCssColor(baseTone, (isHovered ? 0.22 : 0.1) * alphaScale))
      halo.addColorStop(1, rgbaFromCssColor(baseTone, 0))
      ctx.fillStyle = halo
      ctx.beginPath()
      ctx.arc(sx, sy, haloRadius, 0, Math.PI * 2)
      ctx.fill()

      ctx.save()
      ctx.globalAlpha = dimmed ? 0.35 : 0.55 + 0.45 * depthNorm

      if (node.kind === 'ghost') {
        ctx.setLineDash([2.5, 2.5])
        ctx.strokeStyle = rgbaFromCssColor(baseTone, 0.75)
        ctx.lineWidth = 1.25
        ctx.beginPath()
        ctx.arc(sx, sy, screenRadius, 0, Math.PI * 2)
        ctx.stroke()
      } else if (node.kind === 'tag') {
        ctx.fillStyle = baseTone
        ctx.beginPath()
        ctx.moveTo(sx, sy - screenRadius)
        ctx.lineTo(sx + screenRadius, sy)
        ctx.lineTo(sx, sy + screenRadius)
        ctx.lineTo(sx - screenRadius, sy)
        ctx.closePath()
        ctx.fill()
      } else if (node.kind === 'repo') {
        const size = screenRadius * 1.75
        const r = Math.min(4, size * 0.28)
        ctx.fillStyle = baseTone
        ctx.beginPath()
        ctx.roundRect(sx - size / 2, sy - size / 2, size, size, r)
        ctx.fill()
      } else {
        // Luminous core orb.
        const core = ctx.createRadialGradient(sx - screenRadius * 0.2, sy - screenRadius * 0.2, 0.5, sx, sy, screenRadius)
        core.addColorStop(0, '#ffffff')
        core.addColorStop(0.45, baseTone)
        core.addColorStop(1, rgbaFromCssColor(baseTone, 0.65))
        ctx.fillStyle = core
        ctx.beginPath()
        ctx.arc(sx, sy, screenRadius, 0, Math.PI * 2)
        ctx.fill()
      }

      // Subtle orbital ring on root / branch / hovered nodes.
      if (node.kind === 'center' || node.kind === 'branch' || node.kind === 'subbranch' || isHovered) {
        ctx.setLineDash([])
        ctx.strokeStyle = isHovered
          ? '#ffffff'
          : node.kind === 'center'
            ? 'rgba(255, 255, 255, 0.55)'
            : rgbaFromCssColor(baseTone, 0.72)
        ctx.lineWidth = node.kind === 'center' ? 1.4 : 1.1
        ctx.beginPath()
        ctx.arc(sx, sy, screenRadius + (node.kind === 'center' ? 5 : 3.2), 0, Math.PI * 2)
        ctx.stroke()
      }

      ctx.restore()
    }

    // 6. Collision-free monospace labels.
    const measure = (text: string, uppercase: boolean): number => {
      ctx.font = `${uppercase ? '600 10.5px' : '500 10.5px'} ${palette.monoFont}`
      return ctx.measureText(text).width
    }
    const labels = selectVisibleLabels(projected, width, height, activeHover, neighborIds, measure)

    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (const placed of labels) {
      const { node: item, text, subtext, uppercase } = placed
      const isHighlighted = item.node.id === activeHover || neighborIds.has(item.node.id)
      const dimmed = activeHover !== null && !isHighlighted
      const alpha = dimmed ? 0.25 : clamp(0.48 + 0.52 * item.depthNorm, 0.4, 1)
      const labelY = item.sy + item.screenRadius + 6

      ctx.font = `${uppercase ? '600 10.5px' : '500 10.5px'} ${palette.monoFont}`
      ctx.lineWidth = 3.2
      ctx.strokeStyle = 'rgba(5, 6, 8, 0.88)'
      ctx.strokeText(text, item.sx, labelY)
      ctx.fillStyle = uppercase
        ? `rgba(244, 246, 250, ${Math.min(1, alpha + 0.12).toFixed(3)})`
        : `rgba(222, 228, 238, ${alpha.toFixed(3)})`
      ctx.fillText(text, item.sx, labelY)

      if (subtext !== undefined) {
        ctx.font = `400 9.5px ${palette.monoFont}`
        ctx.strokeText(subtext, item.sx, labelY + 13)
        ctx.fillStyle = `rgba(148, 156, 170, ${alpha.toFixed(3)})`
        ctx.fillText(subtext, item.sx, labelY + 13)
      }
    }

    // 7. Bottom-right 3D orientation axis gizmo.
    const gizmoX = width - 46
    const gizmoY = height - 46
    ctx.save()
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(gizmoX, gizmoY, 15, 0, Math.PI * 2)
    ctx.stroke()

    const axes: Array<{ vec: [number, number, number]; label: string; color: string }> = [
      { vec: [1, 0, 0], label: 'X', color: 'rgba(204, 255, 0, 0.65)' },
      { vec: [0, 1, 0], label: 'Y', color: 'rgba(226, 232, 240, 0.72)' },
      { vec: [0, 0, 1], label: 'Z', color: 'rgba(148, 163, 184, 0.55)' },
    ]
    ctx.font = `500 9px ${palette.monoFont}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const axis of axes) {
      const r = rotatePoint(axis.vec[0], axis.vec[1], axis.vec[2], camera.yaw, camera.pitch)
      const ex = gizmoX + r.rx * 24
      const ey = gizmoY - r.ry * 24
      ctx.strokeStyle = axis.color
      ctx.beginPath()
      ctx.moveTo(gizmoX, gizmoY)
      ctx.lineTo(ex, ey)
      ctx.stroke()
      ctx.fillStyle = axis.color
      ctx.fillText(axis.label, gizmoX + r.rx * 31, gizmoY - r.ry * 31)
    }
    ctx.restore()

    ctx.restore()
  }, [adjacency, edges, nodes, stars, worldRadius])

  const scheduleDraw = useCallback(() => {
    if (scheduledRef.current) return
    scheduledRef.current = true
    const id = window.requestAnimationFrame(draw)
    if (scheduledRef.current) rafRef.current = id
  }, [draw])

  useEffect(() => {
    cameraRef.current = defaultCamera
    scheduleDraw()
  }, [defaultCamera, nodes, edges, scheduleDraw])

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (wrapper === null) return

    const updateSize = () => {
      const rect = wrapper.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        sizeRef.current = { width: rect.width, height: rect.height }
        scheduleDraw()
      }
    }
    updateSize()

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateSize) : null
    ro?.observe(wrapper)

    const mo = new MutationObserver(() => {
      paletteRef.current = readPalette()
      scheduleDraw()
    })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    return () => {
      ro?.disconnect()
      mo.disconnect()
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      scheduledRef.current = false
    }
  }, [scheduleDraw])

  useEffect(() => {
    if (!fullscreen) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setFullscreen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    const id = window.requestAnimationFrame(() => {
      const wrapper = wrapperRef.current
      if (wrapper === null) return
      const rect = wrapper.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        sizeRef.current = { width: rect.width, height: rect.height }
        scheduleDraw()
      }
    })
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKey)
      window.cancelAnimationFrame(id)
    }
  }, [fullscreen, scheduleDraw])

  // Non-passive wheel listener so scrolling over the canvas zooms without scrolling the page.
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const cx = event.clientX - rect.left
      const cy = event.clientY - rect.top
      const cam = cameraRef.current
      const factor = Math.exp(-event.deltaY * 0.0014)
      const nextZoom = clamp(cam.zoom * factor, MIN_ZOOM, MAX_ZOOM)
      const ratio = nextZoom / cam.zoom
      const dx = cx - (rect.width / 2 + cam.panX)
      const dy = cy - (rect.height / 2 + cam.panY)
      cameraRef.current = {
        ...cam,
        zoom: nextZoom,
        panX: cam.panX - dx * (ratio - 1),
        panY: cam.panY - dy * (ratio - 1),
      }
      hoveredIdRef.current = null
      setPreview(null)
      scheduleDraw()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [scheduleDraw])

  const zoomBy = (factor: number): void => {
    const cam = cameraRef.current
    cameraRef.current = { ...cam, zoom: clamp(cam.zoom * factor, MIN_ZOOM, MAX_ZOOM) }
    setPreview(null)
    scheduleDraw()
  }

  const resetView = (): void => {
    cameraRef.current = { ...defaultCamera }
    hoveredIdRef.current = null
    setPreview(null)
    scheduleDraw()
  }

  // Pointer tracking for 3D orbit rotation, Shift/right-click pan, pinch zoom, and tap/click.
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  const gestureRef = useRef<{
    moved: boolean
    panning: boolean
    lastX: number
    lastY: number
    pinchDist: number | null
  }>({ moved: false, panning: false, lastX: 0, lastY: 0, pinchDist: null })

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current
    if (canvas === null) return
    canvas.setPointerCapture(event.pointerId)
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const count = pointersRef.current.size
    if (count === 1) {
      gestureRef.current = {
        moved: false,
        panning: event.shiftKey || event.button === 2,
        lastX: event.clientX,
        lastY: event.clientY,
        pinchDist: null,
      }
      setDragging(true)
    } else if (count === 2) {
      const pts = [...pointersRef.current.values()]
      gestureRef.current.pinchDist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y)
      gestureRef.current.moved = true
    }
  }

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current
    if (canvas === null) return

    if (pointersRef.current.has(event.pointerId)) {
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })

      if (pointersRef.current.size === 2) {
        const pts = [...pointersRef.current.values()]
        const dist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y)
        const prevDist = gestureRef.current.pinchDist
        if (prevDist !== null && prevDist > 4) {
          const factor = dist / prevDist
          cameraRef.current = {
            ...cameraRef.current,
            zoom: clamp(cameraRef.current.zoom * factor, MIN_ZOOM, MAX_ZOOM),
          }
          scheduleDraw()
        }
        gestureRef.current.pinchDist = dist
        gestureRef.current.moved = true
        return
      }

      const dx = event.clientX - gestureRef.current.lastX
      const dy = event.clientY - gestureRef.current.lastY
      if (Math.hypot(dx, dy) > 2) gestureRef.current.moved = true
      gestureRef.current.lastX = event.clientX
      gestureRef.current.lastY = event.clientY

      const cam = cameraRef.current
      if (gestureRef.current.panning) {
        cameraRef.current = { ...cam, panX: cam.panX + dx, panY: cam.panY + dy }
      } else {
        cameraRef.current = {
          ...cam,
          yaw: cam.yaw + dx * 0.0072,
          pitch: clamp(cam.pitch + dy * 0.0072, -1.45, 1.45),
        }
      }
      if (hoveredIdRef.current !== null) {
        hoveredIdRef.current = null
        setPreview(null)
      }
      scheduleDraw()
      return
    }

    // Hover hit-test.
    const rect = canvas.getBoundingClientRect()
    const hit = hitTestProjected(projectedRef.current, event.clientX - rect.left, event.clientY - rect.top)
    const nextId = hit?.node.id ?? null
    if (nextId !== hoveredIdRef.current) {
      hoveredIdRef.current = nextId
      scheduleDraw()
    }
    if (hit !== null) {
      const { width, height } = sizeRef.current
      setPreview({ node: hit.node, x: hit.sx, y: hit.sy, width, height })
      canvas.style.cursor =
        hit.node.documentId !== null || hit.node.kind === 'repo' || (hit.node.branchQuery && onSelectBranch)
          ? 'pointer'
          : 'grab'
    } else {
      setPreview(null)
      canvas.style.cursor = 'grab'
    }
  }

  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current
    if (canvas !== null && canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId)
    }
    const wasSingle = pointersRef.current.size === 1
    pointersRef.current.delete(event.pointerId)
    if (pointersRef.current.size === 0) setDragging(false)

    if (wasSingle && !gestureRef.current.moved && canvas !== null) {
      const rect = canvas.getBoundingClientRect()
      const hit = hitTestProjected(projectedRef.current, event.clientX - rect.left, event.clientY - rect.top)
      if (hit === null) {
        hoveredIdRef.current = null
        setPreview(null)
        scheduleDraw()
        return
      }
      if (hit.node.documentId !== null) {
        navigate(documentPath(hit.node.documentId))
      } else if (hit.node.kind === 'repo') {
        navigate(repoPath(hit.node.label))
      } else if (hit.node.branchQuery && onSelectBranch) {
        onSelectBranch(hit.node.branchQuery)
      } else {
        const { width, height } = sizeRef.current
        hoveredIdRef.current = hit.node.id
        setPreview({ node: hit.node, x: hit.sx, y: hit.sy, width, height })
        scheduleDraw()
      }
    }
  }

  const onPointerLeave = (): void => {
    if (pointersRef.current.size === 0 && hoveredIdRef.current !== null) {
      hoveredIdRef.current = null
      setPreview(null)
      scheduleDraw()
    }
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
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      cameraRef.current = { ...cameraRef.current, yaw: cameraRef.current.yaw - 0.18 }
      scheduleDraw()
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      cameraRef.current = { ...cameraRef.current, yaw: cameraRef.current.yaw + 0.18 }
      scheduleDraw()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      cameraRef.current = { ...cameraRef.current, pitch: clamp(cameraRef.current.pitch - 0.14, -1.45, 1.45) }
      scheduleDraw()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      cameraRef.current = { ...cameraRef.current, pitch: clamp(cameraRef.current.pitch + 0.14, -1.45, 1.45) }
      scheduleDraw()
    }
  }

  return (
    <div
      ref={wrapperRef}
      className={
        fullscreen
          ? 'fixed inset-0 z-50 m-0 h-dvh w-dvw overflow-hidden bg-nav'
          : `relative mt-4 w-full overflow-hidden rounded-control border border-nav-line bg-nav ${heightClassName}`
      }
    >
      <canvas
        ref={canvasRef}
        role="img"
        tabIndex={0}
        aria-label={ariaLabel}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
        className={`block h-full w-full touch-none select-none focus-visible:outline-2 focus-visible:outline-accent ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      />

      {/* Top-left Atlas HUD header */}
      <div className="pointer-events-none absolute top-3 left-3.5 flex max-w-[60%] items-center gap-2.5">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)]" />
        <p className="truncate font-mono text-xs tracking-wider text-nav-ink uppercase">
          {title}
          {subtitle ? <span className="ml-2 font-normal text-nav-muted normal-case">{subtitle}</span> : null}
        </p>
      </div>

      {/* Top-right interaction hint, fullscreen toggle and zoom/reset buttons */}
      <div className="absolute top-2.5 right-2.5 flex items-start gap-2.5">
        <p className="pointer-events-none hidden pt-2 font-mono text-[11px] tracking-wider text-nav-muted md:block">
          DRAG - rotate &nbsp; SCROLL - zoom{fullscreen ? '   ESC - exit' : ''}
        </p>
        {fullscreen ? (
          <button
            type="button"
            aria-label="Exit full screen"
            aria-pressed={true}
            title="Exit full screen (Esc)"
            onClick={() => setFullscreen(false)}
            className="inline-flex min-h-11 items-center gap-2 rounded-control border border-nav-line bg-nav/85 px-3.5 text-xs font-medium text-nav-ink backdrop-blur-sm transition-colors hover:bg-nav-raised"
          >
            <Minimize2 aria-hidden="true" className="size-4" />
            <span>Exit full screen</span>
          </button>
        ) : null}
        <div className="flex flex-col gap-1.5">
          {fullscreen ? null : (
            <ZoomButton label="Full screen" pressed={false} onClick={() => setFullscreen(true)}>
              <Maximize2 aria-hidden="true" className="size-4" />
            </ZoomButton>
          )}
          <ZoomButton label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>
            <Plus aria-hidden="true" className="size-4" />
          </ZoomButton>
          <ZoomButton label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>
            <Minus aria-hidden="true" className="size-4" />
          </ZoomButton>
          <ZoomButton label="Reset view" onClick={resetView}>
            <RotateCcw aria-hidden="true" className="size-4" />
          </ZoomButton>
        </div>
      </div>

      {preview === null ? null : (
        <NodePreview
          preview={preview}
          canExploreBranch={Boolean(onSelectBranch)}
        />
      )}
    </div>
  )
}

function ZoomButton({ label, pressed, onClick, children }: { label: string; pressed?: boolean; onClick: () => void; children: ReactNode }) {
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

function NodePreview({
  preview,
  canExploreBranch,
}: {
  preview: PreviewState
  canExploreBranch: boolean
}) {
  const { node, width: containerWidth, height: containerHeight } = preview
  const clampedLeft = clamp(preview.x, 128, Math.max(128, containerWidth - 128))
  const showAbove = preview.y > containerHeight - 135
  const top = showAbove ? Math.max(52, preview.y - 16) : Math.min(containerHeight - 20, preview.y + 18)

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute z-10 max-w-64 -translate-x-1/2 rounded-control border border-nav-line bg-nav/95 px-3 py-2 text-sm text-nav-ink shadow-[0_8px_24px_rgb(0_0_0/0.45)] backdrop-blur-sm ${showAbove ? '-translate-y-full' : ''}`}
      style={{ left: clampedLeft, top }}
    >
      <p className="font-medium wrap-break-word text-nav-ink">{node.label}</p>
      <p className="mt-0.5 text-xs text-nav-muted">{nodeKindSummary(node)}</p>
      {node.path === null ? null : <p className="mt-0.5 truncate font-mono text-xs text-nav-muted">{node.path}</p>}
      {node.allowLlm === false ? (
        <p className="mt-1 inline-flex items-center gap-1 text-xs text-nav-muted">
          <Lock className="size-3.5" />
          Local only
        </p>
      ) : null}
      <p className="mt-0.5 text-xs text-nav-muted">
        {node.kind === 'branch' || node.kind === 'subbranch' || node.kind === 'center'
          ? `${node.links} ${node.links === 1 ? 'document' : 'documents'}`
          : `${node.links} ${node.links === 1 ? 'link' : 'links'}`}
        {node.documentId !== null || node.kind === 'repo' ? ' · Click to open' : node.branchQuery && canExploreBranch ? ' · Click to explore' : ''}
      </p>
    </div>
  )
}

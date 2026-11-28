import { Maximize2, Minimize2, Minus, Plus, RotateCcw } from 'lucide-react'
import type { ReactNode, RefObject } from 'react'

/**
 * Shared viewport chrome for interactive 2D and 3D graph canvases:
 * fullscreen container, HUD title/subtitle, interaction hint, and zoom/reset controls.
 */
export function GraphViewportChrome({
  wrapperRef,
  fullscreen,
  onFullscreenChange,
  title,
  subtitle,
  interactionHint,
  heightClassName,
  marginClassName = '',
  onZoomIn,
  onZoomOut,
  onResetView,
  children,
}: {
  wrapperRef: RefObject<HTMLDivElement | null>
  fullscreen: boolean
  onFullscreenChange: (next: boolean) => void
  title: string
  subtitle?: string
  interactionHint: string
  heightClassName: string
  marginClassName?: string
  onZoomIn: () => void
  onZoomOut: () => void
  onResetView: () => void
  children: ReactNode
}) {
  return (
    <div
      ref={wrapperRef}
      className={
        fullscreen
          ? 'fixed inset-0 z-50 m-0 h-dvh w-dvw overflow-hidden bg-nav'
          : `relative ${marginClassName} w-full overflow-hidden rounded-control border border-nav-line bg-nav ${heightClassName}`.trim()
      }
    >
      {children}

      <div className="pointer-events-none absolute top-3 left-3.5 flex max-w-[60%] items-center gap-2.5">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)]" />
        <p className="truncate font-mono text-xs tracking-wider text-nav-ink uppercase">
          {title}
          {subtitle ? <span className="ml-2 font-normal text-nav-muted normal-case">{subtitle}</span> : null}
        </p>
      </div>

      <div className="absolute top-2.5 right-2.5 flex items-start gap-2.5">
        <p className="pointer-events-none hidden pt-2 font-mono text-[11px] tracking-wider text-nav-muted md:block">
          {interactionHint}{fullscreen ? '   ESC - exit' : ''}
        </p>
        <div className="flex flex-col items-end gap-1.5">
          {fullscreen ? (
            <button
              type="button"
              aria-label="Exit full screen"
              aria-pressed={true}
              title="Exit full screen (Esc)"
              onClick={() => onFullscreenChange(false)}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-nav-line bg-nav/85 px-3 text-xs font-medium text-nav-ink backdrop-blur-sm transition-colors hover:bg-nav-raised"
            >
              <Minimize2 aria-hidden="true" className="size-4" />
              <span>Exit</span>
            </button>
          ) : (
            <ViewportButton label="Full screen" pressed={false} onClick={() => onFullscreenChange(true)}>
              <Maximize2 aria-hidden="true" className="size-4" />
            </ViewportButton>
          )}
          <ViewportButton label="Zoom in" onClick={onZoomIn}>
            <Plus aria-hidden="true" className="size-4" />
          </ViewportButton>
          <ViewportButton label="Zoom out" onClick={onZoomOut}>
            <Minus aria-hidden="true" className="size-4" />
          </ViewportButton>
          <ViewportButton label="Reset view" onClick={onResetView}>
            <RotateCcw aria-hidden="true" className="size-4" />
          </ViewportButton>
        </div>
      </div>
    </div>
  )
}

function ViewportButton({ label, pressed, onClick, children }: { label: string; pressed?: boolean; onClick: () => void; children: ReactNode }) {
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

import { LoaderCircle } from 'lucide-react'
import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react'
import type { GraphResponse } from '../api/graph'
import {
  DEFAULT_GRAPH_DISPLAY,
  DEFAULT_GRAPH_FILTERS,
  DEFAULT_GRAPH_FORCES,
  filterGraph,
  type GraphDisplaySettings,
  type GraphFilters,
  type GraphForceSettings,
} from './graphControls'
import { GraphControlPanels } from './GraphControlPanels'
import { TONE_LABELS, TONE_SWATCH, tonesIn } from './graphModel'

const GraphCanvas = lazy(() => import('./GraphCanvas').then((module) => ({ default: module.GraphCanvas })))

/**
 * 2D / 3D toggle shared by network graph headers.
 */
export function GraphDimensionToggle({
  dimension,
  onChange,
}: {
  dimension: '2d' | '3d'
  onChange: (next: '2d' | '3d') => void
}) {
  return (
    <div role="group" aria-label="Graph dimension" className="inline-flex rounded-control bg-raised p-1">
      {(['2d', '3d'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={dimension === mode}
          onClick={() => onChange(mode)}
          className={`inline-flex min-h-11 items-center justify-center rounded-[0.5rem] px-3 text-sm transition-colors ${
            dimension === mode ? 'bg-strong font-medium text-on-strong' : 'text-muted hover:text-ink'
          }`}
        >
          {mode.toUpperCase()}
        </button>
      ))}
    </div>
  )
}

/**
 * Deep network-graph presentation module shared by Whole-Vault and Document Local graphs:
 * owns filter/display/force state, hides 2D-only Display & Forces controls in 3D mode,
 * lazy-loads the canvas, and renders the colour legend and empty-filter state.
 */
export function NetworkGraphView<TGraph extends Pick<GraphResponse, 'nodes' | 'edges'>>({
  graph,
  center,
  view,
  dimension,
  canvasTitle,
  canvasSubtitle,
  heightClassName,
  fallbackClassName = 'flex h-88 items-center justify-center gap-2 text-sm text-muted md:h-112',
  showExistingToggle = false,
  emptyFilteredMessage = 'No items match these filters.',
  legendLabel = 'Graph colours',
  hasItems = (g) => g.nodes.length > 0,
  renderList,
}: {
  graph: TGraph
  center?: string
  view: 'graph' | 'list'
  dimension: '2d' | '3d'
  canvasTitle: string
  canvasSubtitle?: (filtered: TGraph) => string
  heightClassName?: string
  fallbackClassName?: string
  showExistingToggle?: boolean
  emptyFilteredMessage?: string
  legendLabel?: string
  hasItems?: (filtered: TGraph) => boolean
  renderList: (filtered: TGraph) => ReactNode
}) {
  const [filters, setFilters] = useState<GraphFilters>(DEFAULT_GRAPH_FILTERS)
  const [display, setDisplay] = useState<GraphDisplaySettings>(DEFAULT_GRAPH_DISPLAY)
  const [forces, setForces] = useState<GraphForceSettings>(DEFAULT_GRAPH_FORCES)
  const [layoutVersion, setLayoutVersion] = useState(0)

  const filteredGraph = useMemo(() => filterGraph(graph, filters, center), [center, filters, graph])
  const tones = useMemo(() => tonesIn(filteredGraph), [filteredGraph])
  const populated = hasItems(filteredGraph)

  return (
    <>
      <GraphControlPanels
        filters={filters}
        onFiltersChange={setFilters}
        display={display}
        onDisplayChange={setDisplay}
        forces={forces}
        onForcesChange={setForces}
        onAnimate={() => setLayoutVersion((n) => n + 1)}
        showExistingToggle={showExistingToggle}
        showDisplayAndForces={view === 'graph' && dimension === '2d'}
      />
      {!populated ? (
        <p className="py-6 text-center text-sm text-muted">{emptyFilteredMessage}</p>
      ) : view === 'list' ? (
        renderList(filteredGraph)
      ) : (
        <Suspense
          fallback={
            <p role="status" className={fallbackClassName}>
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
              Drawing the graph…
            </p>
          }
        >
          <GraphCanvas
            graph={filteredGraph}
            center={center}
            title={canvasTitle}
            subtitle={canvasSubtitle ? canvasSubtitle(filteredGraph) : undefined}
            heightClassName={heightClassName}
            dimension={dimension}
            display={display}
            forces={forces}
            layoutVersion={layoutVersion}
          />
        </Suspense>
      )}
      {populated ? (
        <ul aria-label={legendLabel} className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {tones.map((tone) => (
            <li key={tone} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className={`size-2.5 rounded-full ${TONE_SWATCH[tone]}`} />
              {TONE_LABELS[tone]}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}

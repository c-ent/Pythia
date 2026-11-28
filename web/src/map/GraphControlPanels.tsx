import { Play, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import {
  DEFAULT_GRAPH_DISPLAY,
  DEFAULT_GRAPH_FILTERS,
  DEFAULT_GRAPH_FORCES,
  type GraphDisplaySettings,
  type GraphFilters,
  type GraphForceSettings,
} from './graphControls'

type OpenPanel = 'filters' | 'display' | 'forces' | null

/**
 * Collapsible Filters (T88), Display (T90), and Forces (T90) toolbar + panels
 * shared by Whole-Vault and Local Graph.
 */
export function GraphControlPanels({
  filters,
  onFiltersChange,
  display,
  onDisplayChange,
  forces,
  onForcesChange,
  onAnimate,
  showExistingToggle = false,
  showDisplayAndForces = true,
}: {
  filters: GraphFilters
  onFiltersChange: (next: GraphFilters) => void
  display: GraphDisplaySettings
  onDisplayChange: (next: GraphDisplaySettings) => void
  forces: GraphForceSettings
  onForcesChange: (next: GraphForceSettings) => void
  onAnimate: () => void
  showExistingToggle?: boolean
  showDisplayAndForces?: boolean
}) {
  const [open, setOpen] = useState<OpenPanel>(null)
  const togglePanel = (panel: Exclude<OpenPanel, null>): void => {
    setOpen((prev) => (prev === panel ? null : panel))
  }

  return (
    <div className="mb-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <PanelToggle label="Filters" active={open === 'filters'} onClick={() => togglePanel('filters')} />
        {showDisplayAndForces ? (
          <>
            <PanelToggle label="Display" active={open === 'display'} onClick={() => togglePanel('display')} />
            <PanelToggle label="Forces" active={open === 'forces'} onClick={() => togglePanel('forces')} />
          </>
        ) : null}
      </div>

      {open === 'filters' ? (
        <div role="region" aria-label="Graph filters" className="rounded-control border border-line bg-canvas p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              aria-label="Search nodes"
              value={filters.search}
              onChange={(event) => onFiltersChange({ ...filters, search: event.target.value })}
              maxLength={120}
              placeholder="Search nodes by title, path or #tag"
              className="min-h-11 min-w-0 flex-1 rounded-control border border-line bg-surface px-3 text-base text-ink placeholder:text-muted sm:max-w-xs"
            />
            <button
              type="button"
              onClick={() => onFiltersChange(DEFAULT_GRAPH_FILTERS)}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-line bg-surface px-3 text-xs font-medium text-muted hover:bg-raised hover:text-ink"
            >
              <RotateCcw aria-hidden="true" className="size-3.5" />
              Reset filters
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <FilterToggle label="Tags" pressed={filters.showTags} onToggle={() => onFiltersChange({ ...filters, showTags: !filters.showTags })} />
            <FilterToggle label="Repos" pressed={filters.showRepos} onToggle={() => onFiltersChange({ ...filters, showRepos: !filters.showRepos })} />
            <FilterToggle label="Semantic neighbours" pressed={filters.showNeighbours} onToggle={() => onFiltersChange({ ...filters, showNeighbours: !filters.showNeighbours })} />
            <FilterToggle label="Orphans" pressed={filters.showOrphans} onToggle={() => onFiltersChange({ ...filters, showOrphans: !filters.showOrphans })} />
            {showExistingToggle ? (
              <FilterToggle label="Existing files only" pressed={filters.existingOnly} onToggle={() => onFiltersChange({ ...filters, existingOnly: !filters.existingOnly })} />
            ) : null}
          </div>
        </div>
      ) : null}

      {open === 'display' && showDisplayAndForces ? (
        <div role="region" aria-label="Graph display settings" className="rounded-control border border-line bg-canvas p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <FilterToggle label="Arrows" pressed={display.arrows} onToggle={() => onDisplayChange({ ...display, arrows: !display.arrows })} />
            <button
              type="button"
              onClick={onAnimate}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-line bg-surface px-3 text-sm font-medium text-ink hover:bg-raised"
            >
              <Play aria-hidden="true" className="size-3.5" />
              Animate
            </button>
            <button
              type="button"
              onClick={() => onDisplayChange(DEFAULT_GRAPH_DISPLAY)}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-line bg-surface px-3 text-xs font-medium text-muted hover:bg-raised hover:text-ink"
            >
              <RotateCcw aria-hidden="true" className="size-3.5" />
              Reset defaults
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <RangeSlider
              label="Label density"
              value={display.labelDensity}
              min={0}
              max={2}
              step={1}
              displayValue={display.labelDensity === 0 ? 'Sparse' : display.labelDensity === 1 ? 'Balanced' : 'Dense'}
              onChange={(labelDensity) => onDisplayChange({ ...display, labelDensity })}
            />
            <RangeSlider
              label="Node size"
              value={display.nodeSize}
              min={0.6}
              max={1.8}
              step={0.1}
              displayValue={`${display.nodeSize.toFixed(1)}×`}
              onChange={(nodeSize) => onDisplayChange({ ...display, nodeSize })}
            />
            <RangeSlider
              label="Link thickness"
              value={display.linkThickness}
              min={0.5}
              max={2.5}
              step={0.25}
              displayValue={`${display.linkThickness.toFixed(2).replace(/\.00$/, '')}×`}
              onChange={(linkThickness) => onDisplayChange({ ...display, linkThickness })}
            />
          </div>
        </div>
      ) : null}

      {open === 'forces' && showDisplayAndForces ? (
        <div role="region" aria-label="Graph force settings" className="rounded-control border border-line bg-canvas p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted">Adjust 2D force-directed layout spacing and tension.</p>
            <button
              type="button"
              onClick={() => onForcesChange(DEFAULT_GRAPH_FORCES)}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-line bg-surface px-3 text-xs font-medium text-muted hover:bg-raised hover:text-ink"
            >
              <RotateCcw aria-hidden="true" className="size-3.5" />
              Reset defaults
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <RangeSlider
              label="Center force"
              value={forces.centerForce}
              min={0.05}
              max={1}
              step={0.05}
              displayValue={forces.centerForce.toFixed(2)}
              onChange={(centerForce) => onForcesChange({ ...forces, centerForce })}
            />
            <RangeSlider
              label="Repel force"
              value={forces.repelForce}
              min={0.2}
              max={2.5}
              step={0.1}
              displayValue={forces.repelForce.toFixed(1)}
              onChange={(repelForce) => onForcesChange({ ...forces, repelForce })}
            />
            <RangeSlider
              label="Link force"
              value={forces.linkForce}
              min={0.1}
              max={1.5}
              step={0.1}
              displayValue={forces.linkForce.toFixed(1)}
              onChange={(linkForce) => onForcesChange({ ...forces, linkForce })}
            />
            <RangeSlider
              label="Link distance"
              value={forces.linkDistance}
              min={40}
              max={200}
              step={5}
              displayValue={`${forces.linkDistance}px`}
              onChange={(linkDistance) => onForcesChange({ ...forces, linkDistance })}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}

function PanelToggle({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={active}
      onClick={onClick}
      className={`inline-flex min-h-11 items-center gap-1.5 rounded-control border px-3 text-sm transition-colors ${
        active ? 'border-strong bg-strong font-medium text-on-strong' : 'border-line bg-surface text-ink hover:bg-raised'
      }`}
    >
      <SlidersHorizontal aria-hidden="true" className="size-3.5" />
      {label}
    </button>
  )
}

function FilterToggle({ label, pressed, onToggle }: { label: string; pressed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className={`inline-flex min-h-11 items-center rounded-control border px-3 text-sm transition-colors ${
        pressed ? 'border-strong bg-strong font-medium text-on-strong' : 'border-line bg-surface text-muted hover:bg-raised hover:text-ink'
      }`}
    >
      {label}
    </button>
  )
}

function RangeSlider({
  label,
  value,
  min,
  max,
  step,
  displayValue,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  displayValue: string
  onChange: (value: number) => void
}) {
  return (
    <label className="block text-xs">
      <span className="flex items-center justify-between font-medium text-ink">
        <span>{label}</span>
        <span className="font-mono text-muted">{displayValue}</span>
      </span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-1.5 w-full accent-accent-ink"
      />
    </label>
  )
}

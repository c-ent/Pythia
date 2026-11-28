import { useMemo } from 'react'
import type { GraphResponse } from '../api/graph'
import { AtlasCanvas } from './AtlasCanvas'
import { buildNetworkAtlasGraph } from './atlas3d'
import { GraphCanvas2D } from './GraphCanvas2D'
import {
  DEFAULT_GRAPH_DISPLAY,
  DEFAULT_GRAPH_FORCES,
  type GraphDisplaySettings,
  type GraphForceSettings,
} from './graphControls'

/**
 * Interactive 2D/3D network graph for the Whole-Vault and Document Local
 * graphs (R20, T71, T89, T90).
 */
export function GraphCanvas({
  graph,
  center,
  title = 'Knowledge Atlas',
  subtitle,
  heightClassName = 'h-88 md:h-112',
  dimension = '3d',
  display = DEFAULT_GRAPH_DISPLAY,
  forces = DEFAULT_GRAPH_FORCES,
  layoutVersion = 0,
}: {
  graph: Pick<GraphResponse, 'nodes' | 'edges'>
  center?: string
  title?: string
  subtitle?: string
  heightClassName?: string
  dimension?: '2d' | '3d'
  display?: GraphDisplaySettings
  forces?: GraphForceSettings
  layoutVersion?: number
}) {
  if (dimension === '2d') {
    return (
      <GraphCanvas2D
        graph={graph}
        center={center}
        title={title}
        subtitle={subtitle ?? `${graph.nodes.length} items · ${graph.edges.length} connections`}
        ariaLabel={`2D graph with ${graph.nodes.length} items. The list view has the same items.`}
        heightClassName={heightClassName}
        display={display}
        forces={forces}
        layoutVersion={layoutVersion}
      />
    )
  }

  return <GraphCanvas3D graph={graph} center={center} title={title} subtitle={subtitle} heightClassName={heightClassName} />
}

function GraphCanvas3D({
  graph,
  center,
  title,
  subtitle,
  heightClassName,
}: {
  graph: Pick<GraphResponse, 'nodes' | 'edges'>
  center?: string
  title: string
  subtitle?: string
  heightClassName: string
}) {
  const atlas = useMemo(() => buildNetworkAtlasGraph(graph, center), [graph, center])

  return (
    <AtlasCanvas
      nodes={atlas.nodes}
      edges={atlas.edges}
      worldRadius={atlas.worldRadius}
      title={title}
      subtitle={subtitle ?? `${atlas.nodes.length} items · ${atlas.edges.length} connections`}
      ariaLabel={`Graph with ${graph.nodes.length} items. The list view has the same items.`}
      heightClassName={heightClassName}
    />
  )
}

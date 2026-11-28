import { useMemo } from 'react'
import type { GraphResponse } from '../api/graph'
import { AtlasCanvas } from './AtlasCanvas'
import { buildNetworkAtlasGraph } from './atlas3d'

/**
 * Interactive 3D constellation graph for the Whole-Vault and Document Local
 * graphs (R20, T71): colour by source, size by links, click (tap) opens a
 * document, hover or tap shows a preview, drag rotates in 3D, scroll or pinch
 * zooms, and buttons zoom in, zoom out or reset the view.
 */
export function GraphCanvas({
  graph,
  center,
  title = 'Knowledge Atlas',
  subtitle,
}: {
  graph: Pick<GraphResponse, 'nodes' | 'edges'>
  center?: string
  title?: string
  subtitle?: string
}) {
  const atlas = useMemo(() => buildNetworkAtlasGraph(graph, center), [graph, center])

  return (
    <AtlasCanvas
      nodes={atlas.nodes}
      edges={atlas.edges}
      worldRadius={atlas.worldRadius}
      title={title}
      subtitle={subtitle ?? `${graph.nodes.length} items · ${graph.edges.length} connections`}
      ariaLabel={`Graph with ${graph.nodes.length} items. The list view has the same items.`}
      heightClassName="h-88 md:h-112"
    />
  )
}

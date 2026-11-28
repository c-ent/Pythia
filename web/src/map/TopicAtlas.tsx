import { useMemo } from 'react'
import { AtlasCanvas } from './AtlasCanvas'
import { buildTopicAtlasGraph } from './atlas3d'
import { topicMapDocuments, type VisibleTopicBranch } from './topicMapModel'

/**
 * Interactive 3D Topic Atlas (R20): topic root at the center, branches fanned
 * out in 3D space, and documents as luminous leaves with zoom, rotate and
 * collision-free labels.
 */
export function TopicAtlas({
  topic,
  branches,
  onBranch,
}: {
  topic: string
  branches: readonly VisibleTopicBranch[]
  onBranch: (label: string) => void
}) {
  const graph = useMemo(() => buildTopicAtlasGraph(topic, branches), [topic, branches])
  const docCount = useMemo(() => topicMapDocuments(branches).length, [branches])
  const branchCount = useMemo(() => graph.nodes.filter((node) => node.kind === 'branch').length, [graph.nodes])
  const docLabel = `${docCount} ${docCount === 1 ? 'document' : 'documents'}`
  const branchLabel = branchCount > 0 ? `${branchCount} ${branchCount === 1 ? 'branch' : 'branches'}` : null

  return (
    <AtlasCanvas
      nodes={graph.nodes}
      edges={graph.edges}
      worldRadius={graph.worldRadius}
      title={`TOPIC MAP · ${topic}`}
      subtitle={branchLabel === null ? docLabel : `${docLabel} · ${branchLabel}`}
      ariaLabel={`3D topic map for ${topic} with ${branchLabel === null ? docLabel : `${branchLabel} and ${docLabel}`}. The list view has the same outline.`}
      onSelectBranch={onBranch}
      heightClassName="h-[62dvh] min-h-104 md:h-[68dvh]"
    />
  )
}

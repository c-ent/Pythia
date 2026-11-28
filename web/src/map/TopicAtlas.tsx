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

  return (
    <AtlasCanvas
      nodes={graph.nodes}
      edges={graph.edges}
      worldRadius={graph.worldRadius}
      title={`TOPIC MAP · ${topic}`}
      subtitle={`${docCount} ${docCount === 1 ? 'document' : 'documents'} · ${branches.length} ${branches.length === 1 ? 'branch' : 'branches'}`}
      ariaLabel={`3D topic map for ${topic} with ${branches.length} branches and ${docCount} documents. The list view has the same outline.`}
      onSelectBranch={onBranch}
      heightClassName="h-[62dvh] min-h-104 md:h-[68dvh]"
    />
  )
}

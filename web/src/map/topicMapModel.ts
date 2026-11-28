import type { TopicMapBranch, TopicMapLeaf, TopicMapResponse } from '../api/topicMap'

export const DIRECT_TOPIC_MAX_DOCS = 3

export interface VisibleTopicBranch {
  label: string
  documents: TopicMapLeaf[]
  branches?: VisibleTopicBranch[]
  locked: boolean
}

export interface PartitionedTopicMap {
  directDocuments: TopicMapLeaf[]
  branches: VisibleTopicBranch[]
}

/** Never expose keyword labels computed from documents kept away from Gemini. */
export function safeTopicBranches(branches: readonly TopicMapBranch[], parent = 'Topic'): VisibleTopicBranch[] {
  return branches.map((branch, index) => {
    const children = branch.branches === undefined ? undefined : safeTopicBranches(branch.branches, `${parent} ${index + 1}`)
    const locked = branch.documents.some((document) => !document.allowLlm) || (children?.some((child) => child.locked) ?? false)
    return {
      label: locked ? `${parent} ${index + 1}` : branch.label,
      documents: branch.documents,
      ...(children === undefined ? {} : { branches: children }),
      locked,
    }
  })
}

function flattenBranch(branch: VisibleTopicBranch): TopicMapLeaf[] {
  return [...branch.documents, ...(branch.branches?.flatMap(flattenBranch) ?? [])]
}

function normalizeMultiDocBranch(branch: VisibleTopicBranch): VisibleTopicBranch {
  if (!branch.branches || branch.branches.length === 0) return branch
  const liftedDocs = [...branch.documents]
  const keptSubbranches: VisibleTopicBranch[] = []
  for (const child of branch.branches) {
    const childDocs = flattenBranch(child)
    if (childDocs.length === 1) {
      liftedDocs.push(childDocs[0]!)
    } else if (childDocs.length > 1) {
      keptSubbranches.push(child)
    }
  }
  return {
    ...branch,
    documents: liftedDocs,
    ...(keptSubbranches.length > 0 ? { branches: keptSubbranches } : {}),
  }
}

/**
 * Attaches small-map results (<= 3 docs) and 1-document branches directly to the
 * topic center so single notes never get wrapped in a redundant branch node.
 */
export function partitionTopicMap(branches: readonly VisibleTopicBranch[]): PartitionedTopicMap {
  const allDocs = branches.flatMap(flattenBranch)
  if (allDocs.length <= DIRECT_TOPIC_MAX_DOCS) {
    return { directDocuments: allDocs, branches: [] }
  }
  const directDocuments: TopicMapLeaf[] = []
  const groupedBranches: VisibleTopicBranch[] = []
  for (const branch of branches) {
    const docs = flattenBranch(branch)
    if (docs.length === 1) {
      directDocuments.push(docs[0]!)
    } else if (docs.length > 1) {
      groupedBranches.push(normalizeMultiDocBranch(branch))
    }
  }
  return { directDocuments, branches: groupedBranches }
}

export function topicMapOutline(response: TopicMapResponse): string {
  const lines = [response.topic]
  const partitioned = partitionTopicMap(safeTopicBranches(response.branches))
  const formatDoc = (document: TopicMapLeaf): string => `${document.title} (${document.source.kind}: ${document.path})`
  const visit = (branches: readonly VisibleTopicBranch[], depth: number): void => {
    for (const branch of branches) {
      lines.push(`${'  '.repeat(depth)}- ${branch.label}`)
      if (branch.branches !== undefined) visit(branch.branches, depth + 1)
      for (const document of branch.documents) lines.push(`${'  '.repeat(depth + 1)}- ${formatDoc(document)}`)
    }
  }
  visit(partitioned.branches, 1)
  for (const document of partitioned.directDocuments) {
    lines.push(`  - ${formatDoc(document)}`)
  }
  return lines.join('\n')
}

export function topicMapDocuments(branches: readonly VisibleTopicBranch[]): TopicMapLeaf[] {
  return branches.flatMap((branch) => [...branch.documents, ...(branch.branches === undefined ? [] : topicMapDocuments(branch.branches))])
}

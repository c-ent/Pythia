import type { TopicMapBranch, TopicMapLeaf, TopicMapResponse } from '../api/topicMap'

export interface VisibleTopicBranch {
  label: string
  documents: TopicMapLeaf[]
  branches?: VisibleTopicBranch[]
  locked: boolean
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

export function topicMapOutline(response: TopicMapResponse): string {
  const lines = [response.topic]
  const visit = (branches: readonly VisibleTopicBranch[], depth: number): void => {
    for (const branch of branches) {
      lines.push(`${'  '.repeat(depth)}- ${branch.label}`)
      if (branch.branches !== undefined) visit(branch.branches, depth + 1)
      for (const document of branch.documents) lines.push(`${'  '.repeat(depth + 1)}- ${document.title} (${document.source.kind}: ${document.path})`)
    }
  }
  visit(safeTopicBranches(response.branches), 1)
  return lines.join('\n')
}

export function topicMapDocuments(branches: readonly VisibleTopicBranch[]): TopicMapLeaf[] {
  return branches.flatMap((branch) => [...branch.documents, ...(branch.branches === undefined ? [] : topicMapDocuments(branch.branches))])
}

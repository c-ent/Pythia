import type { DocumentInfo } from '../api/documents'
import type { SourceKind } from '../api/search'

export interface FolderEntry {
  name: string
  path: string
  count: number
}

export interface FolderSlice {
  folders: FolderEntry[]
  files: DocumentInfo[]
}

export interface Breadcrumb {
  label: string
  path: string
}

/** Strips leading/trailing slashes and collapses repeated slashes; returns `''` for root. */
export function normalizeFolder(raw: string | null | undefined): string {
  if (raw == null) return ''
  return raw
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part !== '' && part !== '.')
    .join('/')
}

export function baseName(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? path : path.slice(slash + 1)
}

export function hasFolders(documents: readonly DocumentInfo[]): boolean {
  return documents.some((doc) => doc.path.includes('/'))
}

/**
 * Splits `documents` into direct child folders and direct files inside `folder`.
 * `folder` must already be normalized (no leading or trailing `/`).
 */
export function folderSlice(documents: readonly DocumentInfo[], folder: string): FolderSlice {
  const prefix = folder === '' ? '' : `${folder}/`
  const folderCounts = new Map<string, number>()
  const files: DocumentInfo[] = []

  for (const doc of documents) {
    if (prefix !== '' && !doc.path.startsWith(prefix)) continue
    const rest = prefix === '' ? doc.path : doc.path.slice(prefix.length)
    if (rest === '') continue
    const slash = rest.indexOf('/')
    if (slash === -1) {
      files.push(doc)
    } else {
      const name = rest.slice(0, slash)
      folderCounts.set(name, (folderCounts.get(name) ?? 0) + 1)
    }
  }

  const folders: FolderEntry[] = [...folderCounts]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, count]) => ({
      name,
      path: folder === '' ? name : `${folder}/${name}`,
      count,
    }))

  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }) || a.id - b.id)

  return { folders, files }
}

export function breadcrumbsFor(rootLabel: string, folder: string): Breadcrumb[] {
  const result: Breadcrumb[] = [{ label: rootLabel, path: '' }]
  if (folder === '') return result
  let acc = ''
  for (const part of folder.split('/')) {
    acc = acc === '' ? part : `${acc}/${part}`
    result.push({ label: part, path: acc })
  }
  return result
}

export function fileLabel(doc: DocumentInfo, source: SourceKind, inFolderView: boolean): { primary: string; secondary: string | null } {
  const file = baseName(doc.path)
  if (source === 'keep') {
    const primary = doc.title.trim() !== '' ? doc.title : file
    return { primary, secondary: inFolderView || doc.path === primary ? null : doc.path }
  }
  const primary = inFolderView ? file : doc.title.trim() !== '' && doc.title !== doc.path ? doc.title : file
  const secondary = inFolderView ? (doc.title.trim() !== '' && doc.title !== file && doc.title !== doc.path ? doc.title : null) : doc.path
  return { primary, secondary: secondary === primary ? null : secondary }
}

export function filterDocuments(documents: readonly DocumentInfo[], query: string): DocumentInfo[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...documents]
  return documents.filter(
    (doc) =>
      doc.path.toLowerCase().includes(needle) ||
      doc.title.toLowerCase().includes(needle) ||
      (doc.language !== null && doc.language.toLowerCase().includes(needle)),
  )
}

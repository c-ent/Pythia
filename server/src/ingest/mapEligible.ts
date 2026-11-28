/**
 * Which documents belong in the knowledge map (R20). Only map documents get a
 * row in `document_vectors`, so only they can show up as related documents,
 * graph nodes or topic map leaves. Everything stays searchable as before;
 * this decides the map only.
 *
 * - Every Obsidian note, Keep note and Drive document, except Drive documents
 *   in a folder on the Drive `exclude` list.
 * - From repos: `README*`, `CHANGELOG*` and `CONTRIBUTING*` at any depth, and
 *   Markdown and text files inside a `docs/` or `doc/` folder. Never code.
 * - Never: `LICENSE*`, `COPYING*`, lockfiles, `package.json`, config files,
 *   CI files under `.github/`, and `work` documents.
 *
 * Documents with no stored chunks are left out by the store, which only
 * writes a vector when the document has chunks.
 */

export interface MapEligibleOptions {
  /** Drive folders on the `exclude` list (`/config/gdrive.json`), normalized like `parseDriveConfigFile`. */
  driveExclude?: readonly string[]
}

const LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'cargo.lock',
  'poetry.lock',
  'composer.lock',
])

const DOC_EXTENSIONS = new Set(['md', 'markdown', 'mdx', 'txt'])

/** `README`, `CHANGELOG`, `CONTRIBUTING`, bare or with a suffix (`README.de.md`, `CHANGELOG-v1.md`). */
const MAP_NAMES = /^(?:readme|changelog|contributing)(?:[._-][\w.-]*)?$/

/** Extensions those files are written in; a `README.ts` is code, not a README. */
const MAP_NAME_EXTENSIONS = new Set([...DOC_EXTENSIONS, 'rst', 'adoc', 'org'])

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1)
}

/** Same folder rule as the Drive indexer: the folder itself or anything inside it, case-sensitive. */
const inDriveFolder = (relPath: string, folders: readonly string[]): boolean =>
  folders.some((folder) => relPath === folder || relPath.startsWith(`${folder}/`))

/** Licence texts, lockfiles, manifests, config and CI files: they cluster together and say nothing. */
function isBoilerplate(segments: readonly string[], name: string): boolean {
  if (name.startsWith('license') || name.startsWith('licence') || name.startsWith('copying')) return true
  if (LOCKFILES.has(name) || name === 'package.json') return true
  if (/\.config\./.test(name) || /^tsconfig.*\.json$/.test(name)) return true
  if (name.startsWith('.eslintrc') || name.startsWith('.prettierrc') || name === '.editorconfig') return true
  if (name === 'dockerfile' || /^docker-compose.*\.ya?ml$/.test(name)) return true
  const github = segments.indexOf('.github')
  if (github !== -1 && github < segments.length - 1) {
    // CI files: workflows and the YAML config GitHub reads (dependabot, issue forms).
    if (segments[github + 1] === 'workflows') return true
    if (/\.ya?ml$/.test(name)) return true
  }
  return false
}

/** True when a repo-relative path (with `/` separators) is a map document. */
export function isRepoMapPath(repoPath: string): boolean {
  const segments = repoPath.toLowerCase().split('/')
  const name = segments[segments.length - 1] ?? ''
  if (name === '' || isBoilerplate(segments, name)) return false
  const extension = extensionOf(name)
  if (MAP_NAMES.test(name) && (!name.includes('.') || MAP_NAME_EXTENSIONS.has(extension))) return true
  const folders = segments.slice(0, -1)
  return (folders.includes('docs') || folders.includes('doc')) && DOC_EXTENSIONS.has(extension)
}

/** True when a document of this source kind and path belongs in the knowledge map. */
export function isMapDocument(kind: string, docPath: string, options: MapEligibleOptions = {}): boolean {
  switch (kind) {
    case 'obsidian':
    case 'keep':
      return true
    case 'gdrive':
      return !inDriveFolder(docPath, options.driveExclude ?? [])
    case 'repo':
      return isRepoMapPath(docPath)
    default:
      // `work` never; `chat` is not on the R20 list.
      return false
  }
}

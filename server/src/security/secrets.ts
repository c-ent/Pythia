export type SecretKind =
  | 'aws-access-key-id'
  | 'aws-secret-access-key'
  | 'google-api-key'
  | 'github-token'
  | 'private-key-block'
  | 'jwt'

interface SecretPattern {
  kind: SecretKind
  pattern: RegExp
}

// Non-global regexes on purpose: a /g regex keeps lastIndex between .test()
// calls and silently misses matches on the next chunk.
const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    kind: 'aws-secret-access-key',
    pattern: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/i,
  },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}/ },
  { kind: 'github-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}/ },
  // BEGIN and END are both checked because the chunker can split a PEM block,
  // leaving the header in one chunk and the key body plus footer in the next.
  {
    kind: 'private-key-block',
    pattern: /-----(?:BEGIN|END) (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/,
  },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
]

const BLOCKED_DIRECTORY_NAMES = new Set(['.git'])

function isBlockedFileName(name: string): boolean {
  return (
    name.startsWith('.env') ||
    name.startsWith('id_rsa') ||
    name.startsWith('credentials') ||
    name.endsWith('.pem') ||
    name.endsWith('.key')
  )
}

/**
 * True when a file must never be read for indexing. Accepts `/` or `\`
 * separators and matches case-insensitively, so `Secrets/.ENV.local` and
 * `keys\ID_RSA.pub` are both blocked.
 */
export function isBlockedPath(path: string): boolean {
  const segments = path
    .toLowerCase()
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0)
  const fileName = segments.at(-1)
  if (fileName === undefined) return false
  if (segments.some((segment) => BLOCKED_DIRECTORY_NAMES.has(segment))) return true
  return isBlockedFileName(fileName)
}

/**
 * Kinds of secret found in the text. Only the kinds are returned, never the
 * matched text, so callers cannot accidentally log a secret value.
 */
export function detectSecretKinds(text: string): SecretKind[] {
  const kinds = new Set<SecretKind>()
  for (const { kind, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) kinds.add(kind)
  }
  return [...kinds]
}

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some(({ pattern }) => pattern.test(text))
}

export interface SecretsDropEvent {
  file: string
  droppedCount: number
}

export type SecretsDropLogger = (event: SecretsDropEvent) => void

export const logSecretsDrop: SecretsDropLogger = (event) => {
  console.warn('secrets scan dropped chunks', event)
}

/**
 * Removes every chunk that contains a secret. Reports only the file and the
 * number of dropped chunks, and only when something was dropped.
 */
export function dropSecretChunks<T extends { content: string }>(
  file: string,
  chunks: readonly T[],
  log: SecretsDropLogger = logSecretsDrop,
): T[] {
  const kept = chunks.filter((chunk) => !containsSecret(chunk.content))
  const droppedCount = chunks.length - kept.length
  if (droppedCount > 0) log({ file, droppedCount })
  return kept
}

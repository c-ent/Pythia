const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "now", "5 min ago", "3h ago", "2d ago", then the date. */
export function formatLastSeen(iso: string, now = Date.now()): string {
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return iso
  const ago = Math.max(0, now - at)
  if (ago < 2 * MINUTE) return 'now'
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`
  if (ago < DAY) return `${Math.floor(ago / HOUR)}h ago`
  if (ago < 30 * DAY) return `${Math.floor(ago / DAY)}d ago`
  return new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

/** The MCP address of this server: same origin as the app. */
export function mcpServerUrl(origin = window.location.origin): string {
  return `${origin}/mcp`
}

export const TOKEN_PLACEHOLDER = '<your token>'

/**
 * `claude mcp add` command for Claude Code. It is the only snippet offered (R15): it stores the token in the
 * user's Claude config, never in a project file that could be committed.
 */
export function claudeCodeCommand(url: string, token: string = TOKEN_PLACEHOLDER): string {
  return `claude mcp add --transport http pythia ${url} --header "Authorization: Bearer ${token}"`
}

/** The tools `/mcp` exposes (server/src/mcp/mcpServer.ts). The repo tools need repo indexing. */
export const MCP_TOOLS: readonly { name: string; repos?: true }[] = [
  { name: 'search' },
  { name: 'get_document' },
  { name: 'recent_changes' },
  { name: 'related_documents' },
  { name: 'backlinks' },
  { name: 'topic_map' },
  { name: 'list_repos', repos: true },
  { name: 'get_repo_overview', repos: true },
]

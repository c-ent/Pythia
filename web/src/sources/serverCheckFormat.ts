import { Check, CircleAlert, X } from 'lucide-react'
import { serverCheckLabel, type ServerCheck } from '../api/serverStatus'
import { formatBytes } from '../offline/storage'

export function serverCheckState(check: ServerCheck): { label: string; tone: string; Icon: typeof Check } {
  if (check.state === 'broken') return { label: 'Broken', tone: 'text-danger', Icon: X }
  if (check.state === 'off') return { label: 'Not set up', tone: 'text-muted', Icon: CircleAlert }
  return { label: 'OK', tone: 'text-success', Icon: Check }
}

export function serverCheckDetails(check: ServerCheck): string[] {
  const details: string[] = []
  if (check.reason) details.push(check.reason)
  if (typeof check.modelInstalled === 'boolean') {
    details.push(check.modelInstalled ? 'Embedding model installed' : 'Embedding model missing')
  }
  if (typeof check.modelLoaded === 'boolean') details.push(check.modelLoaded ? 'Model loaded' : 'Model not loaded')
  if (typeof check.modelMemoryBytes === 'number' && check.modelMemoryBytes > 0) {
    details.push(`${formatBytes(check.modelMemoryBytes)} model memory`)
  }
  if (typeof check.remainingCore === 'number') {
    details.push(`${check.remainingCore.toLocaleString()} GitHub requests remaining`)
  }
  if (Array.isArray(check.states)) {
    for (const value of check.states) {
      if (value !== null && typeof value === 'object' && 'id' in value && 'state' in value) {
        const row = value as { id: unknown; state: unknown; reason?: unknown }
        const name = typeof row.id === 'string' ? serverCheckLabel(row.id) : 'Source'
        details.push(`${name}: ${String(row.state)}${typeof row.reason === 'string' ? ` · ${row.reason}` : ''}`)
      }
    }
  }
  return details
}

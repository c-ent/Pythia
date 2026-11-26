import { ApiError } from '../api/client'
import type { KeepImportResult } from '../api/imports'
import { plural } from '../repos/format'

export function importErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'Can’t reach the server. Check your connection and try again.'
    // The server's 400 messages are written for people ("No Google Keep notes found in this zip").
    if (error.status === 400 || error.status === 409) return error.message
    if (error.status === 413) return 'This zip is too large to upload. Export Keep on its own in Google Takeout.'
    if (error.status === 404) return 'Keep import isn’t set up on the server yet.'
  }
  return 'The import failed. Try again.'
}

export function importSummary(result: KeepImportResult): string {
  const parts = [`${plural(result.notes, 'note')} imported`]
  if (result.indexed > 0) parts.push(`${result.indexed.toLocaleString('en-US')} new or changed`)
  if (result.unchanged > 0) parts.push(`${result.unchanged.toLocaleString('en-US')} unchanged`)
  if (result.deleted > 0) parts.push(`${result.deleted.toLocaleString('en-US')} removed`)
  const skipped = result.skipped.trashed + result.skipped.empty + result.skipped.blocked + result.skipped.tooLarge
  if (skipped > 0) parts.push(`${skipped.toLocaleString('en-US')} skipped`)
  return `${parts.join(' · ')}.`
}

export function statusErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 0) return 'Can’t reach the server. Check your connection and try again.'
  if (error instanceof ApiError && error.status === 404) return 'Index status isn’t available on this server yet.'
  return 'Couldn’t load index status. Try again.'
}

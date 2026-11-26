import { strToU8, zipSync } from 'fflate'

// Test-only helpers: build Google Takeout zips in memory, so no real export
// (and no personal note) is ever committed as a fixture.

/** A Keep note JSON in the shape Google Takeout writes. */
export const keepJson = (over: Record<string, unknown> = {}): Uint8Array =>
  strToU8(
    JSON.stringify({
      color: 'DEFAULT',
      isTrashed: false,
      isPinned: false,
      isArchived: false,
      textContent: 'Buy oat milk',
      title: 'Groceries',
      userEditedTimestampUsec: 1_732_000_000_000_000,
      createdTimestampUsec: 1_731_000_000_000_000,
      ...over,
    }),
  )

/** Builds a Takeout-shaped zip; entries are relative to `Takeout/Keep/` unless they start with `/`. */
export function takeoutZip(entries: Record<string, Uint8Array | string>): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  for (const [name, data] of Object.entries(entries)) {
    const path = name.startsWith('/') ? name.slice(1) : `Takeout/Keep/${name}`
    files[path] = typeof data === 'string' ? strToU8(data) : data
  }
  return zipSync(files)
}

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Compares two secrets in constant time. Both sides are hashed first so the
 * comparison also hides the length of the expected value.
 */
export function secretsEqual(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/** A random URL-safe secret; 32 bytes gives 43 characters. */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

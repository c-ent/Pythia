import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM for secrets kept in the database (R16, T39), keyed on
 * `PYTHIA_SECRETS_KEY` from `.env`. The database holds only the ciphertext,
 * the IV and the auth tag, so a copy of the database alone reveals nothing.
 */

export const SECRETS_KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const ALGORITHM = 'aes-256-gcm'

export interface SealedSecret {
  ciphertext: Buffer
  iv: Buffer
  authTag: Buffer
}

// 32 bytes are 43 base64 characters plus one optional `=`; `-` and `_` (base64url) are accepted too.
const KEY_TEXT = /^[A-Za-z0-9+/_-]{43}=?$/

/** The 32-byte key from its base64 text, or null when the text is not exactly that. */
export function parseSecretsKey(text: string): Buffer | null {
  const trimmed = text.trim()
  if (!KEY_TEXT.test(trimmed)) return null
  const key = Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  return key.length === SECRETS_KEY_BYTES ? key : null
}

/** A new random key as base64 text, the form `.env` holds. */
export function generateSecretsKey(): string {
  return randomBytes(SECRETS_KEY_BYTES).toString('base64')
}

function checkKey(key: Buffer): void {
  if (key.length !== SECRETS_KEY_BYTES) throw new RangeError(`secrets key must be ${SECRETS_KEY_BYTES} bytes`)
}

/**
 * Encrypts `plaintext` with a fresh random IV. `context` names what the secret
 * is for and is bound in as associated data, so a ciphertext saved for one
 * purpose cannot be opened as another.
 */
export function sealSecret(key: Buffer, plaintext: string, context: string): SealedSecret {
  checkKey(key)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(context, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return { ciphertext, iv, authTag: cipher.getAuthTag() }
}

/**
 * The plaintext, or null when it cannot be opened: a different key (say,
 * after a restore with another `.env`), another context, or changed bytes.
 */
export function openSecret(key: Buffer, sealed: SealedSecret, context: string): string | null {
  checkKey(key)
  if (sealed.iv.length !== IV_BYTES || sealed.authTag.length !== TAG_BYTES) return null
  try {
    const decipher = createDecipheriv(ALGORITHM, key, sealed.iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(Buffer.from(context, 'utf8'))
    decipher.setAuthTag(sealed.authTag)
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

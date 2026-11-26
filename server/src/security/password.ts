import { argon2, randomBytes, timingSafeEqual } from 'node:crypto'

// Node's built-in argon2 (node:crypto, Node 24.7+) is used instead of the
// `argon2` package, so there is no native install script to approve.

/** Argon2id cost: memory in KiB, number of passes, number of lanes. */
export interface Argon2Cost {
  memory: number
  passes: number
  parallelism: number
}

// Above OWASP's argon2id minimum (19 MiB, 2 passes); still well under a second
// per login on the Oracle Arm host.
export const DEFAULT_COST: Argon2Cost = { memory: 65_536, passes: 3, parallelism: 4 }

// Upper bounds for a hash read from config, so a bad value cannot make every
// login attempt use gigabytes of memory.
const MAX_COST: Argon2Cost = { memory: 262_144, passes: 10, parallelism: 16 }
const SALT_BYTES = 16
const KEY_BYTES = 32

export interface PasswordHash {
  cost: Argon2Cost
  salt: Buffer
  key: Buffer
}

function derive(password: string, salt: Buffer, cost: Argon2Cost, tagLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', { message: password, nonce: salt, tagLength, ...cost }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

const toBase64 = (bytes: Buffer): string => bytes.toString('base64').replace(/=+$/, '')

/** Hashes `password` into a PHC string: `$argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<key>`. */
export async function hashPassword(password: string, cost: Argon2Cost = DEFAULT_COST): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const key = await derive(password, salt, cost, KEY_BYTES)
  return `$argon2id$v=19$m=${cost.memory},t=${cost.passes},p=${cost.parallelism}$${toBase64(salt)}$${toBase64(key)}`
}

const PHC = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/

/** Parses an argon2id PHC string, or returns null when it is malformed or its cost is out of bounds. */
export function parsePasswordHash(hash: string): PasswordHash | null {
  const match = PHC.exec(hash)
  if (match === null) return null
  const cost: Argon2Cost = { memory: Number(match[1]), passes: Number(match[2]), parallelism: Number(match[3]) }
  if (cost.parallelism < 1 || cost.parallelism > MAX_COST.parallelism) return null
  if (cost.passes < 1 || cost.passes > MAX_COST.passes) return null
  if (cost.memory < 8 * cost.parallelism || cost.memory > MAX_COST.memory) return null
  const salt = Buffer.from(match[4] ?? '', 'base64')
  const key = Buffer.from(match[5] ?? '', 'base64')
  if (salt.length < 8 || key.length < 16 || key.length > 64) return null
  return { cost, salt, key }
}

/** Recomputes the key for `password` and compares it in constant time. */
export async function verifyPassword(password: string, hash: PasswordHash): Promise<boolean> {
  const key = await derive(password, hash.salt, hash.cost, hash.key.length)
  return timingSafeEqual(key, hash.key)
}

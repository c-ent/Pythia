import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto'

export interface OciSigningCredentials {
  tenancyId: string
  userId: string
  fingerprint: string
  privateKey: KeyObject
}

export interface OciSigningInput {
  method: string
  target: string
  host: string
  date: string
  body?: Uint8Array | string
  contentType?: string
}

export interface SignedOciRequest {
  date: string
  authorization: string
  headers: Record<string, string>
  signingString: string
  signature: string
}

export class OciKeyError extends Error {
  override name = 'InvalidKeyFile'
}

/** Parses an unencrypted RSA private key PEM without echoing key material in errors. */
export function parseOciPrivateKey(pem: string): KeyObject {
  try {
    const key = createPrivateKey({ key: pem, format: 'pem' })
    if (key.asymmetricKeyType !== 'rsa') {
      throw new OciKeyError('OCI key must be an RSA private key')
    }
    return key
  } catch (error) {
    if (error instanceof OciKeyError) throw error
    throw new OciKeyError('OCI private key is invalid or encrypted')
  }
}

/** Builds the canonical OCI Signature v1 signing string and payload headers. */
export function buildOciSigningString(input: OciSigningInput): {
  headersList: string[]
  signingString: string
  contentHeaders: Record<string, string>
} {
  const method = input.method.toUpperCase()
  const requestTarget = `${method.toLowerCase()} ${input.target}`
  const headersList = ['date', '(request-target)', 'host']
  const values: Record<string, string> = {
    date: input.date,
    '(request-target)': requestTarget,
    host: input.host,
  }
  const contentHeaders: Record<string, string> = {}

  if (method === 'POST' || method === 'PUT' || input.body !== undefined) {
    const bytes =
      input.body === undefined
        ? Buffer.alloc(0)
        : typeof input.body === 'string'
          ? Buffer.from(input.body, 'utf8')
          : Buffer.from(input.body)
    const contentLength = String(bytes.byteLength)
    const contentType = input.contentType ?? 'application/json'
    const contentSha256 = createHash('sha256').update(bytes).digest('base64')

    headersList.push('content-length', 'content-type', 'x-content-sha256')
    values['content-length'] = contentLength
    values['content-type'] = contentType
    values['x-content-sha256'] = contentSha256

    contentHeaders['content-length'] = contentLength
    contentHeaders['content-type'] = contentType
    contentHeaders['x-content-sha256'] = contentSha256
  }

  const signingString = headersList.map((name) => `${name}: ${values[name]}`).join('\n')
  return { headersList, signingString, contentHeaders }
}

/** Signs an OCI REST request using RSA-SHA256 and Signature v1 headers. */
export function signOciRequest(
  credentials: OciSigningCredentials,
  input: {
    method: string
    url: string | URL
    date?: string
    body?: Uint8Array | string
    contentType?: string
  },
): SignedOciRequest {
  const url = input.url instanceof URL ? input.url : new URL(input.url)
  const date = input.date ?? new Date().toUTCString()
  const target = `${url.pathname}${url.search}`
  const { headersList, signingString, contentHeaders } = buildOciSigningString({
    method: input.method,
    target,
    host: url.host,
    date,
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
  })

  const signature = sign('RSA-SHA256', Buffer.from(signingString, 'utf8'), credentials.privateKey).toString('base64')
  const keyId = `${credentials.tenancyId}/${credentials.userId}/${credentials.fingerprint}`
  const authorization =
    `Signature version="1",headers="${headersList.join(' ')}",` +
    `keyId="${keyId}",algorithm="rsa-sha256",signature="${signature}"`

  return {
    date,
    authorization,
    headers: {
      date,
      ...contentHeaders,
      authorization,
    },
    signingString,
    signature,
  }
}

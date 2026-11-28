import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { OciConfig } from '../../config.js'
import {
  buildOciSigningString,
  createOciClient,
  ociEndpointHost,
  parseOciPrivateKey,
  signOciRequest,
} from './index.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const TEST_TENANCY = 'ocid1.tenancy.oc1..aaaaaaaaba3pv6wkcr4jqae5f15p2b2m2yt2j6rx32uzr4h25vqstifsfdsq'
const TEST_USER = 'ocid1.user.oc1..aaaaaaaayz4exampleuserocid1234567890'
const TEST_FINGERPRINT = '12:34:56:78:90:ab:cd:ef:12:34:56:78:90:ab:cd:ef'

function testConfig(overrides: Partial<OciConfig> = {}): OciConfig {
  return {
    tenancyId: TEST_TENANCY,
    userId: TEST_USER,
    fingerprint: TEST_FINGERPRINT,
    region: 'us-phoenix-1',
    keyFile: '/config/oci_api_key.pem',
    ...overrides,
  }
}

describe('OCI RSA-SHA256 request signing', () => {
  it('matches Oracle Request Signatures canonical GET vector and verifies with RSA-SHA256', () => {
    // Oracle Request Signatures docs example timestamp, target and host
    const date = 'Thu, 05 Jan 2014 21:31:40 GMT'
    const url =
      'https://iaas.us-phoenix-1.oraclecloud.com/20160918/instances?availabilityDomain=Pjwf%3APHOENIX-AD-1&compartmentId=ocid1.compartment.oc1..aaaaaaaam3we6vgnherjq5q2idn2t3h'

    const signed = signOciRequest(
      {
        tenancyId: TEST_TENANCY,
        userId: TEST_USER,
        fingerprint: TEST_FINGERPRINT,
        privateKey: parseOciPrivateKey(privatePem),
      },
      { method: 'GET', url, date },
    )

    expect(signed.signingString).toBe(
      [
        'date: Thu, 05 Jan 2014 21:31:40 GMT',
        '(request-target): get /20160918/instances?availabilityDomain=Pjwf%3APHOENIX-AD-1&compartmentId=ocid1.compartment.oc1..aaaaaaaam3we6vgnherjq5q2idn2t3h',
        'host: iaas.us-phoenix-1.oraclecloud.com',
      ].join('\n'),
    )
    expect(signed.headers).toEqual({
      date,
      authorization: signed.authorization,
    })
    expect(signed.authorization).toBe(
      `Signature version="1",headers="date (request-target) host",keyId="${TEST_TENANCY}/${TEST_USER}/${TEST_FINGERPRINT}",algorithm="rsa-sha256",signature="${signed.signature}"`,
    )

    const valid = verify(
      'RSA-SHA256',
      Buffer.from(signed.signingString, 'utf8'),
      publicKey,
      Buffer.from(signed.signature, 'base64'),
    )
    expect(valid).toBe(true)
  })

  it('adds content-length, content-type and x-content-sha256 for POST requests', () => {
    const date = 'Thu, 05 Jan 2014 21:31:40 GMT'
    const body = JSON.stringify({ namespace: 'oci_computeagent', query: 'CpuUtilization[1m].percentile(0.95)' })
    const expectedSha = createHash('sha256').update(body, 'utf8').digest('base64')

    const built = buildOciSigningString({
      method: 'POST',
      target: '/20180401/metrics/actions/summarizeMetricsData?compartmentId=abc',
      host: 'telemetry.us-phoenix-1.oraclecloud.com',
      date,
      body,
    })

    expect(built.headersList).toEqual([
      'date',
      '(request-target)',
      'host',
      'content-length',
      'content-type',
      'x-content-sha256',
    ])
    expect(built.contentHeaders).toEqual({
      'content-length': String(Buffer.byteLength(body, 'utf8')),
      'content-type': 'application/json',
      'x-content-sha256': expectedSha,
    })
    expect(built.signingString).toBe(
      [
        `date: ${date}`,
        '(request-target): post /20180401/metrics/actions/summarizeMetricsData?compartmentId=abc',
        'host: telemetry.us-phoenix-1.oraclecloud.com',
        `content-length: ${Buffer.byteLength(body, 'utf8')}`,
        'content-type: application/json',
        `x-content-sha256: ${expectedSha}`,
      ].join('\n'),
    )

    const signed = signOciRequest(
      {
        tenancyId: TEST_TENANCY,
        userId: TEST_USER,
        fingerprint: TEST_FINGERPRINT,
        privateKey: parseOciPrivateKey(privatePem),
      },
      {
        method: 'POST',
        url: 'https://telemetry.us-phoenix-1.oraclecloud.com/20180401/metrics/actions/summarizeMetricsData?compartmentId=abc',
        date,
        body,
      },
    )
    expect(
      verify('RSA-SHA256', Buffer.from(signed.signingString, 'utf8'), publicKey, Buffer.from(signed.signature, 'base64')),
    ).toBe(true)
  })

  it('rejects non-RSA or invalid PEM keys without echoing PEM contents', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const ecPem = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(() => parseOciPrivateKey(ecPem)).toThrow(/RSA private key/)
    try {
      parseOciPrivateKey('not-a-valid-key-body')
    } catch (error) {
      expect(String(error)).not.toContain('not-a-valid-key-body')
    }
  })
})

describe('OCI client & health check', () => {
  it('returns off when config is null or any required field is empty', async () => {
    const fetchSpy = vi.fn()
    const readSpy = vi.fn()
    for (const cfg of [
      null,
      testConfig({ tenancyId: '' }),
      testConfig({ userId: '' }),
      testConfig({ fingerprint: '' }),
      testConfig({ region: '' }),
      testConfig({ keyFile: '' }),
    ]) {
      const client = createOciClient(cfg, { fetch: fetchSpy, readFile: readSpy })
      expect(client.isConfigured()).toBe(false)
      expect(await client.checkHealth()).toEqual({ state: 'off', reason: null })
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(readSpy).not.toHaveBeenCalled()
  })

  it('targets only Oracle endpoints for the configured region', () => {
    expect(ociEndpointHost('identity', 'ap-singapore-1')).toBe('identity.ap-singapore-1.oci.oraclecloud.com')
    expect(ociEndpointHost('iaas', 'ap-singapore-1')).toBe('iaas.ap-singapore-1.oraclecloud.com')
    expect(ociEndpointHost('limits', 'ap-singapore-1')).toBe('limits.ap-singapore-1.oraclecloud.com')
    expect(ociEndpointHost('telemetry', 'ap-singapore-1')).toBe('telemetry.ap-singapore-1.oraclecloud.com')
    expect(ociEndpointHost('usageapi', 'ap-singapore-1')).toBe('usageapi.ap-singapore-1.oci.oraclecloud.com')
    expect(() => ociEndpointHost('identity', 'evil.example.com')).toThrow(/Invalid OCI region/)
  })

  it('calls GetTenancy with a valid RSA-SHA256 signature and returns ok without OCIDs', async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      expect(url).toBe(`https://identity.us-phoenix-1.oci.oraclecloud.com/20160918/tenancies/${TEST_TENANCY}`)
      expect(init?.method).toBe('GET')
      const headers = init?.headers as Record<string, string>
      expect(headers.authorization).toContain(`keyId="${TEST_TENANCY}/${TEST_USER}/${TEST_FINGERPRINT}"`)
      return Response.json({ id: TEST_TENANCY, name: 'my-tenancy', homeRegionKey: 'PHX' })
    })
    const client = createOciClient(testConfig(), {
      fetch: fetchSpy as typeof fetch,
      readFile: vi.fn(async () => privatePem),
      now: () => Date.UTC(2026, 10, 28, 7, 0, 0),
    })

    const result = await client.checkHealth()
    expect(result).toEqual({ state: 'ok', reason: null })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(TEST_TENANCY)
    expect(serialized).not.toContain(TEST_USER)
    expect(serialized).not.toContain(TEST_FINGERPRINT)
    expect(serialized).not.toContain('my-tenancy')
  })

  it('reports KeyFileMissing, KeyFileUnreadable and InvalidKeyFile safely', async () => {
    const missing = createOciClient(testConfig(), {
      readFile: vi.fn(async () => {
        throw Object.assign(new Error(`ENOENT ${TEST_TENANCY}`), { code: 'ENOENT' })
      }),
    })
    expect(await missing.checkHealth()).toEqual({ state: 'broken', reason: 'KeyFileMissing' })

    const unreadable = createOciClient(testConfig(), {
      readFile: vi.fn(async () => {
        throw Object.assign(new Error(`EACCES ${TEST_USER}`), { code: 'EACCES' })
      }),
    })
    expect(await unreadable.checkHealth()).toEqual({ state: 'broken', reason: 'KeyFileUnreadable' })

    const invalid = createOciClient(testConfig(), {
      readFile: vi.fn(async () => 'not a pem'),
    })
    expect(await invalid.checkHealth()).toEqual({ state: 'broken', reason: 'InvalidKeyFile' })
  })

  it('reports ClockSkew on 401 skew responses and HttpStatus on other errors without leaking secrets', async () => {
    const clockSkewClient = createOciClient(testConfig(), {
      readFile: vi.fn(async () => privatePem),
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: 'NotAuthenticated',
              message: `Date header is outside the allowed clock skew for ${TEST_TENANCY}`,
            }),
            { status: 401 },
          ),
      ) as typeof fetch,
    })
    expect(await clockSkewClient.checkHealth()).toEqual({ state: 'broken', reason: 'ClockSkew' })

    const authFailClient = createOciClient(testConfig(), {
      readFile: vi.fn(async () => privatePem),
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ code: 'NotAuthenticated', message: `bad ${TEST_FINGERPRINT}` }), { status: 401 }),
      ) as typeof fetch,
    })
    expect(await authFailClient.checkHealth()).toEqual({ state: 'broken', reason: 'Http401' })

    const networkLeakClient = createOciClient(testConfig(), {
      readFile: vi.fn(async () => privatePem),
      fetch: vi.fn(async () => {
        const err = new Error(`connect failed ${TEST_TENANCY} ${TEST_USER} ${TEST_FINGERPRINT} ${privatePem}`)
        err.name = 'FetchError'
        throw err
      }) as typeof fetch,
    })
    const res = await networkLeakClient.checkHealth()
    expect(res).toEqual({ state: 'broken', reason: 'FetchError' })
    const serialized = JSON.stringify(res)
    expect(serialized).not.toContain(TEST_TENANCY)
    expect(serialized).not.toContain(TEST_USER)
    expect(serialized).not.toContain(TEST_FINGERPRINT)
    expect(serialized).not.toContain('PRIVATE KEY')
  })
})

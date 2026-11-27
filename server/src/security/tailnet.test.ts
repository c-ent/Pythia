import { describe, expect, it } from 'vitest'
import { isTailscaleAddress, requestOrigin } from './tailnet.js'

const LOCAL = '127.0.0.1'

describe('isTailscaleAddress', () => {
  it('accepts the CGNAT and ULA ranges', () => {
    expect(isTailscaleAddress('100.64.0.1')).toBe(true)
    expect(isTailscaleAddress('100.101.102.103')).toBe(true)
    expect(isTailscaleAddress('100.127.255.254')).toBe(true)
    expect(isTailscaleAddress('fd7a:115c:a1e0:ab12:4843:cd96:6258:b240')).toBe(true)
    expect(isTailscaleAddress('::ffff:100.64.1.2')).toBe(true)
  })

  it('rejects public, private, ChromeOS and malformed addresses', () => {
    for (const address of ['8.8.8.8', '100.63.255.255', '100.128.0.0', '192.168.1.10', '10.0.0.1', '127.0.0.1', '2001:db8::1', '::1']) {
      expect(isTailscaleAddress(address), address).toBe(false)
    }
    expect(isTailscaleAddress('100.115.92.5')).toBe(false)
    expect(isTailscaleAddress('')).toBe(false)
    expect(isTailscaleAddress('100.64.0.1, 8.8.8.8')).toBe(false)
    expect(isTailscaleAddress('fd7a:115c:a1e0::1%eth0')).toBe(false)
    expect(isTailscaleAddress('nope')).toBe(false)
  })
})

describe('requestOrigin', () => {
  it('marks a request carrying the Funnel header, in any spelling, as funnel', () => {
    expect(requestOrigin({ 'tailscale-funnel-request': '?1', 'x-forwarded-for': '203.0.113.9' }, LOCAL)).toBe('funnel')
    // A tailnet-looking address does not outweigh the Funnel header.
    expect(requestOrigin({ 'tailscale-funnel-request': '?1', 'x-forwarded-for': '100.64.0.1' }, LOCAL)).toBe('funnel')
    expect(requestOrigin({ tailscale_funnel_request: '?0' }, LOCAL)).toBe('funnel')
    expect(requestOrigin({ 'tailscale-funnel-request': '' }, LOCAL)).toBe('funnel')
  })

  it('marks Serve traffic from a tailnet address as tailnet', () => {
    expect(requestOrigin({ 'x-forwarded-for': '100.101.102.103', 'x-forwarded-proto': 'https' }, LOCAL)).toBe('tailnet')
    expect(requestOrigin({ 'x-forwarded-for': ' fd7a:115c:a1e0::5 ', 'tailscale-user-login': 'me@example.com' }, LOCAL)).toBe('tailnet')
  })

  it('fails closed on proxied requests it cannot place', () => {
    // A Funnel request if Tailscale ever stopped setting the Funnel header.
    expect(requestOrigin({ 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' }, LOCAL)).toBe('unknown')
    expect(requestOrigin({ 'x-forwarded-for': '100.64.0.1, 203.0.113.9' }, LOCAL)).toBe('unknown')
    expect(requestOrigin({ 'x-forwarded-for': '' }, LOCAL)).toBe('unknown')
    expect(requestOrigin({ 'x-forwarded-host': 'pythia.example.ts.net' }, LOCAL)).toBe('unknown')
    expect(requestOrigin({ forwarded: 'for=100.64.0.1' }, LOCAL)).toBe('unknown')
    expect(requestOrigin({ via: '1.1 proxy' }, LOCAL)).toBe('unknown')
    expect(requestOrigin({ 'tailscale-user-login': 'me@example.com' }, LOCAL)).toBe('unknown')
  })

  it('marks a plain loopback request as host and anything else as unknown', () => {
    expect(requestOrigin({ host: '127.0.0.1:3000', authorization: 'Bearer x' }, '127.0.0.1')).toBe('host')
    expect(requestOrigin({}, '::1')).toBe('host')
    expect(requestOrigin({}, '::ffff:127.0.0.1')).toBe('host')
    expect(requestOrigin({}, '100.64.0.1')).toBe('unknown')
    expect(requestOrigin({}, undefined)).toBe('unknown')
  })
})

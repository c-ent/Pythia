import { BlockList, isIP } from 'node:net'
import type { IncomingHttpHeaders } from 'node:http'

/**
 * Where a request to `/mcp` came from, as far as the server can tell (R7).
 *
 * - `tailnet`: through Tailscale Serve from a device on the owner's tailnet.
 * - `host`: straight to 127.0.0.1 from the host itself, with no proxy in between.
 * - `funnel`: through Tailscale Funnel, from the public internet.
 * - `unknown`: anything else. Treated like `funnel`, so `/mcp` fails closed.
 */
export type RequestOrigin = 'tailnet' | 'host' | 'funnel' | 'unknown'

// Tailscale's address ranges, from tailscale `net/tsaddr/tsaddr.go`:
// `IsTailscaleIP` is the CGNAT range minus the ChromeOS VM range, or the ULA range.
const tailnetRanges = new BlockList()
tailnetRanges.addSubnet('100.64.0.0', 10, 'ipv4')
tailnetRanges.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6')
const chromeOsRange = new BlockList()
chromeOsRange.addSubnet('100.115.92.0', 23, 'ipv4')

/** True when `address` is a single Tailscale address (IPv4-mapped IPv6 counts as IPv4). */
export function isTailscaleAddress(address: string): boolean {
  if (address.includes('%')) return false
  const version = isIP(address)
  if (version === 0) return false
  const type = version === 4 ? 'ipv4' : 'ipv6'
  return tailnetRanges.check(address, type) && !chromeOsRange.check(address, type)
}

const FUNNEL_HEADER = 'tailscale-funnel-request'

// Headers only a proxy sets. A request straight from the host carries none of them.
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'via']

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Classifies a request from its headers and the socket's address.
 *
 * Tailscale's Serve/Funnel HTTP proxy (`ipn/ipnlocal/serve.go`) first deletes
 * any `Tailscale-Funnel-Request` the client sent, in every spelling
 * (`delHeaderVariants`, case-insensitive, `_` read as `-`), then sets it to
 * `?1` on Funnel traffic. It also *sets* `X-Forwarded-For` to the connecting
 * address: the public visitor's for Funnel, the peer's Tailscale address for
 * tailnet traffic.
 *
 * Two checks, so either one alone keeps the public out:
 * 1. Any spelling or value of the Funnel header means `funnel`.
 * 2. Otherwise a proxied request is `tailnet` only when `X-Forwarded-For` is
 *    exactly one Tailscale address; a public, listed, empty or unreadable value
 *    is `unknown`. So if Tailscale ever stopped setting the Funnel header, a
 *    Funnel visitor's public address would still be refused.
 *
 * A request with no proxy headers at all, from a loopback socket, is `host`.
 * The server binds to 127.0.0.1 only, so that is a request made on the host,
 * or a Funnel configured as a raw TCP forward (`--tcp`, `--tls-terminated-tcp`),
 * which sets no headers. Funnel must therefore stay an HTTP proxy
 * (`tailscale funnel 3000`), as the per-visitor login limit (T27) already needs.
 */
export function requestOrigin(headers: IncomingHttpHeaders, remoteAddress: string | undefined): RequestOrigin {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase().replaceAll('_', '-') === FUNNEL_HEADER) return 'funnel'
  }
  const proxied = PROXY_HEADERS.some((name) => headers[name] !== undefined)
  if (!proxied && !Object.keys(headers).some((name) => name.toLowerCase().startsWith('tailscale'))) {
    return remoteAddress !== undefined && LOOPBACK.has(remoteAddress) ? 'host' : 'unknown'
  }
  const forwardedFor = headers['x-forwarded-for']
  if (typeof forwardedFor !== 'string') return 'unknown'
  return isTailscaleAddress(forwardedFor.trim()) ? 'tailnet' : 'unknown'
}

// Trust boundary for agent-chosen URLs: every A/AAAA record is checked; DNS rebinding remains
import { lookup } from 'node:dns/promises'
import { z } from 'zod'

export const USER_AGENT = 'orc-sim-web-mcp/0.0 (durable-workflow research simulation)'

const MAX_REDIRECTS = 5

const octet = z.number().int().min(0).max(255)
// exactly four in-range octets: the shape a dotted-quad IPv4 address must have
const Octets = z.tuple([octet, octet, octet, octet])

// WHATWG URL already canonicalized 0x7f.1 / 2130706433 into dotted quads. Unparseable = refuse.
export function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) {
    const v6 = ip.toLowerCase()
    if (v6 === '::' || v6 === '::1') return true
    if (/^fe[89ab]/.test(v6)) return true            // fe80::/10 link-local
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true // fc00::/7 ULA
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    const embedded = mapped?.[1]
    return embedded === undefined ? false : isPrivateIp(embedded)
  }
  const parsed = Octets.safeParse(ip.split('.').map(Number))
  if (!parsed.success) return true
  const [a, b] = parsed.data
  return a === 0 || a === 10 || a === 127 || a >= 224      // this-net, private, loopback, multicast+reserved
    || (a === 169 && b === 254)                            // link-local incl. 169.254.169.254 metadata
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)                  // CGNAT
    || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) // special-purpose, benchmarking
}

export async function assertPublicUrl(u: URL): Promise<void> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`refused non-http(s) url: ${u.href}`)
  if (u.username !== '' || u.password !== '') throw new Error('refused url with embedded credentials')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const literal = /^[\d.]+$/.test(host) || host.includes(':')
  const addrs = literal ? [host] : (await lookup(host, { all: true, verbatim: true })).map(r => r.address)
  for (const address of addrs)
    if (isPrivateIp(address)) throw new Error(`refused private/reserved address: ${u.hostname} → ${address}`)
}

// each hop re-guarded: a public URL must not be able to bounce into the intranet
export async function fetchPublic(url: string): Promise<Response> {
  let current = new URL(url)
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current)
    const r = await fetch(current, { headers: { 'User-Agent': USER_AGENT }, redirect: 'manual' })
    const location = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null
    if (!location) return r
    current = new URL(location, current) // relative redirects resolve against the current hop
  }
  throw new Error(`too many redirects (${MAX_REDIRECTS})`)
}

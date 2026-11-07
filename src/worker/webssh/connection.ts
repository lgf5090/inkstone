// Outbound SSH target resolution and the SSRF gate for the WebSSH session runtime.
//
// The worker never resolves a hostname at connect time: DNS answers are checked here, and the socket
// is opened against the address that passed the checks, so a second resolution (DNS rebinding) cannot
// swap in a private target between the check and the connection.

import { isBlockedTarget, isIpLiteralHost } from '@shared/ai-proxy-guard'
import { isValidHost } from './ssh/types'

const DOH_URL_DEFAULT = 'https://cloudflare-dns.com/dns-query'
/** Snapshot of Cloudflare's published edge ranges; a deployment cannot open TCP to its own edge. */
const CLOUDFLARE_IPV4_RANGES: ReadonlyArray<[string, number]> = [
  ['173.245.48.0', 20],
  ['103.21.244.0', 22],
  ['103.22.200.0', 22],
  ['103.31.4.0', 22],
  ['141.101.64.0', 18],
  ['108.162.192.0', 18],
  ['190.93.240.0', 20],
  ['188.114.96.0', 20],
  ['197.234.240.0', 22],
  ['198.41.128.0', 17],
  ['162.158.0.0', 15],
  ['104.16.0.0', 13],
  ['104.24.0.0', 14],
  ['172.64.0.0', 13],
  ['131.0.72.0', 22],
]
const CLOUDFLARE_IPV6_RANGES: ReadonlyArray<[string, number]> = [
  ['2400:cb00::', 32],
  ['2606:4700::', 32],
  ['2803:f800::', 32],
  ['2405:b500::', 32],
  ['2405:8100::', 32],
  ['2a06:98c0::', 29],
  ['2c0f:f248::', 32],
]

/** Codes a session row records when the target never reaches SSH. */
export type WebsshConnectionFailureCode =
  | 'host_invalid'
  | 'port_blocked'
  | 'host_blocked'
  | 'dns_failed'
  | 'no_public_address'
  | 'connect_failed'

export class WebsshConnectionError extends Error {
  readonly code: WebsshConnectionFailureCode
  /** A refusal is not worth retrying; a DNS or TCP failure on a new attempt may succeed. */
  readonly retryable: boolean

  constructor(code: WebsshConnectionFailureCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'WebsshConnectionError'
    this.code = code
    this.retryable = !(code === 'host_invalid' || code === 'port_blocked' || code === 'host_blocked' || code === 'no_public_address')
  }
}

export interface SshTarget {
  host: string
  port: number
  /** The literal address the socket must use; the hostname is never re-resolved. */
  address: string
  family: 4 | 6
  /** True only when the development-only switch allowed a non-public address. */
  devOverride: boolean
}

export type DohLookup = (name: string, type: 'A' | 'AAAA') => Promise<string[]>

export interface ResolveSshTargetOptions {
  lookup?: DohLookup
  /** Deployment-provided resolver endpoint; the default is Cloudflare's DoH service. */
  dohUrl?: string
  /** Development only; production must leave `WEBSSH_DEV_ALLOW_PRIVATE_HOSTS` unset. */
  allowPrivateHosts?: boolean
}

/** The switch is a plain environment value and only the exact words `1`/`true` arm it. */
export function readDevAllowPrivateHosts(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = (value << 8) | octet
  }
  return value >>> 0
}

function inIpv4Range(ip: string, base: string, bits: number): boolean {
  const value = ipv4ToInt(ip)
  const start = ipv4ToInt(base)
  if (value === null || start === null) return false
  const size = 2 ** (32 - bits)
  return value >= start && value < start + size
}

function ipv6ToBigInt(ip: string): bigint | null {
  const text = ip.split('%')[0]?.toLowerCase() ?? ''
  if (!text.includes(':')) return null
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parse = (part: string): number[] | null => {
    if (!part) return []
    const words = part.split(':')
    const out: number[] = []
    for (const [index, word] of words.entries()) {
      if (/^[0-9a-f]{1,4}$/.test(word)) {
        out.push(Number.parseInt(word, 16))
        continue
      }
      if (index === words.length - 1 && word.includes('.')) {
        const embedded = ipv4ToInt(word)
        if (embedded === null) return null
        out.push(embedded >>> 16, embedded & 0xffff)
        continue
      }
      return null
    }
    return out
  }
  const head = parse(halves[0] ?? '')
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : []
  if (!head || !tail) return null
  const missing = 8 - head.length - tail.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null
  const words = [...head, ...new Array(missing).fill(0), ...tail]
  let value = 0n
  for (const word of words) value = (value << 16n) | BigInt(word)
  return value
}

function inIpv6Range(ip: string, base: string, bits: number): boolean {
  const value = ipv6ToBigInt(ip)
  const start = ipv6ToBigInt(base)
  if (value === null || start === null) return false
  const shift = BigInt(128 - bits)
  return (value >> shift) === (start >> shift)
}

/** Whether an address belongs to Cloudflare's own edge; Workers may not open TCP to it. */
export function isCloudflareAddress(address: string): boolean {
  if (address.includes(':')) return CLOUDFLARE_IPV6_RANGES.some(([base, bits]) => inIpv6Range(address, base, bits))
  return CLOUDFLARE_IPV4_RANGES.some(([base, bits]) => inIpv4Range(address, base, bits))
}

function addressFamily(address: string): 4 | 6 | null {
  if (address.includes(':')) return ipv6ToBigInt(address) === null ? null : 6
  return ipv4ToInt(address) === null ? null : 4
}

/**
 * A literal address may be connected to when it is public, or when the development switch is on and
 * the only thing blocking it is the private/loopback/link-local rule. Cloudflare's own ranges stay
 * blocked in both cases: opening TCP to the edge is never part of a local test.
 */
function literalAddressAllowed(address: string, allowPrivateHosts: boolean): boolean {
  if (isCloudflareAddress(address)) return false
  if (!isBlockedTarget(address)) return true
  return allowPrivateHosts
}

/** RFC 8484 JSON queries over the configured resolver; the default is Cloudflare's DoH endpoint. */
export async function dohLookup(name: string, type: 'A' | 'AAAA', endpoint = DOH_URL_DEFAULT): Promise<string[]> {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new WebsshConnectionError('dns_failed', 'The DNS-over-HTTPS endpoint is invalid')
  }
  if (url.protocol !== 'https:') throw new WebsshConnectionError('dns_failed', 'The DNS-over-HTTPS endpoint must use https')
  url.searchParams.set('name', name)
  url.searchParams.set('type', type)

  let response: Response
  try {
    response = await fetch(url.toString(), { headers: { accept: 'application/dns-json' } })
  } catch (error) {
    throw new WebsshConnectionError('dns_failed', `DNS lookup for ${name} failed`, { cause: error })
  }
  if (!response.ok) {
    throw new WebsshConnectionError('dns_failed', `DNS lookup for ${name} answered HTTP ${response.status}`)
  }
  let body: { Answer?: Array<{ type?: unknown; data?: unknown }> }
  try {
    body = await response.json() as typeof body
  } catch (error) {
    throw new WebsshConnectionError('dns_failed', `DNS lookup for ${name} returned malformed JSON`, { cause: error })
  }
  const expectedType = type === 'A' ? 1 : 28
  return (body.Answer ?? [])
    .filter((answer) => answer.type === expectedType && typeof answer.data === 'string')
    .map((answer) => (answer.data as string).trim())
    .filter((answer) => addressFamily(answer) !== null)
}

/**
 * Resolve and validate the SSH target.
 *
 * Literal addresses skip DNS entirely. For hostnames both answer families are queried; blocked
 * answers are discarded, and the first acceptable A record (then AAAA) becomes the connection target.
 * When the development switch is on and no public answer exists, a private answer is accepted so a
 * local Docker sshd can be used, and the target is marked `devOverride` for the audit trail.
 */
export async function resolveSshTarget(
  host: string,
  port: number,
  options: ResolveSshTargetOptions = {},
): Promise<SshTarget> {
  const allowPrivateHosts = options.allowPrivateHosts === true
  if (typeof host !== 'string' || !isValidHost(host.trim())) {
    throw new WebsshConnectionError('host_invalid', 'The SSH host is not a valid hostname or address')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new WebsshConnectionError('host_invalid', 'The SSH port is out of range')
  }
  // SMTP is refused regardless of the development switch: it is the one port the platform bans outright.
  if (port === 25) throw new WebsshConnectionError('port_blocked', 'Port 25 is not allowed for outbound connections')

  const normalizedHost = host.trim().replace(/^\[|\]$/g, '').toLowerCase()
  if (isIpLiteralHost(normalizedHost)) {
    const family = addressFamily(normalizedHost)
    if (!family) throw new WebsshConnectionError('host_invalid', 'The SSH host is not a valid IP address')
    if (!literalAddressAllowed(normalizedHost, allowPrivateHosts)) {
      throw new WebsshConnectionError('host_blocked', 'The SSH host is a private, loopback or Cloudflare address')
    }
    return {
      host: normalizedHost,
      port,
      address: normalizedHost,
      family,
      devOverride: allowPrivateHosts && isBlockedTarget(normalizedHost),
    }
  }

  const lookup = options.lookup ?? ((name, type) => dohLookup(name, type, options.dohUrl))
  const [ipv4, ipv6] = await Promise.all([
    lookup(normalizedHost, 'A').catch(() => []),
    lookup(normalizedHost, 'AAAA').catch(() => []),
  ])
  const answers = [...ipv4, ...ipv6].filter((address) => addressFamily(address) !== null)
  if (!answers.length) throw new WebsshConnectionError('dns_failed', `No address record was found for ${normalizedHost}`)

  const publicAnswers = answers.filter((address) => literalAddressAllowed(address, false))
  const chosen = publicAnswers[0] ?? (allowPrivateHosts ? answers[0] : undefined)
  if (!chosen) {
    throw new WebsshConnectionError('no_public_address', 'The SSH host resolves only to blocked addresses')
  }
  return {
    host: normalizedHost,
    port,
    address: chosen,
    family: addressFamily(chosen) as 4 | 6,
    devOverride: allowPrivateHosts && !literalAddressAllowed(chosen, false),
  }
}

export interface ConnectSocketOptions {
  hostname: string
  port: number
}

export type ConnectImpl = (options: ConnectSocketOptions) => Socket

/**
 * Open the raw TCP socket against the validated address.
 *
 * `connect` is imported lazily so unit tests can inject their own transport without loading the
 * Workers-only module.
 */
export async function openSshSocket(target: SshTarget, connectImpl?: ConnectImpl): Promise<Socket> {
  const connect = connectImpl ?? (await import('cloudflare:sockets')).connect
  try {
    return connect({ hostname: target.address, port: target.port })
  } catch (error) {
    throw new WebsshConnectionError('connect_failed', `Could not open a TCP connection to ${target.address}:${target.port}`, { cause: error })
  }
}

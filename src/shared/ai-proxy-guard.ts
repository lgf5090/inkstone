/**
 * Both AI relays — the worker route and the dev-server middleware — take the provider URL from the request
 * body, because the caller chooses which provider it configured. That makes the target attacker-chosen, so
 * the guard has to live in one place: a relay that reaches a private address reads whatever the deployment
 * can, and does so with this origin's identity.
 */
export const BLOCKED_HOST_SUFFIXES = ['.localhost', '.internal', '.local', '.svc', '.cluster.local', '.home.arpa']
export const BLOCKED_HOSTNAMES = ['localhost', 'metadata', 'metadata.google.internal', 'instance-data']

export const ALLOWED_UPSTREAM_HEADERS = [
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'content-type',
  'accept',
  'anthropic-version',
  'anthropic-dangerous-direct-browser-access',
  'openai-organization',
  'openai-project',
]

/**
 * A label written as a number: decimal, `0x` hexadecimal, or decimal with leading zeros, which is octal.
 *
 * This shape test is deliberately looser than `ipv4Label`, the one that decides what a number means: a
 * label like `018` or `999` is still somebody writing an address, and a host whose every label is a number
 * cannot end in a zone name, so judging the whole thing as an address costs no real provider anything.
 */
const IPV4_LABEL = /^(?:0x[0-9a-f]+|[0-9]+)$/i

/** The separators a laxer host reader drops, which is why `127.0.0.1!` still has to be judged as 127.0.0.1. */
const HOST_TRAILER = /[!%*_,;:.\s]+$/g

/**
 * A label read in the base its prefix says, so `0x7f`, `0177` and `127` all mean 127.
 *
 * An octal that carries an 8 or a 9 fails the whole address rather than being re-read as decimal:
 * `018.1.1.1` is not 18.1.1.1, and a guard that quietly accepted the decimal reading would be a guard
 * that answered a different question than the one the host parser asked.
 */
function ipv4Label(label: string): number | null {
  const text = label.toLowerCase()
  if (/^0x[0-9a-f]+$/.test(text)) return Number.parseInt(text.slice(2), 16)
  if (text.length > 1 && text.startsWith('0')) return /^[0-7]+$/.test(text.slice(1)) ? Number.parseInt(text.slice(1), 8) : null
  return /^(?:0|[1-9][0-9]*)$/.test(text) ? Number(text) : null
}

/**
 * Every literal-IP spelling that names an address, read as the four octets it means: the dotted quad,
 * the shortened forms `127.1` and `127.0.1`, and the single-number forms `2130706433`, `0x7f000001` and
 * `017700000001`, with a base chosen per label so `0x7f.0.0.1` counts too.
 *
 * `new URL()` rewrites all of these into a dotted quad before a relay sees the host, so this follows the
 * same rules rather than inventing narrower ones: the last label absorbs the bytes below it, and a number
 * that will not fit in them is not an address at all.
 */
function parseIpv4(host: string): number[] | null {
  const labels = (host.endsWith('.') ? host.slice(0, -1) : host).split('.')
  if (labels.length > 4) return null
  const numbers: number[] = []
  for (const label of labels) {
    const value = ipv4Label(label)
    if (value === null) return null
    numbers.push(value)
  }
  const head = numbers.slice(0, -1)
  const last = numbers[numbers.length - 1]!
  if (head.some((value) => value > 255)) return null
  if (last >= 256 ** (5 - numbers.length)) return null
  let value = last
  for (const [index, part] of head.entries()) value += part * 256 ** (3 - index)
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]
}

/** Whether a host is written as a number at all, whether or not the number is a usable address. */
function looksLikeIpv4(host: string): boolean {
  return host.replace(HOST_TRAILER, '').split('.').every((label) => IPV4_LABEL.test(label))
}

/** The reserved and internal ranges a relay must never be pointed at, once the address is four octets. */
function isBlockedIpv4(parts: number[]): boolean {
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

/** The words one section of an IPv6 literal names, expanding a trailing IPv4 into the two it occupies. */
function ipv6Section(section: string, isLast: boolean): number[] | null {
  if (!section) return []
  const words = section.split(':')
  const out: number[] = []
  for (const [index, word] of words.entries()) {
    if (/^[0-9a-f]{1,4}$/.test(word)) {
      out.push(Number.parseInt(word, 16))
      continue
    }
    const embedded = isLast && index === words.length - 1 && word.includes('.') ? parseIpv4(word) : null
    if (!embedded) return null
    out.push(embedded[0]! * 256 + embedded[1]!, embedded[2]! * 256 + embedded[3]!)
  }
  return out
}

/**
 * The eight 16-bit words an IPv6 literal names, with `::` expanded and any zone id dropped.
 *
 * Text is not enough to judge an address: `0:0:0:0:0:0:0:1` is `::1`, and the deprecated
 * `::7f00:1` carries `127.0.0.1` the same `::ffff:7f00:1` does, so the words are what gets compared.
 */
function ipv6Words(host: string): number[] | null {
  const halves = (host.split('%')[0] ?? '').toLowerCase().split('::')
  if (halves.length > 2) return null
  const compressed = halves.length === 2
  const head = ipv6Section(halves[0] ?? '', !compressed)
  const tail = compressed ? ipv6Section(halves[1] ?? '', true) : []
  if (!head || !tail) return null
  if (compressed ? head.length + tail.length > 7 : head.length + tail.length !== 8) return null
  return [...head, ...new Array(Math.max(0, 8 - head.length - tail.length)).fill(0), ...tail]
}

/**
 * The IPv4 an IPv6 literal carries: the mapped `::ffff:a.b.c.d` and the deprecated `::a.b.c.d`, either of
 * which a stack may still route to the address it names.
 */
function embeddedIpv4(words: number[]): number[] | null {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = words
  if (g0 || g1 || g2 || g3 || g4) return null
  if (g5 !== 0 && g5 !== 0xffff) return null
  return [(g6! >> 8) & 255, g6! & 255, (g7! >> 8) & 255, g7! & 255]
}

/**
 * The address a relay must not be aimed at.
 *
 * A literal IP is judged in every spelling that names one, because that part is decidable from the text
 * alone. A *hostname* is not: this runtime cannot resolve a name and then refuse the address it answered,
 * so a domain the account configured is trusted as configured, and a name that points at the network
 * inside it (`127.0.0.1.sslip.io`, or any zone whose operator later repoints A) is a boundary the platform
 * draws, not this function. The redirects are refused at the fetch for the same reason.
 */
export function isBlockedTarget(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true
  if (BLOCKED_HOSTNAMES.includes(host)) return true
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
  if (host.includes(':')) {
    const words = ipv6Words(host)
    // Text with a colon is written as an address, so a reading that fails is not a name anyone owns.
    if (!words) return true
    if (words.every((word) => word === 0)) return true
    if ((words[0]! & 0xfe00) === 0xfc00) return true
    if ((words[0]! & 0xffc0) === 0xfe80) return true
    const embedded = embeddedIpv4(words)
    return embedded ? isBlockedIpv4(embedded) : false
  }
  if (!looksLikeIpv4(host)) return false
  const parts = parseIpv4(host.replace(HOST_TRAILER, ''))
  if (!parts) return true
  return isBlockedIpv4(parts)
}

export function isIpLiteralHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host.includes(':') || looksLikeIpv4(host)
}

export function assertRelayableEndpoint(endpoint: string): URL {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new Error('Invalid endpoint URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Endpoint must use http or https')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Endpoint must not carry credentials')
  }
  if (isBlockedTarget(parsed.hostname)) {
    throw new Error('Endpoint must be a publicly reachable AI provider')
  }
  return parsed
}

export function pickRelayHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers || typeof headers !== 'object') return out
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (!ALLOWED_UPSTREAM_HEADERS.includes(key.toLowerCase())) continue
    if (typeof value === 'string') out[key] = value
  }
  return out
}

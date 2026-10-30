const MAX_URL_LENGTH = 2048

export class UrlGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UrlGuardError'
  }
}

function stripBrackets(hostname: string): string {
  const lower = hostname.toLowerCase()
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower
}

function ipv4Parts(host: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null
  const parts = host.split('.').map(Number)
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null
}

function ipv4Private(parts: readonly number[]): boolean {
  const [a, b, c] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b! >= 64 && b! <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b! >= 16 && b! <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51 && c === 100) return true
  if (a === 203 && b === 0 && c === 113) return true
  if (a! >= 224) return true
  return false
}

function ipv6Groups(host: string): number[] | null {
  let value = host.split('%', 1)[0]!
  if (!value.includes(':')) return null
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':')
    const ipv4 = ipv4Parts(value.slice(lastColon + 1))
    if (!ipv4) return null
    value = `${value.slice(0, lastColon + 1)}${((ipv4[0]! << 8) | ipv4[1]!).toString(16)}:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`
  }
  const halves = value.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves[1] ? halves[1].split(':') : []
  if (halves.length === 2 && head.length + tail.length > 7) return null
  if (halves.length === 1 && head.length !== 8) return null
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  const groups = [...head, ...Array.from({ length: fill }, () => '0'), ...tail]
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null
  return groups.map((group) => parseInt(group, 16))
}

function ipv6Private(groups: readonly number[]): boolean {
  const first = groups[0]!
  if (groups.every((group) => group === 0)) return true
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true
  if ((first & 0xfe00) === 0xfc00) return true
  if ((first & 0xffc0) === 0xfe80) return true
  if ((first & 0xff00) === 0xff00) return true
  if (first === 0x2001 && groups[1] === 0x0db8) return true
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return ipv4Private([groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff])
  }
  if (groups[0] === 0x0064 && groups[1] === 0xff9b) {
    return ipv4Private([groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff])
  }
  return false
}

const PRIVATE_HOSTNAMES = new Set(['localhost', 'metadata', 'metadata.google.internal'])

export function isPrivateHostname(hostname: string): boolean {
  const host = stripBrackets(hostname)
  if (!host) return true
  if (PRIVATE_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true
  const v4 = ipv4Parts(host)
  if (v4) return ipv4Private(v4)
  const v6 = ipv6Groups(host)
  if (v6) return ipv6Private(v6)
  return false
}

export function isIpLiteral(hostname: string): boolean {
  const host = stripBrackets(hostname)
  return ipv4Parts(host) !== null || ipv6Groups(host) !== null
}

async function resolveWithDoh(hostname: string): Promise<string[]> {
  const answers: string[] = []
  for (const type of ['A', 'AAAA']) {
    try {
      const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.timeout(2500),
      })
      if (!response.ok) throw new Error(`DoH HTTP ${response.status}`)
      const body = await response.json() as { Answer?: { type?: number; data?: string }[] }
      for (const answer of body.Answer ?? []) {
        if (answer.data) answers.push(stripBrackets(answer.data))
      }
    } catch (error) {
      if (type === 'AAAA') break
      throw new UrlGuardError('The host name could not be resolved safely')
    }
  }
  return [...new Set(answers)]
}

export async function assertPublicHttpUrl(input: string | URL, resolveHost: (hostname: string) => Promise<string[]> = resolveWithDoh): Promise<URL> {
  let url: URL
  try { url = input instanceof URL ? new URL(input.href) : new URL(input) } catch { throw new UrlGuardError('Only public http(s) URLs are allowed') }
  if (url.href.length > MAX_URL_LENGTH) throw new UrlGuardError('The URL is too long')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new UrlGuardError('Only public http(s) URLs are allowed')
  if (/[\u0000-\u001f\u007f]/.test(url.href)) throw new UrlGuardError('The URL contains control characters')
  if (isPrivateHostname(url.hostname)) throw new UrlGuardError('Only public http(s) URLs are allowed')
  if (!isIpLiteral(url.hostname)) {
    const addresses = await resolveHost(stripBrackets(url.hostname))
    if (!addresses.length) throw new UrlGuardError('The host name could not be resolved safely')
    if (addresses.some((address) => isPrivateHostname(address))) throw new UrlGuardError('The host name resolves to a private address')
  }
  return url
}

export async function assertExternalHttpUrl(input: string): Promise<URL> {
  const url = await assertPublicHttpUrl(input, async (hostname) => [hostname])
  return url
}

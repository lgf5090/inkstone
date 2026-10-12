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

function ipv4(hostname: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null
}

export function isBlockedTarget(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true
  if (BLOCKED_HOSTNAMES.includes(host)) return true
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
  if (host.includes(':')) {
    const v6 = host.replace(/%/g, '')
    if (v6 === '::' || v6 === '::1') return true
    if (/^f[cd]/i.test(v6)) return true
    if (/^fe[89ab]/i.test(v6)) return true
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(v6)?.[1]
    if (dotted) return isBlockedTarget(dotted)
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(v6)
    if (hex) {
      const hi = Number.parseInt(hex[1], 16)
      const lo = Number.parseInt(hex[2], 16)
      return isBlockedTarget(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`)
    }
    return false
  }
  const parts = ipv4(host)
  if (!parts) return false
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

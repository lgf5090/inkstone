/**
 * The toolbox's server-side probes.
 *
 * Everything here is a read: DNS over HTTPS, RDAP, an HTTP probe and Cloudflare's own trace endpoint.
 * Inputs are validated before a request is built, and the probe refuses literal addresses so a reader
 * cannot aim the deployment at a private service.
 */
import { ApiError } from '../lib/errors'

const TIMEOUT_MS = 15_000
const DNS_TYPES = new Set(['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'SRV', 'CAA'])

export interface DnsAnswer {
  name: string
  type: number
  ttl: number
  data: string
}

export interface DnsLookupResult {
  status: number
  answers: DnsAnswer[]
}

function assertDomain(value: string, label: string): string {
  const domain = value.trim().toLowerCase()
  if (!domain || domain.length > 253) throw ApiError.badRequest(`${label} is required`)
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    throw ApiError.badRequest(`${label} is not a valid domain name`)
  }
  return domain
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'User-Agent': 'inkstone-toolbox/1', ...(init.headers ?? {}) },
    })
  } catch (error) {
    throw new ApiError(502, 'cloudflare_upstream', `The request did not complete: ${(error as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
}

export async function lookupDns(name: string, type: string): Promise<DnsLookupResult> {
  const domain = assertDomain(name, 'Name')
  const recordType = type.trim().toUpperCase()
  if (!DNS_TYPES.has(recordType)) throw ApiError.badRequest('Unsupported DNS record type')
  const query = `name=${encodeURIComponent(domain)}&type=${recordType}`
  // Different networks block different DoH hosts; trying the two standard JSON endpoints in order
  // keeps the tool useful without pretending a failed lookup is an empty answer.
  const endpoints = [
    `https://cloudflare-dns.com/dns-query?${query}`,
    `https://dns.google/resolve?${query}`,
  ]
  const failures: string[] = []
  for (const url of endpoints) {
    try {
      const response = await fetchWithTimeout(url, { headers: { Accept: 'application/dns-json' } })
      if (!response.ok) {
        failures.push(`${new URL(url).hostname} HTTP ${response.status}`)
        continue
      }
      const body = await response.json() as { Status?: number; Answer?: Array<Record<string, unknown>> }
      const answers = (body.Answer ?? []).map((row) => ({
        name: typeof row.name === 'string' ? row.name : '',
        type: typeof row.type === 'number' ? row.type : 0,
        ttl: typeof row.TTL === 'number' ? row.TTL : 0,
        data: typeof row.data === 'string' ? row.data : '',
      }))
      return { status: typeof body.Status === 'number' ? body.Status : 0, answers }
    } catch (error) {
      failures.push((error as Error).message)
    }
  }
  throw new ApiError(502, 'cloudflare_upstream', `DNS lookup failed on every endpoint: ${failures.join('; ')}`)
}

export interface RdapSummary {
  handle: string
  domain: string
  status: string[]
  nameservers: string[]
  registrar: string
  events: Array<{ action: string; date: string }>
}

let rdapBootstrap: { at: number; services: Array<{ tlds: string[]; base: string }> } | null = null

/** IANA's bootstrap file maps a TLD to the registry's RDAP base URL; rdap.org itself rejects this deployment. */
async function rdapBaseFor(tld: string): Promise<string> {
  const now = Date.now()
  if (!rdapBootstrap || now - rdapBootstrap.at > 3_600_000) {
    const response = await fetchWithTimeout('https://data.iana.org/rdap/dns.json')
    if (!response.ok) throw new ApiError(502, 'cloudflare_upstream', `RDAP bootstrap answered HTTP ${response.status}`)
    const body = await response.json() as { services?: unknown[] }
    const services: Array<{ tlds: string[]; base: string }> = []
    for (const entry of body.services ?? []) {
      if (!Array.isArray(entry) || entry.length < 2) continue
      const tlds = Array.isArray(entry[0]) ? entry[0].filter((item): item is string => typeof item === 'string') : []
      const urls = Array.isArray(entry[1]) ? entry[1].filter((item): item is string => typeof item === 'string') : []
      const base = urls.find((url) => url.startsWith('http'))
      if (tlds.length && base) services.push({ tlds: tlds.map((value) => value.toLowerCase()), base })
    }
    rdapBootstrap = { at: now, services }
  }
  const service = rdapBootstrap.services.find((row) => row.tlds.includes(tld))
  if (!service) throw new ApiError(404, 'not_found', `No RDAP service is published for .${tld}`)
  return service.base.replace(/\/$/, '')
}

export async function lookupRdap(value: string): Promise<RdapSummary> {
  const domain = assertDomain(value, 'Domain')
  const tld = domain.split('.').pop() ?? ''
  const base = await rdapBaseFor(tld)
  const response = await fetchWithTimeout(`${base}/domain/${encodeURIComponent(domain)}`, {
    headers: { Accept: 'application/rdap+json' },
  })
  if (response.status === 404) throw new ApiError(404, 'not_found', 'RDAP has no record for that domain')
  if (!response.ok) throw new ApiError(502, 'cloudflare_upstream', `RDAP answered HTTP ${response.status}`)
  const body = await response.json() as Record<string, unknown>
  const entities = Array.isArray(body.entities) ? body.entities as Array<Record<string, unknown>> : []
  const registrar = entities
    .filter((entity) => {
      const roles = Array.isArray(entity.roles) ? entity.roles as unknown[] : []
      return roles.includes('registrar')
    })
    .map((entity) => {
      const vcard = Array.isArray(entity.vcardArray) ? entity.vcardArray as unknown[] : []
      const rows = Array.isArray(vcard[1]) ? vcard[1] as unknown[] : []
      const fn = rows.find((row) => Array.isArray(row) && row[0] === 'fn')
      return Array.isArray(fn) && typeof fn[3] === 'string' ? fn[3] : ''
    })
    .find((name) => name.length > 0) ?? ''
  const events = Array.isArray(body.events) ? body.events as Array<Record<string, unknown>> : []
  const nameservers = Array.isArray(body.nameservers) ? body.nameservers as Array<Record<string, unknown>> : []
  return {
    handle: typeof body.handle === 'string' ? body.handle : '',
    domain: typeof body.ldhName === 'string' ? body.ldhName : domain,
    status: Array.isArray(body.status) ? (body.status as unknown[]).filter((item): item is string => typeof item === 'string') : [],
    nameservers: nameservers.map((row) => typeof row.ldhName === 'string' ? row.ldhName.toLowerCase() : '').filter(Boolean),
    registrar,
    events: events.map((row) => ({
      action: typeof row.eventAction === 'string' ? row.eventAction : '',
      date: typeof row.eventDate === 'string' ? row.eventDate : '',
    })),
  }
}

export interface ProbeResult {
  url: string
  finalUrl: string
  status: number
  statusText: string
  elapsedMs: number
  contentType: string
  contentLength: string
  headers: Record<string, string>
  body: string
  truncated: boolean
}

function assertProbeUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw ApiError.badRequest('URL is not valid')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw ApiError.badRequest('Only http and https URLs are allowed')
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.local') || /^[0-9.]+$/.test(host) || host.includes(':')) {
    throw ApiError.badRequest('Literal or local addresses are not allowed')
  }
  return url
}

export async function probeHttp(value: string, method: 'GET' | 'HEAD'): Promise<ProbeResult> {
  const url = assertProbeUrl(value)
  const started = Date.now()
  const response = await fetchWithTimeout(url.toString(), { method, redirect: 'follow', headers: { 'User-Agent': 'inkstone-toolbox/1' } })
  const elapsedMs = Date.now() - started
  const headers: Record<string, string> = {}
  for (const key of ['content-type', 'content-length', 'server', 'cache-control', 'cf-cache-status', 'cf-ray', 'location']) {
    const header = response.headers.get(key)
    if (header) headers[key] = header
  }
  let body = ''
  let truncated = false
  const contentType = response.headers.get('content-type') ?? ''
  if (method === 'GET' && /text|json|xml|javascript/.test(contentType)) {
    const text = await response.text()
    truncated = text.length > 4096
    body = text.slice(0, 4096)
  }
  return {
    url: url.toString(),
    finalUrl: response.url,
    status: response.status,
    statusText: response.statusText,
    elapsedMs,
    contentType,
    contentLength: response.headers.get('content-length') ?? '',
    headers,
    body,
    truncated,
  }
}

export async function readCloudflareTrace(): Promise<Record<string, string>> {
  const response = await fetchWithTimeout('https://www.cloudflare.com/cdn-cgi/trace')
  if (!response.ok) throw new ApiError(502, 'cloudflare_upstream', `Trace answered HTTP ${response.status}`)
  const text = await response.text()
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    out[line.slice(0, index)] = line.slice(index + 1)
  }
  return out
}

/**
 * The toolbox screen's door to `/api/cloudflare/toolbox`.
 */
import { cfRequest } from './client'

export interface DnsAnswer {
  name: string
  type: number
  ttl: number
  data: string
}

export interface RdapSummary {
  handle: string
  domain: string
  status: string[]
  nameservers: string[]
  registrar: string
  events: Array<{ action: string; date: string }>
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

const BASE = '/toolbox'

export const toolboxApi = {
  dns: (name: string, type: string) =>
    cfRequest<{ status: number; answers: DnsAnswer[] }>(`${BASE}/dns?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`),

  rdap: (domain: string) =>
    cfRequest<RdapSummary>(`${BASE}/rdap?domain=${encodeURIComponent(domain)}`),

  probe: (url: string, method: 'GET' | 'HEAD') =>
    cfRequest<ProbeResult>(`${BASE}/probe`, { method: 'POST', body: { url, method }, timeoutMs: 30_000 }),

  trace: () =>
    cfRequest<{ trace: Record<string, string> }>(`${BASE}/trace`),
}

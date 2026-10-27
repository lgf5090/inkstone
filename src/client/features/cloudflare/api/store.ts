/**
 * The template store: catalogue sources, the aggregated catalogue, and two-phase deployment.
 *
 * A template is a catalog entry, not a row this app owns: the catalogue lives on someone else's static
 * host, and the source row only remembers where to fetch it and how the last fetch went. Deployment is
 * two-phase because the second phase writes to Cloudflare — the first one checks the account, the
 * template and the reachable source, so a typo does not become a half-deployed worker.
 */
import { cfRequest } from './client'

export type CatalogTemplateType = 'worker' | 'pages' | 'hybrid'
export type CatalogBindingType = 'kv' | 'd1' | 'r2' | 'ai' | 'var'

export interface CatalogBinding {
  type: CatalogBindingType
  name: string
  title?: string
  [key: string]: unknown
}

export interface CatalogTemplate {
  id: string
  name: string
  description?: string
  author?: { name: string; url?: string }
  version: string
  tags?: string[]
  icon?: string
  homepage?: string
  readmeUrl?: string
  type: CatalogTemplateType
  source?: { kind: string; url: string; [key: string]: unknown }
  sources?: { worker?: unknown; pages?: unknown }
  bindings?: CatalogBinding[]
  env?: Record<string, string>
  routes?: string[]
  [key: string]: unknown
}

export interface TemplateItem {
  template: CatalogTemplate
  sourceId: string
  sourceName: string
  sourceCount: number
}

export interface CatalogSource {
  id: string
  url: string
  name: string
  is_default: number
  enabled: number
  last_synced: number | null
  last_status: string
  last_error: string | null
  etag: string | null
  created_at: number
  template_count?: number
}

export interface StoreDeployment {
  accountId: string
  templateId: string
  name: string
  bindingSelections?: Record<string, string>
  secretValues?: Record<string, string>
  deployType?: CatalogTemplateType
}

export interface PreflightResult {
  ok: boolean
  templateId: string
  templateName: string
  accountId: string
  accountName: string
  deployType: CatalogTemplateType
  sourceOk: boolean
  sourceError?: string
  warning?: string
}

export interface DeploymentResult {
  accountId: string
  name: string
  success: boolean
  error?: string
  url?: string
}

export interface BatchDeploymentResult {
  total: number
  succeeded: number
  failed: number
  results: DeploymentResult[]
}

export const storeApi = {
  sources: () => cfRequest<{ sources: CatalogSource[] }>('/store/sources'),
  testSource: (url: string) =>
    cfRequest<{ ok: true; count: number; name?: string }>('/store/sources/test', { method: 'POST', body: { url }, timeoutMs: 60_000 }),
  addSource: (url: string, name: string) =>
    cfRequest<{ source: CatalogSource }>('/store/sources', { method: 'POST', body: { url, name } }),
  updateSource: (id: string, patch: { name?: string; enabled?: boolean }) =>
    cfRequest<{ source: CatalogSource }>(`/store/sources/${encodeURIComponent(id)}`, { method: 'PUT', body: patch }),
  deleteSource: (id: string) =>
    cfRequest<{ ok: true }>(`/store/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  readme: (url: string) => cfRequest<string>(`/store/readme?url=${encodeURIComponent(url)}`, { timeoutMs: 30_000 }),
  templates: () => cfRequest<{ templates: TemplateItem[]; sources: CatalogSource[] }>('/store/templates', { timeoutMs: 60_000 }),
  refresh: () => cfRequest<{ templates: TemplateItem[]; sources: CatalogSource[] }>('/store/refresh', { method: 'POST', timeoutMs: 60_000 }),
  init: () => cfRequest<{ ok: true }>('/store/init', { method: 'POST' }),
  preflight: (input: StoreDeployment) =>
    cfRequest<PreflightResult>('/store/preflight', { method: 'POST', body: input, timeoutMs: 60_000 }),
  deploy: (input: StoreDeployment) =>
    cfRequest<DeploymentResult>('/store/deploy', { method: 'POST', body: input, timeoutMs: 300_000 }),
  deployBatch: (deployments: StoreDeployment[]) =>
    cfRequest<BatchDeploymentResult>('/store/deploy-batch', { method: 'POST', body: { deployments }, timeoutMs: 300_000 }),
}

/**
 * The vocabulary the Cloudflare app shares between the worker and the browser.
 *
 * Field names keep the spelling Cloudflare's API uses (`auth_type`, `account_id`, `is_active`), which
 * is also the reference module's spelling. Translating every one of these at the API boundary would
 * add a mapping layer with no reader to serve: the values come from Cloudflare, are stored as they
 * arrive, and the screen that shows them is the only consumer.
 */

export type CloudflareAuthType = 'token' | 'global_key'
export type CloudflareFeature = 'ai' | 'workers' | 'browser_render' | 'dns' | 'storage'

export interface CloudflareAccount {
  id: string
  user_id: string
  name: string
  auth_type: CloudflareAuthType
  email: string | null
  cf_account_id: string | null
  is_active: number
  enabled_features: string
  available_features: string
  has_credentials: number
  is_demo: boolean
  created_at: number
  updated_at: number
}

export interface CloudflareAccountPage {
  accounts: CloudflareAccount[]
  total: number
  counts: { all: number; active: number; unverified: number }
}

export interface CloudflareAccountCredentials {
  id: string
  name: string
  auth_type: CloudflareAuthType
  email: string | null
  cf_account_id: string | null
  api_token: string | null
  api_key: string | null
  password: string | null
}

export type QuotaResource = 'workers_requests' | 'ai_neurons' | 'browser_render_seconds'

export interface QuotaResourceView {
  resource: QuotaResource
  count: number
  limit: number
  remaining: number
  exhausted: boolean
}

export interface AccountQuotaView {
  account_id: string
  account_name: string
  resources: QuotaResourceView[]
}

export interface CloudflareQuotaResponse {
  accounts: AccountQuotaView[]
}

export type AuditStatus = 'success' | 'error'

export interface CloudflareAuditLog {
  id: string
  account_id: string | null
  account_name: string | null
  action: string
  target: string | null
  detail: string | null
  status: AuditStatus
  created_at: number
}

export interface CloudflareHealth {
  ok: true
  r2: boolean
  vault: boolean
}

export const CLOUDFLARE_FEATURES: readonly CloudflareFeature[] = ['ai', 'workers', 'browser_render', 'dns', 'storage']
export const CLOUDFLARE_DEFAULT_FEATURES = 'ai,workers,browser_render,dns,storage'

export function parseFeatures(raw: string): CloudflareFeature[] {
  return raw.split(',').map((item) => item.trim()).filter(Boolean) as CloudflareFeature[]
}

export function hasFeature(raw: string, feature: CloudflareFeature): boolean {
  const list = parseFeatures(raw || CLOUDFLARE_DEFAULT_FEATURES)
  if (list.length === 0) return CLOUDFLARE_FEATURES.includes(feature)
  return list.includes(feature)
}

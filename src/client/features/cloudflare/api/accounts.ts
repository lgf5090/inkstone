/**
 * The accounts slice's calls.
 *
 * Every request goes through `cfRequest`, which carries the notebook's client header and turns the
 * route's error envelope into the sentence the screen shows. The CSV import is a multipart form, so
 * it hands `request()` a `FormData` instead of a JSON body.
 */
import type {
  AccountQuotaView,
  CloudflareAccount,
  CloudflareAccountCredentials,
  CloudflareAuthType,
} from '@shared/cloudflare/model'
import { cfRequest } from './client'

export type AccountFilter = 'all' | 'active' | 'unverified'

export interface AccountListParams {
  page?: number
  pageSize?: number
  filter?: AccountFilter
  search?: string
}

export interface AccountsResponse {
  accounts: CloudflareAccount[]
  total: number
  counts: { all: number; active: number; unverified: number }
  quota: AccountQuotaView[]
}

export interface AccountInput {
  name: string
  auth_type: CloudflareAuthType
  email?: string | null
  cf_account_id?: string | null
  enabled_features?: string
  is_active?: boolean
  api_token?: string
  api_key?: string
  password?: string
}

export type AccountUpdateInput = Partial<AccountInput>

export type BatchStatus = 'success' | 'skipped' | 'error'

export interface BatchSummary {
  total: number
  success: number
  skipped: number
  error: number
}

export interface BatchItemResult {
  id: string
  name: string
  status: BatchStatus
  message?: string
}

export interface BatchResponse {
  summary: BatchSummary
  results: BatchItemResult[]
}

export type BatchTestResponse = BatchResponse

export interface ImportItemResult {
  email: string
  name: string
  status: BatchStatus
  message?: string
}

export interface ImportResponse {
  summary: BatchSummary
  results: ImportItemResult[]
}

export interface AccountTestResult {
  ok: true
  cf_account_id: string | null
  available_features: string
}

function listQuery(params: AccountListParams): string {
  const query = new URLSearchParams()
  if (params.page !== undefined) query.set('page', String(params.page))
  if (params.pageSize !== undefined) query.set('pageSize', String(params.pageSize))
  if (params.filter) query.set('filter', params.filter)
  if (params.search) query.set('search', params.search)
  const text = query.toString()
  return text ? `?${text}` : ''
}

function accountPath(id: string, suffix = ''): string {
  return `/accounts/${encodeURIComponent(id)}${suffix}`
}

export const accountsApi = {
  list: (params: AccountListParams = {}) =>
    cfRequest<AccountsResponse>(`/accounts${listQuery(params)}`),

  create: (input: AccountInput) =>
    cfRequest<CloudflareAccount>('/accounts', { method: 'POST', body: input }),

  update: (id: string, input: AccountUpdateInput) =>
    cfRequest<CloudflareAccount>(accountPath(id), { method: 'PUT', body: input }),

  remove: (id: string) =>
    cfRequest<{ id: string }>(accountPath(id), { method: 'DELETE' }),

  restore: (id: string) =>
    cfRequest<CloudflareAccount>(`${accountPath(id)}/restore`, { method: 'POST' }),

  test: (id: string) =>
    cfRequest<AccountTestResult>(accountPath(id, '/test'), { method: 'POST' }),

  testBatch: (input: { ids?: string[]; onlyUnverified?: boolean }) =>
    cfRequest<BatchTestResponse>('/accounts/test-batch', {
      method: 'POST',
      body: input,
      timeoutMs: 600_000,
    }),

  updateFeatures: (id: string, enabledFeatures: string) =>
    cfRequest<{ id: string; enabled_features: string }>(accountPath(id, '/features'), {
      method: 'PATCH',
      body: { enabled_features: enabledFeatures },
    }),

  clearExhausted: (id: string) =>
    cfRequest<{ id: string }>(accountPath(id, '/clear-exhausted'), { method: 'POST' }),

  credentials: (id: string) =>
    cfRequest<CloudflareAccountCredentials>(accountPath(id, '/credentials')),

  importCsv: (file: File, skipVerify: boolean) => {
    const formData = new FormData()
    formData.append('file', file)
    if (skipVerify) formData.append('skipVerify', '1')
    return cfRequest<ImportResponse>('/accounts/import-csv', {
      method: 'POST',
      formData,
      timeoutMs: 600_000,
    })
  },

  batchFeatures: (ids: string[], enabledFeatures: string) =>
    cfRequest<BatchResponse>('/accounts/batch/features', {
      method: 'POST',
      body: { ids, enabled_features: enabledFeatures },
    }),

  batchDelete: (ids: string[]) =>
    cfRequest<BatchResponse>('/accounts/batch/delete', {
      method: 'POST',
      body: { ids },
    }),

  /** Present for completeness; the screen does not offer it because Workers cannot proxy outbound. */
  batchProxy: (ids: string[]) =>
    cfRequest<BatchResponse>('/accounts/batch/proxy', {
      method: 'POST',
      body: { ids },
    }),
}

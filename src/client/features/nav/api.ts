import { CLIENT_HEADER } from '@shared/constants'
import { ApiError } from '../../lib/api'
import { getLocale, t } from '../../lib/i18n'
import type {
  NavAiModelsResponse,
  NavAiSuggestResponse,
  NavBackupConfigResponse,
  NavBootstrapResponse,
  NavCategoryResponse,
  NavCheckResponse,
  NavFaviconResponse,
  NavIconsResponse,
  NavImportResponse,
  NavLinkResponse,
  NavRestoreResponse,
  NavSettingsResponse,
  NavWebdavBackupResponse,
  NavWebdavTestResponse,
} from '@shared/nav/api'
import type {
  NavBackup,
  NavCategory,
  NavCheckResult,
  NavImportCategory,
  NavImportLink,
  NavSettings,
} from '@shared/nav/model'

const ERROR_KEYS: Record<string, string> = {
  unauthenticated: 'nav.error.unauthenticated',
  forbidden: 'nav.error.forbidden',
  not_found: 'nav.error.not_found',
  conflict: 'nav.error.conflict',
  bad_request: 'nav.error.bad_request',
  payload_too_large: 'nav.error.too_large',
  storage_unavailable: 'nav.error.storage',
  wrong_password: 'nav.error.wrong_password',
  too_many_attempts: 'nav.error.too_many',
  nav_default_password_not_configured: 'nav.error.default_password',
  nav_ai_unavailable: 'nav.error.ai_unavailable',
  nav_ai_invalid_response: 'nav.error.ai_invalid',
  nav_blocked_target: 'nav.error.blocked_target',
  nav_icon_invalid: 'nav.error.icon_invalid',
  nav_webdav_failed: 'nav.error.webdav',
  nav_order_mismatch: 'nav.error.order_mismatch',
}

function localizedError(code: string, fallback: string): string {
  const key = ERROR_KEYS[code]
  return key ? t(key as never) : fallback || t('nav.error.generic' as never)
}

export interface NavRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  formData?: FormData
  signal?: AbortSignal
  unlocks?: readonly string[]
  keepalive?: boolean
}

export async function navFetch<T>(path: string, options: NavRequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    [CLIENT_HEADER]: '1',
    'Accept-Language': getLocale(),
  }
  if (options.unlocks?.length) headers['X-Nav-Unlocks'] = options.unlocks.join(',')
  let payload: BodyInit | undefined
  if (options.formData) payload = options.formData
  else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(options.body)
  }
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    body: payload,
    signal: options.signal,
    keepalive: options.keepalive,
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
    const code = body?.error?.code ?? 'internal'
    throw new ApiError(response.status, code, localizedError(code, body?.error?.message ?? ''), undefined, body?.error?.message)
  }
  if (response.status === 204) return undefined as T
  return await response.json() as T
}

export const navApi = {
  bootstrap: (unlocks: readonly string[]) => navFetch<NavBootstrapResponse>('/api/nav', { unlocks }),
  createCategory: (body: unknown) => navFetch<NavCategoryResponse>('/api/nav/categories', { method: 'POST', body }),
  updateCategory: (id: string, body: unknown) => navFetch<NavCategoryResponse>(`/api/nav/categories/${id}`, { method: 'PATCH', body }),
  deleteCategory: (id: string, fallbackCategoryId: string) => navFetch<{ ok: true }>(`/api/nav/categories/${id}`, { method: 'DELETE', body: { fallbackCategoryId } }),
  orderCategories: (parentId: string | null, orderedIds: string[]) => navFetch<{ ok: true }>('/api/nav/categories/order', { method: 'POST', body: { parentId, orderedIds } }),
  unlockCategory: (id: string, password: string) => navFetch<{ token: string; expiresAt: number }>(`/api/nav/categories/${id}/unlock`, { method: 'POST', body: { password } }),
  createLink: (body: unknown) => navFetch<NavLinkResponse>('/api/nav/links', { method: 'POST', body }),
  updateLink: (id: string, body: unknown) => navFetch<NavLinkResponse>(`/api/nav/links/${id}`, { method: 'PATCH', body }),
  deleteLink: (id: string) => navFetch<{ ok: true }>(`/api/nav/links/${id}`, { method: 'DELETE' }),
  orderLinks: (body: { scope: 'pinned' | 'category'; categoryId?: string; orderedIds: string[] }, unlocks?: readonly string[]) => navFetch<{ ok: true }>('/api/nav/links/order', { method: 'POST', body, unlocks }),
  visits: (visits: { linkId: string; count: number }[], keepalive = false) => navFetch<{ ok: true }>('/api/nav/visits', { method: 'POST', body: { visits }, keepalive }),
  importBookmarks: (body: { categories: NavImportCategory[]; links: NavImportLink[]; skipExisting?: boolean }) => navFetch<NavImportResponse>('/api/nav/import', { method: 'POST', body }),
  batch: (body: { action: 'delete' | 'move' | 'rewrite'; ids: string[]; fallbackCategoryId?: string; template?: string }) => navFetch<Record<string, unknown>>('/api/nav/links/batch', { method: 'POST', body }),
  settings: () => navFetch<NavSettingsResponse>('/api/nav/settings'),
  saveSettings: <K extends keyof NavSettings>(group: K, value: NavSettings[K]) => navFetch<{ value: NavSettings[K] }>(`/api/nav/settings/${group}`, { method: 'PUT', body: value }),
  backupConfig: () => navFetch<NavBackupConfigResponse>('/api/nav/webdav/config'),
  saveBackupConfig: (body: { url?: string; username?: string; password?: string; schedule?: string; retention?: number }) => navFetch<NavBackupConfigResponse>('/api/nav/webdav/config', { method: 'PUT', body }),
  webdavTest: (config?: { url?: string; username?: string; password?: string }) => navFetch<NavWebdavTestResponse>('/api/nav/webdav/test', { method: 'POST', body: config ?? {} }),
  webdavBackup: (body: { timestamped?: boolean; url?: string; username?: string; password?: string }) => navFetch<NavWebdavBackupResponse>('/api/nav/webdav/backup', { method: 'POST', body }),
  webdavRestore: (body: { url?: string; username?: string; password?: string }) => navFetch<NavRestoreResponse>('/api/nav/webdav/restore', { method: 'POST', body }),
  exportBackup: () => navFetch<NavBackup>('/api/nav/backup'),
  restoreBackup: (body: NavBackup) => navFetch<NavRestoreResponse>('/api/nav/backup/restore', { method: 'POST', body }),
  webdavForget: () => navFetch<{ ok: true }>('/api/nav/webdav/forget', { method: 'POST' }),
  uploadIcon: (file: File) => {
    const form = new FormData()
    form.set('file', file)
    return navFetch<NavIconsResponse>('/api/nav/icons', { method: 'POST', formData: form })
  },
  captureIcon: (url: string) => navFetch<NavIconsResponse>('/api/nav/icons/capture', { method: 'POST', body: { url } }),
  deleteIcon: (id: string) => navFetch<{ ok: true }>(`/api/nav/icons/${id}`, { method: 'DELETE' }),
  favicon: (domain: string) => navFetch<NavFaviconResponse>(`/api/nav/favicon?domain=${encodeURIComponent(domain)}`),
  cacheFavicon: (domain: string, icon: string) => navFetch<{ ok: true }>('/api/nav/favicon', { method: 'POST', body: { domain, icon } }),
  aiModels: () => navFetch<NavAiModelsResponse>('/api/nav/ai/models'),
  aiSuggest: (body: { title: string; url: string; categories: { id: string; name: string }[] }) => navFetch<NavAiSuggestResponse>('/api/nav/ai/suggest', { method: 'POST', body }),
  check: (urls: string[], signal?: AbortSignal) => navFetch<NavCheckResponse>('/api/nav/check', { method: 'POST', body: { urls }, signal }),
}

export function unlockHeader(tokens: ReadonlyMap<string, string>): string[] {
  return [...tokens.values()]
}

export function categoryOptions(categories: readonly NavCategory[]): { value: string; label: string }[] {
  const roots = categories.filter((category) => !category.parentId)
  const out: { value: string; label: string }[] = []
  for (const root of roots) {
    out.push({ value: root.id, label: root.name })
    for (const child of categories.filter((category) => category.parentId === root.id)) {
      out.push({ value: child.id, label: `${root.name} / ${child.name}` })
    }
  }
  return out
}

export function isNavCheckLevel(value: string): value is NavCheckResult['level'] {
  return value === 'ok' || value === 'warning' || value === 'broken' || value === 'skipped'
}

/**
 * API client for Short Links management endpoints (`/api/tools/shortlinks/*`).
 */

import type {
  BreakdownPage,
  BundleStats,
  ClickStats,
  DashboardStats,
  ShortLink,
  ShortLinkBundle,
  ShortLinkSlug,
  ShortlinkApiKey,
  ShortlinkBackup,
  ShortlinksSettings,
  TimelineData,
  TimelineRange,
} from '@shared/tools/shortlinks/types'
import type {
  AddSlugInput,
  CreateApiKeyInput,
  CreateBundleInput,
  CreateLinkInput,
  ImportDataInput,
  UpdateBundleInput,
  UpdateLinkInput,
  UpdateSettingsInput,
} from '@shared/tools/shortlinks/schemas'
import { request } from '../../../lib/api'

export interface GetLinksParams {
  limit?: number
  offset?: number
  search?: string
  status?: 'all' | 'active' | 'disabled'
  sort_by?: 'created_at' | 'clicks' | 'url' | 'label'
  sort_order?: 'asc' | 'desc'
  bundle_id?: number
}

export const shortlinksApi = {
  getDashboard: () =>
    request<{ data: DashboardStats }>('/api/tools/shortlinks/dashboard').then((r) => r.data),

  getLinks: (params?: GetLinksParams) => {
    const q = new URLSearchParams()
    if (params?.limit) q.set('limit', String(params.limit))
    if (params?.offset) q.set('offset', String(params.offset))
    if (params?.search) q.set('search', params.search)
    if (params?.status) q.set('status', params.status)
    if (params?.sort_by) q.set('sort_by', params.sort_by)
    if (params?.sort_order) q.set('sort_order', params.sort_order)
    if (params?.bundle_id) q.set('bundle_id', String(params.bundle_id))
    const queryStr = q.toString()
    return request<{
      data: { links: ShortLink[]; total: number; limit: number; offset: number }
    }>(`/api/tools/shortlinks/links${queryStr ? `?${queryStr}` : ''}`).then((r) => r.data)
  },

  createLink: (input: CreateLinkInput) =>
    request<{ data: ShortLink }>('/api/tools/shortlinks/links', {
      method: 'POST',
      body: input,
    }).then((r) => r.data),

  getLink: (id: number) =>
    request<{ data: ShortLink }>(`/api/tools/shortlinks/links/${id}`).then((r) => r.data),

  updateLink: (id: number, input: UpdateLinkInput) =>
    request<{ data: ShortLink }>(`/api/tools/shortlinks/links/${id}`, {
      method: 'PATCH',
      body: input,
    }).then((r) => r.data),

  deleteLink: (id: number) =>
    request<{ data: { success: boolean } }>(`/api/tools/shortlinks/links/${id}`, {
      method: 'DELETE',
    }).then((r) => r.data),

  addSlug: (linkId: number, input: AddSlugInput) =>
    request<{ data: ShortLinkSlug }>(`/api/tools/shortlinks/links/${linkId}/slugs`, {
      method: 'POST',
      body: input,
    }).then((r) => r.data),

  setPrimarySlug: (linkId: number, slug: string) =>
    request<{ data: { success: boolean } }>(
      `/api/tools/shortlinks/links/${linkId}/slugs/${encodeURIComponent(slug)}/primary`,
      { method: 'PATCH' },
    ).then((r) => r.data),

  setSlugStatus: (linkId: number, slug: string, isActive: boolean) =>
    request<{ data: { success: boolean } }>(
      `/api/tools/shortlinks/links/${linkId}/slugs/${encodeURIComponent(slug)}/status`,
      {
        method: 'PATCH',
        body: { is_active: isActive },
      },
    ).then((r) => r.data),

  deleteSlug: (linkId: number, slug: string) =>
    request<{ data: { success: boolean } }>(
      `/api/tools/shortlinks/links/${linkId}/slugs/${encodeURIComponent(slug)}`,
      { method: 'DELETE' },
    ).then((r) => r.data),

  getLinkStats: (id: number, range?: TimelineRange) =>
    request<{ data: ClickStats }>(
      `/api/tools/shortlinks/links/${id}/stats${range ? `?range=${range}` : ''}`,
    ).then((r) => r.data),

  getLinkTimeline: (id: number, range?: TimelineRange) =>
    request<{ data: TimelineData }>(
      `/api/tools/shortlinks/links/${id}/timeline${range ? `?range=${range}` : ''}`,
    ).then((r) => r.data),

  getLinkBreakdown: (
    id: number,
    params: {
      dimension: string
      range?: TimelineRange
      limit?: number
      offset?: number
      search?: string
    },
  ) => {
    const q = new URLSearchParams()
    q.set('dimension', params.dimension)
    if (params.range) q.set('range', params.range)
    if (params.limit) q.set('limit', String(params.limit))
    if (params.offset) q.set('offset', String(params.offset))
    if (params.search) q.set('search', params.search)
    return request<{ data: BreakdownPage }>(
      `/api/tools/shortlinks/links/${id}/breakdown?${q.toString()}`,
    ).then((r) => r.data)
  },

  getBundles: () =>
    request<{ data: ShortLinkBundle[] }>('/api/tools/shortlinks/bundles').then((r) => r.data),

  createBundle: (input: CreateBundleInput) =>
    request<{ data: ShortLinkBundle }>('/api/tools/shortlinks/bundles', {
      method: 'POST',
      body: input,
    }).then((r) => r.data),

  updateBundle: (id: number, input: UpdateBundleInput) =>
    request<{ data: ShortLinkBundle }>(`/api/tools/shortlinks/bundles/${id}`, {
      method: 'PATCH',
      body: input,
    }).then((r) => r.data),

  deleteBundle: (id: number) =>
    request<{ data: { success: boolean } }>(`/api/tools/shortlinks/bundles/${id}`, {
      method: 'DELETE',
    }).then((r) => r.data),

  getBundleLinks: (id: number) =>
    request<{ data: ShortLink[] }>(`/api/tools/shortlinks/bundles/${id}/links`).then((r) => r.data),

  addLinksToBundle: (id: number, linkIds: number[]) =>
    request<{ data: { success: boolean } }>(`/api/tools/shortlinks/bundles/${id}/links`, {
      method: 'POST',
      body: { link_ids: linkIds },
    }).then((r) => r.data),

  removeLinkFromBundle: (id: number, linkId: number) =>
    request<{ data: { success: boolean } }>(
      `/api/tools/shortlinks/bundles/${id}/links/${linkId}`,
      { method: 'DELETE' },
    ).then((r) => r.data),

  getBundleStats: (id: number, range?: TimelineRange) =>
    request<{ data: BundleStats }>(
      `/api/tools/shortlinks/bundles/${id}/stats${range ? `?range=${range}` : ''}`,
    ).then((r) => r.data),

  getSettings: () =>
    request<{ data: ShortlinksSettings }>('/api/tools/shortlinks/settings').then((r) => r.data),

  updateSettings: (input: UpdateSettingsInput) =>
    request<{ data: ShortlinksSettings }>('/api/tools/shortlinks/settings', {
      method: 'PATCH',
      body: input,
    }).then((r) => r.data),

  getApiKeys: () =>
    request<{ data: ShortlinkApiKey[] }>('/api/tools/shortlinks/api-keys').then((r) => r.data),

  createApiKey: (input: CreateApiKeyInput) =>
    request<{ data: ShortlinkApiKey }>('/api/tools/shortlinks/api-keys', {
      method: 'POST',
      body: input,
    }).then((r) => r.data),

  deleteApiKey: (id: number) =>
    request<{ data: { success: boolean } }>(`/api/tools/shortlinks/api-keys/${id}`, {
      method: 'DELETE',
    }).then((r) => r.data),

  exportTxt: () =>
    request<{ data: { r2_key: string; url: string } }>('/api/tools/shortlinks/export/txt').then(
      (r) => r.data,
    ),

  exportCsv: () =>
    request<{ data: { r2_key: string; url: string } }>('/api/tools/shortlinks/export/csv').then(
      (r) => r.data,
    ),

  importData: (input: ImportDataInput) =>
    request<{ data: { imported: number; errors: string[] } }>('/api/tools/shortlinks/import', {
      method: 'POST',
      body: input,
    }).then((r) => r.data),

  getBackups: () =>
    request<{ data: ShortlinkBackup[] }>('/api/tools/shortlinks/backups').then((r) => r.data),

  createBackup: () =>
    request<{ data: ShortlinkBackup }>('/api/tools/shortlinks/backups', {
      method: 'POST',
    }).then((r) => r.data),

  restoreBackup: (backupId: string | number) =>
    request<{ data: { restored: number } }>('/api/tools/shortlinks/backups/restore', {
      method: 'POST',
      body: { backup_id: String(backupId) },
    }).then((r) => r.data),
}

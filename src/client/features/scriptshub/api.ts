/**
 * The ScriptsHub API client.
 *
 * A thin mapping over `request`, one function per route, so the screens never assemble a URL or a
 * query by hand. The mutation functions return the row the server wrote rather than a bare `ok`,
 * which is what lets an editor replace its detail without a second read.
 */

import type {
  ScriptAsset,
  ScriptBatchInput,
  ScriptBatchResult,
  ScriptFolder,
  ScriptFolderInput,
  ScriptImportInput,
  ScriptImportResult,
  ScriptListQuery,
  ScriptListResponse,
  ScriptPublication,
  ScriptPublicationCreated,
  ScriptPublicationInput,
  ScriptPublicationPatch,
  ScriptRevisionMeta,
  ScriptRevisionSnapshot,
  ScriptSnippetDetail,
  ScriptSnippetInput,
  ScriptSnippetSaveInput,
  ScriptStatsRange,
  ScriptStatsResponse,
  ScriptTag,
  ScriptTagInput,
  ScriptsHubOverview,
} from '@shared/scriptshub/types'
import { request } from '../../lib/api'

function queryString(query: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

export const scriptshubApi = {
  overview: () => request<ScriptsHubOverview>('/api/scriptshub/overview'),

  listSnippets: (query: ScriptListQuery) => request<ScriptListResponse>(
    `/api/scriptshub/snippets${queryString({
      search: query.search,
      folderId: query.folderId,
      tagId: query.tagId,
      quick: query.quick === 'all' ? null : query.quick,
      sort: query.sort,
      limit: query.limit,
      offset: query.offset,
    })}`,
  ),

  createSnippet: (input: ScriptSnippetInput) =>
    request<ScriptSnippetDetail>('/api/scriptshub/snippets', { method: 'POST', body: input }),

  getSnippet: (id: string) => request<ScriptSnippetDetail>(`/api/scriptshub/snippets/${encodeURIComponent(id)}`),

  updateSnippet: (id: string, input: Partial<ScriptSnippetInput> & {
    isFavorite?: boolean
    isPinned?: boolean
    isDeprecated?: boolean
  }) => request<ScriptSnippetDetail>(`/api/scriptshub/snippets/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  }),

  saveSnippet: (id: string, input: ScriptSnippetSaveInput) =>
    request<ScriptSnippetDetail>(`/api/scriptshub/snippets/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: input,
    }),

  deleteSnippet: (id: string) =>
    request<{ ok: true }>(`/api/scriptshub/snippets/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  batch: (input: ScriptBatchInput) =>
    request<ScriptBatchResult>('/api/scriptshub/snippets/batch', { method: 'POST', body: input }),

  recordCopy: (id: string, fileId: string | null, surface = 'app') =>
    request<{ ok: true }>(`/api/scriptshub/snippets/${encodeURIComponent(id)}/copies`, {
      method: 'POST',
      body: { fileId, surface },
    }),

  revisions: (id: string) =>
    request<{ revisions: ScriptRevisionMeta[] }>(`/api/scriptshub/snippets/${encodeURIComponent(id)}/revisions`),

  readRevision: (id: string, version: number) =>
    request<ScriptRevisionSnapshot>(`/api/scriptshub/snippets/${encodeURIComponent(id)}/revisions/${version}`),

  restoreRevision: (id: string, version: number) =>
    request<ScriptSnippetDetail>(`/api/scriptshub/snippets/${encodeURIComponent(id)}/revisions/${version}/restore`, {
      method: 'POST',
    }),

  createFolder: (input: ScriptFolderInput) =>
    request<ScriptFolder>('/api/scriptshub/folders', { method: 'POST', body: input }),

  updateFolder: (id: string, input: Partial<ScriptFolderInput>) =>
    request<ScriptFolder>(`/api/scriptshub/folders/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),

  deleteFolder: (id: string) =>
    request<{ ok: true }>(`/api/scriptshub/folders/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  createTag: (input: ScriptTagInput) =>
    request<ScriptTag>('/api/scriptshub/tags', { method: 'POST', body: input }),

  updateTag: (id: string, input: Partial<ScriptTagInput>) =>
    request<ScriptTag>(`/api/scriptshub/tags/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),

  deleteTag: (id: string) =>
    request<{ ok: true }>(`/api/scriptshub/tags/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  publications: () =>
    request<{ publications: ScriptPublication[] }>('/api/scriptshub/publications'),

  createPublication: (snippetId: string, input: ScriptPublicationInput) =>
    request<ScriptPublicationCreated>(`/api/scriptshub/snippets/${encodeURIComponent(snippetId)}/publications`, {
      method: 'POST',
      body: input,
    }),

  updatePublication: (id: string, input: ScriptPublicationPatch) =>
    request<ScriptPublication>(`/api/scriptshub/publications/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: input,
    }),

  rotateToken: (id: string) =>
    request<{ publication: ScriptPublication; token: string; tokenUrl: string }>(
      `/api/scriptshub/publications/${encodeURIComponent(id)}/token`,
      { method: 'POST' },
    ),

  deletePublication: (id: string) =>
    request<{ ok: true }>(`/api/scriptshub/publications/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  stats: (range: ScriptStatsRange) =>
    request<ScriptStatsResponse>(`/api/scriptshub/stats${queryString({ range })}`),

  importEntries: (input: ScriptImportInput) =>
    request<ScriptImportResult>('/api/scriptshub/import', { method: 'POST', body: input }),

  exportEntries: async (format: 'generic' | 'masscode' | 'vscode'): Promise<string> => {
    const response = await fetch(`/api/scriptshub/export?format=${format}`, {
      headers: { 'X-Inkstone-Client': '1' },
      credentials: 'same-origin',
    })
    if (!response.ok) throw new Error(`Export failed (${response.status})`)
    return response.text()
  },

  assets: (snippetId: string) =>
    request<{ assets: ScriptAsset[] }>(`/api/scriptshub/snippets/${encodeURIComponent(snippetId)}/assets`),

  uploadAsset: (snippetId: string, file: File) => {
    const form = new FormData()
    form.set('file', file)
    return request<{ asset: ScriptAsset }>(`/api/scriptshub/snippets/${encodeURIComponent(snippetId)}/assets`, {
      method: 'POST',
      formData: form,
    })
  },

  deleteAsset: (id: string) =>
    request<{ ok: true }>(`/api/scriptshub/assets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

export function assetUrl(id: string): string {
  return `/api/scriptshub/assets/${encodeURIComponent(id)}`
}

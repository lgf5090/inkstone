/** Typed calls to /api/inknote. The worker is the only source of truth for every shape here. */
import { request } from '../../lib/api'
import type {
  InknoteLibraryResponse,
  InknoteNoteResponse,
  InknotePageSaveResponse,
  InknoteSearchResponse,
  InknoteSettingsResponse,
  InknoteSnapshotsResponse,
  InknoteTemplatesResponse,
  InknoteTimelineResponse,
  InknoteUsageResponse,
} from '@shared/inknote/api'
import type {
  InknoteAsset,
  InknoteNoteMeta,
  InknotePage,
  InknoteRecording,
  InknoteSettings,
  InknoteSubject,
  InknoteNotebook,
  InknoteTemplate,
  InknoteSnapshotMeta,
} from '@shared/inknote/types'

const BASE = '/api/inknote'

export const inknoteApi = {
  library: () => request<InknoteLibraryResponse>(`${BASE}/library`),
  trash: () => request<{ notes: InknoteNoteMeta[] }>(`${BASE}/trash`),
  note: (id: string, content: 'all' | 'none' = 'all') => request<InknoteNoteResponse>(`${BASE}/notes/${id}?content=${content}`),

  createSubject: (input: { id?: string; name: string; position?: number }) =>
    request<InknoteSubject>(`${BASE}/subjects`, { method: 'POST', body: input }),
  updateSubject: (id: string, patch: { name?: string; position?: number }) =>
    request<InknoteSubject>(`${BASE}/subjects/${id}`, { method: 'PATCH', body: patch }),
  deleteSubject: (id: string) => request<{ trashed: number; removed: number }>(`${BASE}/subjects/${id}`, { method: 'DELETE' }),

  createNotebook: (input: { id?: string; subjectId: string; name: string; coverColor?: string; emoji?: string; position?: number }) =>
    request<InknoteNotebook>(`${BASE}/notebooks`, { method: 'POST', body: input }),
  updateNotebook: (id: string, patch: { name?: string; coverColor?: string; emoji?: string; position?: number }) =>
    request<InknoteNotebook>(`${BASE}/notebooks/${id}`, { method: 'PATCH', body: patch }),
  deleteNotebook: (id: string) => request<{ trashed: number; removed: number }>(`${BASE}/notebooks/${id}`, { method: 'DELETE' }),

  createNote: (input: { id?: string; notebookId: string; title?: string; paper?: unknown }) =>
    request<InknoteNoteResponse>(`${BASE}/notes`, { method: 'POST', body: input }),
  updateNote: (id: string, patch: { title?: string; notebookId?: string; paper?: unknown; pageWidth?: number; pageHeight?: number; colorTag?: string | null; pinned?: boolean; baseRev: number }) =>
    request<InknoteNoteMeta>(`${BASE}/notes/${id}`, { method: 'PATCH', body: patch }),
  deleteNote: (id: string) => request<{ deletedAt: number }>(`${BASE}/notes/${id}`, { method: 'DELETE' }),
  restoreNote: (id: string) => request<InknoteNoteMeta>(`${BASE}/notes/${id}/restore`, { method: 'POST' }),
  purgeNote: (id: string) => request<{ purged: true }>(`${BASE}/notes/${id}/purge`, { method: 'DELETE' }),
  duplicateNote: (id: string, title?: string) => request<InknoteNoteResponse>(`${BASE}/notes/${id}/duplicate`, { method: 'POST', body: { title } }),

  createPage: (noteId: string, input: { id?: string; afterPageId?: string; content?: string } = {}) =>
    request<InknotePage>(`${BASE}/notes/${noteId}/pages`, { method: 'POST', body: input }),
  savePage: (noteId: string, pageId: string, content: string, baseRev: number) =>
    request<InknotePageSaveResponse & { searchText: string }>(`${BASE}/notes/${noteId}/pages/${pageId}`, { method: 'PUT', body: { content, baseRev } }),
  duplicatePage: (noteId: string, pageId: string) =>
    request<InknotePage>(`${BASE}/notes/${noteId}/pages/${pageId}/duplicate`, { method: 'POST' }),
  deletePage: (noteId: string, pageId: string) =>
    request<{ deleted: true }>(`${BASE}/notes/${noteId}/pages/${pageId}`, { method: 'DELETE' }),
  reorderPages: (noteId: string, pageIds: string[]) =>
    request<{ pageIds: string[] }>(`${BASE}/notes/${noteId}/pages/order`, { method: 'PATCH', body: { pageIds } }),
  copyPage: (targetNoteId: string, sourceNoteId: string, pageId: string) =>
    request<InknotePage>(`${BASE}/notes/${targetNoteId}/pages/copy`, { method: 'POST', body: { sourceNoteId, pageId } }),

  search: (q: string, options: { notebookId?: string; limit?: number } = {}) => {
    const params = new URLSearchParams({ q })
    if (options.notebookId) params.set('notebookId', options.notebookId)
    if (options.limit) params.set('limit', String(options.limit))
    return request<InknoteSearchResponse>(`${BASE}/search?${params.toString()}`)
  },

  settings: () => request<InknoteSettingsResponse>(`${BASE}/settings`),
  saveSettings: (config: InknoteSettings, baseUpdatedAt?: number) =>
    request<InknoteSettingsResponse>(`${BASE}/settings`, { method: 'PUT', body: { config, ...(baseUpdatedAt === undefined ? {} : { baseUpdatedAt }) } }),

  templates: () => request<InknoteTemplatesResponse>(`${BASE}/templates`),
  createTemplate: (input: { name: string; paper: unknown; bgAssetId?: string | null; texts?: unknown; title?: string; sub?: string }) =>
    request<InknoteTemplate>(`${BASE}/templates`, { method: 'POST', body: input }),
  renameTemplate: (id: string, name: string) => request<InknoteTemplate>(`${BASE}/templates/${id}`, { method: 'PATCH', body: { name } }),
  deleteTemplate: (id: string) => request<{ ok: true }>(`${BASE}/templates/${id}`, { method: 'DELETE' }),

  uploadAsset: async (file: File, kind: InknoteAsset['kind'], noteId?: string, pageId?: string): Promise<InknoteAsset> => {
    const form = new FormData()
    form.set('file', file)
    form.set('kind', kind)
    if (noteId) form.set('noteId', noteId)
    if (pageId) form.set('pageId', pageId)
    const response = await fetch(`${BASE}/assets`, {
      method: 'POST',
      body: form,
      headers: { 'X-Inkstone-Client': '1' },
      credentials: 'same-origin',
    })
    if (!response.ok) {
      const data = await response.json().catch(() => null) as { error?: { message?: string } } | null
      throw new Error(data?.error?.message ?? `Upload failed (${response.status})`)
    }
    return await response.json() as InknoteAsset
  },
  deleteAsset: (id: string) => request<{ ok: true }>(`${BASE}/assets/${id}`, { method: 'DELETE' }),
  assets: (noteId: string, kind?: InknoteAsset['kind']) =>
    request<{ assets: InknoteAsset[] }>(`${BASE}/assets?noteId=${encodeURIComponent(noteId)}${kind ? `&kind=${encodeURIComponent(kind)}` : ''}`),
  pruneAssets: () => request<{ removed: number; bytes: number }>(`${BASE}/assets/prune`, { method: 'POST' }),

  recordings: (noteId: string) => request<{ recordings: InknoteRecording[] }>(`${BASE}/recordings?noteId=${encodeURIComponent(noteId)}`),
  createRecording: (input: { noteId: string; title: string; durationMs: number; audioAssetId: string; timeline: unknown[]; peaks: number[] }) =>
    request<InknoteRecording>(`${BASE}/recordings`, { method: 'POST', body: input }),
  timeline: (id: string) => request<InknoteTimelineResponse>(`${BASE}/recordings/${id}/timeline`),
  deleteRecording: (id: string) => request<{ ok: true }>(`${BASE}/recordings/${id}`, { method: 'DELETE' }),

  snapshots: () => request<InknoteSnapshotsResponse>(`${BASE}/snapshots`),
  createSnapshot: (label?: string) => request<InknoteSnapshotMeta>(`${BASE}/snapshots`, { method: 'POST', body: label ? { label } : {} }),
  restoreSnapshot: (id: string) => request<{ restored: boolean; missingAssets: string[] }>(`${BASE}/snapshots/${id}/restore`, { method: 'POST' }),
  deleteSnapshot: (id: string) => request<{ ok: true }>(`${BASE}/snapshots/${id}`, { method: 'DELETE' }),
  usage: () => request<InknoteUsageResponse>(`${BASE}/usage`),
}

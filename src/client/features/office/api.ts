import { CLIENT_HEADER } from '@shared/constants'
import type { OfficeFileType } from '@shared/office/constants'
import type {
  OfficeAsset,
  OfficeBatchAction,
  OfficeFileSummary,
  OfficeFolder,
  OfficeFolderInput,
  OfficeListFilters,
  OfficeSaveResult,
  OfficeSnapshot,
  OfficeSnapshotResponse,
  OfficeTag,
  OfficeTagInput,
  OfficeVersionSummary,
} from '@shared/office/model'
import { ApiError, CLIENT_ID, request, routeApiError } from '../../lib/api'
import { t } from '../../lib/i18n'

/** The filter set the list screen actually sends; `pinned` is an extra view switch on top of §7. */
export interface OfficeFileListQuery extends OfficeListFilters {
  pinned?: boolean
}

export interface OfficeFilePatch {
  title?: string
  folderId?: string | null
  isPinned?: boolean
  isStarred?: boolean
  tagIds?: string[]
}

export interface OfficeFolderPatch {
  name?: string
  parentId?: string | null
  icon?: string | null
  color?: string | null
  beforeId?: string | null
}

export interface OfficeTagPatch {
  name?: string
  color?: string | null
  isPinned?: boolean
}

type QueryValue = string | number | boolean | null | undefined

function toQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

function filePath(id: string, suffix = ''): string {
  return `/api/office/files/${encodeURIComponent(id)}${suffix}`
}

export function officeErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `X-Office-Name` is only a display name. It is percent-encoded because a header may not carry
 * arbitrary UTF-8; the worker decodes it before cleaning the path separators out.
 */
async function uploadOfficeAsset(file: File): Promise<OfficeAsset> {
  let response: Response
  try {
    response = await fetch('/api/office/assets', {
      method: 'POST',
      headers: {
        [CLIENT_HEADER]: '1',
        'X-Inkstone-Origin': CLIENT_ID,
        'Content-Type': file.type || 'application/octet-stream',
        'X-Office-Name': encodeURIComponent(file.name),
      },
      body: file,
      credentials: 'same-origin',
    })
  } catch {
    throw new ApiError(0, 'offline', t('api.no_network_connection'))
  }
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  const data = mediaType === 'application/json' ? await response.json().catch(() => null) : null
  if (!response.ok) throw routeApiError(response.status, data)
  return data as OfficeAsset
}

/** The Office metadata/content routes, in the same request style as `lib/api`. */
export const officeApi = {
  listFiles: (query: OfficeFileListQuery = {}, signal?: AbortSignal) =>
    request<{ files: OfficeFileSummary[] }>(`/api/office/files${toQuery({
      type: query.type,
      q: query.query,
      trash: query.trash,
      folderId: query.folderId,
      tagId: query.tagId,
      starred: query.starred,
      recent: query.recent,
      pinned: query.pinned,
      limit: query.limit,
    })}`, { signal }),

  createFile: (body: { type: OfficeFileType; title: string; folderId?: string | null }) =>
    request<{ file: OfficeFileSummary }>('/api/office/files', { method: 'POST', body }),

  /**
   * Copies the reader's "apply without asking" decision into the account settings.
   *
   * The interactive path reads this browser's storage; a scheduled routine runs in the worker and can
   * only see the stored account value, so one switch has to reach both.
   */
  setUnattendedApply: (value: boolean) =>
    request<{ settings: unknown }>('/api/assistant/settings', { method: 'PATCH', body: { officeUnattendedApply: value } }),
  usage: (signal?: AbortSignal) =>
    request<{ usage: { files: number; bytes: number }; limits: { files: number; bytes: number } }>('/api/office/usage', { signal }),
  getFile: (id: string, signal?: AbortSignal) =>
    request<{ file: OfficeFileSummary }>(filePath(id), { signal }),

  patchFile: (id: string, body: OfficeFilePatch) =>
    request<{ file: OfficeFileSummary }>(filePath(id), { method: 'PATCH', body }),

  openFile: (id: string) =>
    request<{ file: OfficeFileSummary }>(filePath(id, '/open'), { method: 'POST' }),

  batch: (body: OfficeBatchAction) =>
    request<{ ok: true; affected: number }>('/api/office/files/batch', { method: 'POST', body }),

  removeFile: (id: string, purge = false) =>
    request<{ ok: true }>(filePath(id, purge ? '?purge=1' : ''), { method: 'DELETE' }),

  restoreFile: (id: string) =>
    request<{ file: OfficeFileSummary }>(filePath(id, '/restore'), { method: 'POST' }),

  duplicateFile: (id: string) =>
    request<{ file: OfficeFileSummary }>(filePath(id, '/duplicate'), { method: 'POST' }),

  snapshot: (id: string, signal?: AbortSignal) =>
    request<OfficeSnapshotResponse>(filePath(id, '/snapshot'), { signal, cache: 'no-store' }),

  saveSnapshot: (id: string, baseRev: number, snapshot: OfficeSnapshot) =>
    request<OfficeSaveResult>(filePath(id, '/snapshot'), {
      method: 'PUT',
      body: { baseRev, snapshot },
      timeoutMs: 60_000,
    }),

  versions: (id: string, signal?: AbortSignal) =>
    request<{ versions: OfficeVersionSummary[] }>(filePath(id, '/versions'), { signal }),

  restoreVersion: (id: string, rev: number) =>
    request<{ rev: number }>(filePath(id, `/versions/${encodeURIComponent(String(rev))}/restore`), { method: 'POST' }),

  folders: (signal?: AbortSignal) =>
    request<{ folders: OfficeFolder[] }>('/api/office/folders', { signal }),

  createFolder: (body: OfficeFolderInput) =>
    request<{ folder: OfficeFolder }>('/api/office/folders', { method: 'POST', body }),

  patchFolder: (id: string, body: OfficeFolderPatch) =>
    request<{ folder: OfficeFolder }>(`/api/office/folders/${encodeURIComponent(id)}`, { method: 'PATCH', body }),

  removeFolder: (id: string, strategy: 'move-up' | 'delete') =>
    request<{ ok: true }>(`/api/office/folders/${encodeURIComponent(id)}?strategy=${strategy}`, { method: 'DELETE' }),

  restoreFolder: (id: string) =>
    request<{ folder: OfficeFolder }>(`/api/office/folders/${encodeURIComponent(id)}/restore`, { method: 'POST' }),

  tags: (signal?: AbortSignal) =>
    request<{ tags: OfficeTag[] }>('/api/office/tags', { signal }),

  createTag: (body: OfficeTagInput) =>
    request<{ tag: OfficeTag }>('/api/office/tags', { method: 'POST', body }),

  patchTag: (id: string, body: OfficeTagPatch) =>
    request<{ tag: OfficeTag }>(`/api/office/tags/${encodeURIComponent(id)}`, { method: 'PATCH', body }),

  removeTag: (id: string) =>
    request<{ ok: true }>(`/api/office/tags/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  assetUrl: (id: string) => `/api/office/assets/${encodeURIComponent(id)}`,

  uploadAsset: uploadOfficeAsset,
}
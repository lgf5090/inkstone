import {
  type HubAttachmentListParams,
  type HubAttachmentListResponse,
  type HubAttachmentOwner,
  type HubAttachmentWithUsage,
  type HubBatchRequest,
  type HubFolder,
  type HubPruneResult,
  type HubTag,
  type AttachmentHubScope,
} from '@shared/attachment-hub'
import { request, type RequestOptions } from '../../lib/api'

/**
 * The hub's client, one implementation for four applications.
 *
 * The scope is the only thing a caller supplies that differs; it becomes a path segment, so a
 * caller cannot address another account's files by naming a table, and the server validates the
 * segment against its own registry rather than trusting this module to have listed it correctly.
 */

const HUB_PREFIX = '/api/attachments'

function hubRequest<T>(
  scope: AttachmentHubScope,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  return request<T>(`${HUB_PREFIX}/${scope}${path}`, options)
}

function listQuery(params: HubAttachmentListParams): string {
  const search = new URLSearchParams()
  if (params.folderId === 'unfiled') search.set('folderId', 'unfiled')
  else if (params.folderId) search.set('folderId', params.folderId)
  if (params.type) search.set('type', params.type)
  if (params.sizeRange) search.set('sizeRange', params.sizeRange)
  if (params.minBytes !== undefined) search.set('minBytes', String(params.minBytes))
  if (params.maxBytes !== undefined) search.set('maxBytes', String(params.maxBytes))
  if (params.tag) search.set('tag', params.tag)
  if (params.starred) search.set('starred', '1')
  if (params.pinned) search.set('pinned', '1')
  if (params.unreferenced) search.set('unreferenced', '1')
  if (params.extension) search.set('extension', params.extension)
  if (params.search) search.set('search', params.search)
  if (params.sort) search.set('sort', params.sort)
  if (params.cursor) search.set('cursor', params.cursor)
  if (params.limit) search.set('limit', String(params.limit))
  const query = search.toString()
  return query ? `?${query}` : ''
}

export interface AttachmentHubApi {
  list(scope: AttachmentHubScope, params?: HubAttachmentListParams, signal?: AbortSignal):
    Promise<HubAttachmentListResponse>
  upload(scope: AttachmentHubScope, file: File, folderId?: string | null):
    Promise<HubAttachmentWithUsage>
  patch(scope: AttachmentHubScope, id: string, patch: Record<string, unknown>):
    Promise<HubAttachmentWithUsage>
  batch(scope: AttachmentHubScope, request: HubBatchRequest): Promise<{ ok: true; count: number }>
  remove(scope: AttachmentHubScope, id: string): Promise<{ ok: true; cleanupPending: boolean }>
  owners(scope: AttachmentHubScope, id: string): Promise<{ owners: HubAttachmentOwner[] }>
  prune(scope: AttachmentHubScope): Promise<HubPruneResult>
  folders: {
    list(scope: AttachmentHubScope): Promise<HubFolder[]>
    create(scope: AttachmentHubScope, input: Partial<HubFolder>): Promise<HubFolder>
    patch(scope: AttachmentHubScope, id: string, input: Partial<HubFolder>): Promise<HubFolder>
    remove(scope: AttachmentHubScope, id: string): Promise<{ ok: true }>
  }
  tags: {
    list(scope: AttachmentHubScope): Promise<HubTag[]>
    create(scope: AttachmentHubScope, input: { name: string; color?: string | null }): Promise<HubTag>
    patch(scope: AttachmentHubScope, id: string, input: Partial<HubTag>): Promise<HubTag>
    remove(scope: AttachmentHubScope, id: string): Promise<{ ok: true }>
  }
}

export const attachmentHubApi: AttachmentHubApi = {
  list: (scope, params = {}, signal) =>
    hubRequest<HubAttachmentListResponse>(scope, `/files${listQuery(params)}`, { signal }),

  upload: (scope, file, folderId) => {
    const form = new FormData()
    form.set('file', file)
    if (folderId) form.set('folderId', folderId)
    return hubRequest<HubAttachmentWithUsage>(scope, '/files', { method: 'POST', formData: form })
  },

  patch: (scope, id, patch) =>
    hubRequest<HubAttachmentWithUsage>(scope, `/files/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
    }),

  batch: (scope, batch) =>
    hubRequest<{ ok: true; count: number }>(scope, '/files/batch', { method: 'POST', body: batch }),

  remove: (scope, id) =>
    hubRequest<{ ok: true; cleanupPending: boolean }>(
      scope,
      `/files/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  owners: (scope, id) =>
    hubRequest<{ owners: HubAttachmentOwner[] }>(
      scope,
      `/files/${encodeURIComponent(id)}/owners`,
    ),

  prune: (scope) => hubRequest<HubPruneResult>(scope, '/files/prune', { method: 'POST' }),

  folders: {
    list: (scope) => hubRequest<HubFolder[]>(scope, '/folders'),
    create: (scope, input) =>
      hubRequest<HubFolder>(scope, '/folders', { method: 'POST', body: input }),
    patch: (scope, id, input) =>
      hubRequest<HubFolder>(scope, `/folders/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: input,
      }),
    remove: (scope, id) =>
      hubRequest<{ ok: true }>(scope, `/folders/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },

  tags: {
    list: (scope) => hubRequest<HubTag[]>(scope, '/tags'),
    create: (scope, input) => hubRequest<HubTag>(scope, '/tags', { method: 'POST', body: input }),
    patch: (scope, id, input) =>
      hubRequest<HubTag>(scope, `/tags/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),
    remove: (scope, id) =>
      hubRequest<{ ok: true }>(scope, `/tags/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
}

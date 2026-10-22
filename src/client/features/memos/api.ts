import { MEMOS_API_PREFIX } from '@shared/memos/constants'
import type {
  Memo,
  MemoAttachment,
  MemoCommentInput,
  MemoCreateInput,
  MemoListQuery,
  MemoListResponse,
  MemoMediaMetadata,
  MemoMotionRole,
  MemoPatchInput,
  MemoPreferences,
  MemoPreferencesPatch,
  MemoReactionInput,
  MemoReactionSummary,
  MemoRelation,
  MemoShare,
  MemoShareCreateInput,
  MemoSpace,
  MemoSpaceInput,
  MemoStats,
  MemoToken,
  MemoTokenCreateInput,
  MemoTokenCreateResult,
  MemoView,
  MemoViewInput,
  MemoViewValidation,
} from '@shared/memos/types'
import { request, type RequestOptions } from '../../lib/api'

export const MEMO_ATTACHMENT_SCOPES = ['all', 'media', 'audio', 'documents', 'unused'] as const
export type MemoAttachmentScope = (typeof MEMO_ATTACHMENT_SCOPES)[number]

export interface MemoRelationsPair {
  outgoing: MemoRelation[]
  incoming: MemoRelation[]
}

export interface MemoAttachmentPage {
  items: MemoAttachment[]
  nextCursor: string | null
}

export interface MemoAttachmentQuery {
  scope?: MemoAttachmentScope
  spaceId?: string | null
  memoId?: string | null
  cursor?: string | null
  limit?: number
}

export interface MemoCommentQuery {
  cursor?: string | null
  limit?: number
  tz?: string
}

export interface MemoAttachmentUploadInput {
  file: File
  thumbnail?: File | null
  memoId?: string | null
  metadata?: MemoMediaMetadata | null
  motionGroupId?: string | null
  motionRole?: MemoMotionRole | null
}

export interface MemoAttachmentBatchDeleteResult {
  deleted: number
  freedBytes: number
}

export interface MemoAttachmentPruneResult {
  removed: number
  freedBytes: number
}

export type MemoSpaceDeleteMode = 'unfile' | 'delete'

export interface MemoStatsQuery {
  spaceId?: string | null
  from?: number
  to?: number
  tz?: string
  timeBasis?: 'created' | 'updated'
}

export interface MemoPublicQuery {
  cursor?: string | null
  limit?: number
  tz?: string
}

export function memoRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return request<T>(`${MEMOS_API_PREFIX}${path}`, options)
}

function queryString(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const memosApi = {
  list(query: MemoListQuery = {}, signal?: AbortSignal): Promise<MemoListResponse> {
    return memoRequest<MemoListResponse>(queryString({
      state: query.state,
      spaceId: query.spaceId,
      parentId: query.parentId,
      filter: query.filter,
      orderBy: query.orderBy,
      order: query.order,
      cursor: query.cursor,
      limit: query.limit,
      tz: query.tz,
    }), { signal })
  },

  get(id: string, signal?: AbortSignal): Promise<Memo> {
    return memoRequest<Memo>(`/${encodeURIComponent(id)}`, { signal })
  },

  create(input: MemoCreateInput): Promise<Memo> {
    return memoRequest<Memo>('', { method: 'POST', body: input })
  },

  patch(id: string, input: MemoPatchInput): Promise<Memo> {
    return memoRequest<Memo>(`/${encodeURIComponent(id)}`, { method: 'PATCH', body: input })
  },

  remove(id: string): Promise<{ ok: true }> {
    return memoRequest<{ ok: true }>(`/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  restore(id: string): Promise<Memo> {
    return memoRequest<Memo>(`/${encodeURIComponent(id)}/restore`, { method: 'POST' })
  },

  comments: {
    list(id: string, query: MemoCommentQuery = {}, signal?: AbortSignal): Promise<MemoListResponse> {
      return memoRequest<MemoListResponse>(
        `/${encodeURIComponent(id)}/comments${queryString({
          cursor: query.cursor,
          limit: query.limit,
          tz: query.tz,
        })}`,
        { signal },
      )
    },

    create(id: string, input: MemoCommentInput): Promise<Memo> {
      return memoRequest<Memo>(`/${encodeURIComponent(id)}/comments`, { method: 'POST', body: input })
    },
  },

  relations: {
    get(id: string, signal?: AbortSignal): Promise<MemoRelationsPair> {
      return memoRequest<MemoRelationsPair>(`/${encodeURIComponent(id)}/relations`, { signal })
    },

    put(id: string, relatedMemoIds: string[]): Promise<MemoRelationsPair> {
      return memoRequest<MemoRelationsPair>(`/${encodeURIComponent(id)}/relations`, {
        method: 'PUT',
        body: { relatedMemoIds },
      })
    },
  },

  reactions: {
    list(id: string, signal?: AbortSignal): Promise<{ reactions: MemoReactionSummary[] }> {
      return memoRequest<{ reactions: MemoReactionSummary[] }>(
        `/${encodeURIComponent(id)}/reactions`,
        { signal },
      )
    },

    upsert(id: string, input: MemoReactionInput): Promise<{ reactions: MemoReactionSummary[] }> {
      return memoRequest<{ reactions: MemoReactionSummary[] }>(
        `/${encodeURIComponent(id)}/reactions`,
        { method: 'PUT', body: input },
      )
    },

    delete(id: string, type: string): Promise<{ reactions: MemoReactionSummary[] }> {
      return memoRequest<{ reactions: MemoReactionSummary[] }>(
        `/${encodeURIComponent(id)}/reactions/${encodeURIComponent(type)}`,
        { method: 'DELETE' },
      )
    },
  },

  views: {
    list(signal?: AbortSignal): Promise<{ views: MemoView[] }> {
      return memoRequest<{ views: MemoView[] }>('/views', { signal })
    },

    create(input: MemoViewInput): Promise<MemoView> {
      return memoRequest<MemoView>('/views', { method: 'POST', body: input })
    },

    update(id: string, input: Partial<MemoViewInput>): Promise<MemoView> {
      return memoRequest<MemoView>(`/views/${encodeURIComponent(id)}`, { method: 'PATCH', body: input })
    },

    delete(id: string): Promise<{ ok: true }> {
      return memoRequest<{ ok: true }>(`/views/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },

    validate(filter: string): Promise<MemoViewValidation> {
      return memoRequest<MemoViewValidation>('/views/validate', { method: 'POST', body: { filter } })
    },
  },

  preferences: {
    get(signal?: AbortSignal): Promise<MemoPreferences> {
      return memoRequest<MemoPreferences>('/preferences', { signal })
    },

    patch(input: MemoPreferencesPatch): Promise<MemoPreferences> {
      return memoRequest<MemoPreferences>('/preferences', { method: 'PATCH', body: input })
    },
  },

  tokens: {
    list(signal?: AbortSignal): Promise<{ tokens: MemoToken[] }> {
      return memoRequest<{ tokens: MemoToken[] }>('/tokens', { signal })
    },

    create(input: MemoTokenCreateInput): Promise<MemoTokenCreateResult> {
      return memoRequest<MemoTokenCreateResult>('/tokens', { method: 'POST', body: input })
    },

    delete(id: string): Promise<{ ok: true }> {
      return memoRequest<{ ok: true }>(`/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
  },

  spaces: {
    list(signal?: AbortSignal): Promise<{ spaces: MemoSpace[] }> {
      return memoRequest<{ spaces: MemoSpace[] }>('/spaces', { signal })
    },

    create(input: MemoSpaceInput): Promise<MemoSpace> {
      return memoRequest<MemoSpace>('/spaces', { method: 'POST', body: input })
    },

    update(id: string, input: Partial<MemoSpaceInput>): Promise<MemoSpace> {
      return memoRequest<MemoSpace>(`/spaces/${encodeURIComponent(id)}`, { method: 'PATCH', body: input })
    },

    delete(id: string, mode: MemoSpaceDeleteMode = 'unfile'): Promise<{ ok: true }> {
      return memoRequest<{ ok: true }>(
        `/spaces/${encodeURIComponent(id)}${queryString({ mode })}`,
        { method: 'DELETE' },
      )
    },
  },

  attachments: {
    list(query: MemoAttachmentQuery = {}, signal?: AbortSignal): Promise<MemoAttachmentPage> {      return memoRequest<MemoAttachmentPage>(
        `/attachments${queryString({
          scope: query.scope,
          spaceId: query.spaceId,
          memoId: query.memoId,
          cursor: query.cursor,
          limit: query.limit,
        })}`,
        { signal },
      )
    },

    upload(input: MemoAttachmentUploadInput): Promise<MemoAttachment> {
      const form = new FormData()
      form.append('file', input.file)
      if (input.thumbnail) form.append('thumbnail', input.thumbnail)
      if (input.memoId) form.append('memoId', input.memoId)
      if (input.metadata) form.append('metadata', JSON.stringify(input.metadata))
      if (input.motionGroupId) form.append('motionGroupId', input.motionGroupId)
      if (input.motionRole) form.append('motionRole', input.motionRole)
      return memoRequest<MemoAttachment>('/attachments', { method: 'POST', formData: form })
    },

    delete(id: string): Promise<{ ok: true }> {
      return memoRequest<{ ok: true }>(`/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },

    batchDelete(ids: string[]): Promise<MemoAttachmentBatchDeleteResult> {
      return memoRequest<MemoAttachmentBatchDeleteResult>('/attachments/batch-delete', {
        method: 'POST',
        body: { ids },
      })
    },

    prune(): Promise<MemoAttachmentPruneResult> {
      return memoRequest<MemoAttachmentPruneResult>('/attachments/prune', { method: 'POST' })
    },
  },

  stats: {
    get(query: MemoStatsQuery = {}, signal?: AbortSignal): Promise<MemoStats> {
      return memoRequest<MemoStats>(
        `/stats${queryString({
          spaceId: query.spaceId,
          from: query.from,
          to: query.to,
          tz: query.tz,
          timeBasis: query.timeBasis,
        })}`,
        { signal },
      )
    },
  },

  shares: {
    list(memoId: string, signal?: AbortSignal): Promise<{ shares: MemoShare[] }> {
      return memoRequest<{ shares: MemoShare[] }>(`/${encodeURIComponent(memoId)}/shares`, { signal })
    },

    create(memoId: string, input: MemoShareCreateInput): Promise<MemoShare> {
      return memoRequest<MemoShare>(`/${encodeURIComponent(memoId)}/shares`, {
        method: 'POST',
        body: input,
      })
    },

    delete(memoId: string, shareId: string): Promise<{ ok: true }> {
      return memoRequest<{ ok: true }>(
        `/${encodeURIComponent(memoId)}/shares/${encodeURIComponent(shareId)}`,
        { method: 'DELETE' },
      )
    },
  },

  publicMemos: {
    explore(query: MemoPublicQuery = {}, signal?: AbortSignal): Promise<MemoListResponse> {
      return memoRequest<MemoListResponse>(
        `/public/explore${queryString({ cursor: query.cursor, limit: query.limit, tz: query.tz })}`,
        { signal },
      )
    },

    userMemos(username: string, query: MemoPublicQuery = {}, signal?: AbortSignal): Promise<MemoListResponse> {
      return memoRequest<MemoListResponse>(
        `/public/users/${encodeURIComponent(username)}/memos${queryString({
          cursor: query.cursor,
          limit: query.limit,
          tz: query.tz,
        })}`,
        { signal },
      )
    },

    userMemo(username: string, id: string, signal?: AbortSignal): Promise<Memo> {
      return memoRequest<Memo>(
        `/public/users/${encodeURIComponent(username)}/memos/${encodeURIComponent(id)}`,
        { signal },
      )
    },

    share(token: string, signal?: AbortSignal): Promise<Memo> {
      return memoRequest<Memo>(
        `/public/shares/${encodeURIComponent(token)}`,
        { signal },
      )
    },
  },
}

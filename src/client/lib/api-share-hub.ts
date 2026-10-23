import type {
  PublicCollection,
  ShareAuditLogResponse,
  ShareCollectionListResponse,
  ShareFiling,
  ShareFolder,
  ShareGlobalAnalytics,
  ShareNoteAnalytics,
  ShareStatsResponse,
  ShareTag,
  ShareTimelineRange,
  ShareVisitsResponse,
} from '@shared/share-hub'
import type { ShareInfo, ShareListItem } from '@shared/types'
import type { ShareTargetType, VisitLogFilter } from '@shared/share-selection'
import { request } from './api'

/**
 * The share hub's calls, kept beside the types they answer with rather than spread through `api.ts`.
 *
 * `api.share` stays what it always was — the handful of calls the single-note panel and the reader
 * page make — because that surface is a contract with a page an anonymous visitor loads. Everything
 * here is the owner's console: it speaks in categories, folders, collections and visit rows, and it
 * grows when the hub grows without touching anything a reader depends on.
 */

/** Query string built from named, non-empty parts, so no caller hand-assembles a `?`. */
function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const encoded = search.toString()
  return encoded ? `?${encoded}` : ''
}

/** The three traffic toggles every reading accepts. `excludeBots` is on unless turned off. */
export interface TrafficParams {
  excludeBots?: boolean
  excludeSelf?: boolean
  excludeOwner?: boolean
}

export interface AnalyticsParams extends TrafficParams {
  range?: ShareTimelineRange
  signal?: AbortSignal
}

export interface VisitParams extends TrafficParams {
  page?: number
  noteId?: string
  slug?: string
  filter?: VisitLogFilter
  channel?: string
  signal?: AbortSignal
}

/** The access policy a collection is published with. `null` on a field clears it. */
export interface CollectionPolicy {
  title?: string | null
  password?: string | null
  expiresAt?: number | null
  memberSort?: string | null
}

/**
 * The filing an organizer write settled to.
 *
 * The response echoes it rather than making the hub refetch: a row that moved between folders has to
 * leave one sidebar count and enter another, and a refetch racing the user's next click is how a
 * drag ends up showing the pre-drag tree.
 */
export interface OrganizeResponse {
  filing: ShareFiling
}

/** A count of what a batch actually did, which may be fewer than what was named. */
export interface BatchResponse {
  ok: true
  count: number
}

export const shareHubApi = {
  list: (signal?: AbortSignal) =>
    request<{ shares: ShareListItem[] }>('/api/share', { signal }),

  create: (noteId: string, body: { password?: string | null; expiresIn?: number | null }) =>
    request<{ share: ShareInfo }>(`/api/share/${encodeURIComponent(noteId)}`, { method: 'POST', body }),

  remove: (noteId: string) =>
    request<{ ok: true }>(`/api/share/${encodeURIComponent(noteId)}`, { method: 'DELETE' }),

  /** The sidebar's counters alone, so a hub that opens on the dashboard does not fetch a list. */
  stats: (signal?: AbortSignal) =>
    request<ShareStatsResponse>('/api/share/stats', { signal }),

  analytics: {
    global: (params: AnalyticsParams = {}) =>
      request<ShareGlobalAnalytics>(`/api/share/analytics/global${query({
        range: params.range,
        excludeBots: params.excludeBots,
        excludeSelf: params.excludeSelf,
        excludeOwner: params.excludeOwner,
      })}`, { signal: params.signal }),

    note: (noteId: string, params: AnalyticsParams = {}) =>
      request<ShareNoteAnalytics>(
        `/api/share/analytics/note/${encodeURIComponent(noteId)}${query({
          range: params.range,
          excludeBots: params.excludeBots,
          excludeSelf: params.excludeSelf,
          excludeOwner: params.excludeOwner,
        })}`, { signal: params.signal }),

    /**
     * Dismisses the expired-links notice.
     *
     * Answers only that it was recorded: the notice's own content comes back on the next reading, so
     * a client that also updated a count from this response would be holding a number the server
     * never agreed to.
     */
    ackExpired: () =>
      request<{ ok: true }>('/api/share/analytics/expired-ack', { method: 'POST' }),
  },

  visits: {
    list: (params: VisitParams = {}) =>
      request<ShareVisitsResponse>(`/api/share/visits${query({
        page: params.page,
        noteId: params.noteId,
        slug: params.slug,
        filter: params.filter,
        channel: params.channel,
        excludeBots: params.excludeBots,
        excludeSelf: params.excludeSelf,
        excludeOwner: params.excludeOwner,
      })}`, { signal: params.signal }),

    clear: () =>
      request<{ ok: true; deleted: number }>('/api/share/visits', { method: 'DELETE' }),
  },

  folders: {
    list: (signal?: AbortSignal) =>
      request<{ folders: ShareFolder[] }>('/api/share/folders', { signal }),
    create: (body: { name: string; parentId?: string | null; icon?: string | null; color?: string | null }) =>
      request<ShareFolder>('/api/share/folders', { method: 'POST', body }),
    patch: (id: string, body: {
      name?: string
      parentId?: string | null
      icon?: string | null
      color?: string | null
      position?: number
    }) =>
      request<ShareFolder>(`/api/share/folders/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    remove: (id: string) =>
      request<{ ok: true }>(`/api/share/folders/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },

  tags: {
    list: (signal?: AbortSignal) =>
      request<{ tags: ShareTag[] }>('/api/share/tags', { signal }),
    create: (body: { name: string; color?: string | null }) =>
      request<ShareTag>('/api/share/tags', { method: 'POST', body }),
    /** Renaming a tag also rewrites every link that carried the old name; `rewritten` counts them. */
    patch: (id: string, body: { name?: string; color?: string | null; isPinned?: boolean }) =>
      request<{ tag: ShareTag; rewritten: number }>(
        `/api/share/tags/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    remove: (id: string) =>
      request<{ ok: true; rewritten: number }>(
        `/api/share/tags/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },

  organize: (noteId: string, body: { folderId: string | null; tags: string[] }) =>
    request<OrganizeResponse>(
      `/api/share/note/${encodeURIComponent(noteId)}/organize`, { method: 'PUT', body }),

  batch: {
    organize: (noteIds: string[], body: { folderId?: string | null; tags?: string[] }) =>
      request<BatchResponse>('/api/share/batch/organize', { method: 'POST', body: { noteIds, ...body } }),
    setEnabled: (noteIds: string[], enabled: boolean) =>
      request<BatchResponse>('/api/share/batch/enabled', { method: 'POST', body: { noteIds, enabled } }),
    revoke: (noteIds: string[]) =>
      request<BatchResponse>('/api/share/batch/revoke', { method: 'POST', body: { noteIds } }),
  },

  audit: (noteId: string, params: { page?: number; limit?: number; signal?: AbortSignal } = {}) =>
    request<ShareAuditLogResponse>(
      `/api/share/audit/${encodeURIComponent(noteId)}${query({
        page: params.page,
        limit: params.limit,
      })}`, { signal: params.signal }),

  collections: {
    list: (signal?: AbortSignal) =>
      request<ShareCollectionListResponse>('/api/share/collections', { signal }),
    /**
     * Publishes a directory over a folder, a tag, or a hand-picked roster.
     *
     * Re-publishing the same target returns that collection's existing address rather than a second
     * one, so the owner cannot end up with two live links to the same folder by clicking twice.
     */
    create: (body: CollectionPolicy & {
      targetType: ShareTargetType | 'manual'
      targetValue?: string
      noteIds?: string[]
    }) =>
      request<{ id: string; slug: string }>('/api/share/collections', { method: 'POST', body }),
    patch: (id: string, body: CollectionPolicy & { isEnabled?: boolean }) =>
      request<{ ok: true }>(`/api/share/collections/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    setMembers: (id: string, noteIds: string[]) =>
      request<{ ok: true; members: number; written: number }>(
        `/api/share/collections/${encodeURIComponent(id)}/members`, { method: 'PUT', body: { noteIds } }),
    remove: (id: string) =>
      request<{ ok: true }>(`/api/share/collections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },

  /**
   * The public directory, read the way an anonymous visitor reads it.
   *
   * Deliberately the unauthenticated endpoint rather than an owner-side one: the hub's preview has to
   * show what a stranger sees, including the refusal a passcode or an expiry produces, not a privileged
   * rendering the owner mistakes for the published page.
   */
  readCollection: (slug: string, password?: string, signal?: AbortSignal) =>
    request<PublicCollection>(
      `/api/public/c/${encodeURIComponent(slug)}`, { method: 'POST', body: { password }, signal }),
}

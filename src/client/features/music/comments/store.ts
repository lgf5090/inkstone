/**
 * Comments of the track Now Playing is showing, cached per track for the life of the page.
 *
 * The store owns the two lists the pane draws: the hot page (first page only) and the latest page
 * stream. Every request carries a generation token; an answer that arrives after the reader switched
 * tracks, reset the pane or started a newer request is dropped rather than written into a list it no
 * longer describes. Likes are applied optimistically to both lists and rolled back exactly if the
 * provider refuses. Nothing here is persisted: comments are third-party content and leave with the tab.
 */
import { create } from 'zustand'
import type { MusicComment, MusicCommentPage } from '@shared/music/comments'
import { musicApi } from '../api'

/** How many comments one page carries; the worker accepts 1..50. */
export const COMMENTS_PAGE_SIZE = 30

export type CommentsStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface CommentsBucket {
  trackId: string
  /** The hot page; only the first page of a track fills it. */
  hot: MusicComment[]
  latest: MusicComment[]
  total: number
  status: CommentsStatus
  error: string | null
  hasMore: boolean
  loadingMore: boolean
  loadMoreError: string | null
  /** Comment ids with a like request in flight, so a double press only sends one write. */
  likeBusy: Readonly<Record<string, true>>
  /** Bumped when the bucket is replaced; answers from an older token are discarded. */
  generation: number
}

export interface CommentLikeOutcome {
  ok: boolean
  /** True when another press for the same comment is already in flight. */
  busy?: boolean
  error?: unknown
}

export interface LoadCommentsOptions {
  /** Drop the cached pages and fetch the first one again, as the retry action does. */
  reset?: boolean
}

interface CommentsState {
  /**
   * The track the open pane or the quiet layer is showing. An answer for another track is stale even
   * when its own bucket still exists: the reader has moved on.
   */
  activeTrackId: string | null
  buckets: Record<string, CommentsBucket>
  load: (trackId: string, options?: LoadCommentsOptions) => Promise<void>
  loadMore: (trackId: string) => Promise<void>
  like: (trackId: string, commentId: string, liked: boolean) => Promise<CommentLikeOutcome>
}

function emptyBucket(trackId: string, generation: number): CommentsBucket {
  return {
    trackId,
    hot: [],
    latest: [],
    total: 0,
    status: 'idle',
    error: null,
    hasMore: false,
    loadingMore: false,
    loadMoreError: null,
    likeBusy: {},
    generation,
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Append only comments the list has not shown yet, keeping the provider's order. */
function appendUnseen(current: readonly MusicComment[], incoming: readonly MusicComment[]): MusicComment[] {
  if (incoming.length === 0) return [...current]
  const seen = new Set(current.map((comment) => comment.id))
  const out = [...current]
  for (const comment of incoming) {
    if (seen.has(comment.id)) continue
    seen.add(comment.id)
    out.push(comment)
  }
  return out
}

function withoutBusy(busy: Readonly<Record<string, true>>, commentId: string): Record<string, true> {
  if (!busy[commentId]) return busy as Record<string, true>
  const next = { ...busy }
  delete next[commentId]
  return next
}

function applyLike(
  comments: readonly MusicComment[],
  commentId: string,
  liked: boolean,
  likedCount: number,
): MusicComment[] {
  return comments.map((comment) => (
    comment.id === commentId ? { ...comment, liked, likedCount } : comment
  ))
}

export const useCommentsStore = create<CommentsState>((set, get) => ({
  activeTrackId: null,
  buckets: {},

  async load(trackId, options = {}) {
    const reset = options.reset === true
    const current = get().buckets[trackId]
    if (!reset && current && (current.status === 'loading' || current.status === 'ready')) {
      // Returning to a cached track still makes it the active one: a later page must be allowed to
      // commit, and an answer for the track just left must not.
      if (get().activeTrackId !== trackId) set({ activeTrackId: trackId })
      return
    }

    const generation = (current?.generation ?? 0) + 1
    set((state) => ({
      activeTrackId: trackId,
      buckets: {
        ...state.buckets,
        [trackId]: {
          ...emptyBucket(trackId, generation),
          status: 'loading',
        },
      },
    }))

    let page: MusicCommentPage
    try {
      page = await musicApi.comments(trackId, 0, COMMENTS_PAGE_SIZE)
    } catch (error) {
      const state = get()
      const bucket = state.buckets[trackId]
      if (bucket?.generation !== generation) return
      if (state.activeTrackId !== trackId) {
        set((latest) => ({
          buckets: { ...latest.buckets, [trackId]: { ...bucket, status: 'idle' } },
        }))
        return
      }
      set((latest) => ({
        buckets: {
          ...latest.buckets,
          [trackId]: { ...bucket, status: 'error', error: describe(error) },
        },
      }))
      return
    }

    const state = get()
    const bucket = state.buckets[trackId]
    if (bucket?.generation !== generation) return
    if (state.activeTrackId !== trackId) {
      // The reader changed track while this page was in flight: drop the answer, but leave the cache
      // open for a fresh first page if they come back.
      set((latest) => ({
        buckets: { ...latest.buckets, [trackId]: { ...bucket, status: 'idle' } },
      }))
      return
    }
    set((latest) => ({
      buckets: {
        ...latest.buckets,
        [trackId]: {
          ...bucket,
          hot: page.hot,
          latest: appendUnseen([], page.latest),
          total: page.total,
          hasMore: page.hasMore && page.latest.length > 0,
          status: 'ready',
          error: null,
        },
      },
    }))
  },

  async loadMore(trackId) {
    const bucket = get().buckets[trackId]
    if (!bucket || bucket.status !== 'ready' || !bucket.hasMore || bucket.loadingMore) return
    const generation = bucket.generation
    const offset = bucket.latest.length
    set((state) => ({
      buckets: {
        ...state.buckets,
        [trackId]: { ...state.buckets[trackId]!, loadingMore: true, loadMoreError: null },
      },
    }))

    let page: MusicCommentPage
    try {
      page = await musicApi.comments(trackId, offset, COMMENTS_PAGE_SIZE)
    } catch (error) {
      const state = get()
      const latest = state.buckets[trackId]
      if (latest?.generation !== generation) return
      if (state.activeTrackId !== trackId) {
        set((current) => ({
          buckets: {
            ...current.buckets,
            [trackId]: { ...latest, loadingMore: false, loadMoreError: null },
          },
        }))
        return
      }
      set((current) => ({
        buckets: {
          ...current.buckets,
          [trackId]: { ...latest, loadingMore: false, loadMoreError: describe(error) },
        },
      }))
      return
    }

    const state = get()
    const latest = state.buckets[trackId]
    if (latest?.generation !== generation) return
    if (state.activeTrackId !== trackId) {
      set((current) => ({
        buckets: {
          ...current.buckets,
          [trackId]: { ...latest, loadingMore: false, loadMoreError: null },
        },
      }))
      return
    }
    set((current) => ({
      buckets: {
        ...current.buckets,
        [trackId]: {
          ...latest,
          // A later page never replaces the hot page: only the first page has one.
          latest: appendUnseen(latest.latest, page.latest),
          total: page.total,
          hasMore: page.hasMore && page.latest.length > 0,
          loadingMore: false,
          loadMoreError: null,
        },
      },
    }))
  },

  async like(trackId, commentId, liked) {
    const bucket = get().buckets[trackId]
    if (!bucket) return { ok: false }
    if (bucket.likeBusy[commentId]) return { ok: false, busy: true }
    const target = [...bucket.hot, ...bucket.latest].find((comment) => comment.id === commentId)
    if (!target || target.liked === liked) return { ok: true }

    const previousCount = target.likedCount
    const nextCount = Math.max(0, previousCount + (liked ? 1 : -1))
    set((state) => {
      const current = state.buckets[trackId]
      if (!current) return state
      return {
        buckets: {
          ...state.buckets,
          [trackId]: {
            ...current,
            hot: applyLike(current.hot, commentId, liked, nextCount),
            latest: applyLike(current.latest, commentId, liked, nextCount),
            likeBusy: { ...current.likeBusy, [commentId]: true },
          },
        },
      }
    })

    try {
      await musicApi.likeComment(trackId, commentId, liked)
      set((state) => {
        const current = state.buckets[trackId]
        if (!current) return state
        return {
          buckets: {
            ...state.buckets,
            [trackId]: { ...current, likeBusy: withoutBusy(current.likeBusy, commentId) },
          },
        }
      })
      return { ok: true }
    } catch (error) {
      set((state) => {
        const current = state.buckets[trackId]
        if (!current) return state
        return {
          buckets: {
            ...state.buckets,
            [trackId]: {
              ...current,
              hot: applyLike(current.hot, commentId, target.liked, previousCount),
              latest: applyLike(current.latest, commentId, target.liked, previousCount),
              likeBusy: withoutBusy(current.likeBusy, commentId),
            },
          },
        }
      })
      return { ok: false, error }
    }
  },
}))

/** The count the Now Playing comments tab shows, or null until this track's first page has loaded. */
export function useCommentsCount(trackId: string | null | undefined): number | null {
  return useCommentsStore((state) => {
    if (!trackId) return null
    const bucket = state.buckets[trackId]
    return bucket?.status === 'ready' ? bucket.total : null
  })
}

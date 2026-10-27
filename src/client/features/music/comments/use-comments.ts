/**
 * The comments pane's view of one track: the cached bucket, the first-page load it needs on mount and
 * the two actions a row or the sentinel can trigger. The store does the sequencing; this hook only
 * ties it to the current track so the pane itself stays a rendering component.
 */
import { useCallback, useEffect } from 'react'
import type { MusicComment } from '@shared/music/comments'
import {
  useCommentsStore,
  type CommentLikeOutcome,
  type CommentsBucket,
} from './store'

const EMPTY_HOT: readonly MusicComment[] = []

export interface CommentsView {
  bucket: CommentsBucket | undefined
  loadMore: () => void
  retry: () => void
  retryMore: () => void
  like: (comment: MusicComment) => Promise<CommentLikeOutcome>
}

/** Load the first page of `trackId` unless it is already cached, and expose the actions on it. */
export function useComments(trackId: string | null | undefined): CommentsView {
  const bucket = useCommentsStore((state) => (trackId ? state.buckets[trackId] : undefined))
  const load = useCommentsStore((state) => state.load)
  const loadMore = useCommentsStore((state) => state.loadMore)
  const like = useCommentsStore((state) => state.like)

  useEffect(() => {
    if (!trackId) return
    void load(trackId)
  }, [trackId, load])

  const onLoadMore = useCallback(() => {
    if (trackId) void loadMore(trackId)
  }, [trackId, loadMore])

  const onRetry = useCallback(() => {
    if (trackId) void load(trackId, { reset: true })
  }, [trackId, load])

  const onRetryMore = useCallback(() => {
    if (trackId) void loadMore(trackId)
  }, [trackId, loadMore])

  const onLike = useCallback((comment: MusicComment) => {
    if (!trackId) return Promise.resolve({ ok: false })
    return like(trackId, comment.id, !comment.liked)
  }, [trackId, like])

  return { bucket, loadMore: onLoadMore, retry: onRetry, retryMore: onRetryMore, like: onLike }
}

/**
 * The hot page of a track, loading its first page when hot comments are enabled.
 *
 * This is the only prefetch in the comments slice: the quiet layer asks for it so a silent stretch
 * has a comment ready, and does nothing at all when the setting is off.
 */
export function useHotComments(
  trackId: string | null | undefined,
  enabled: boolean,
): readonly MusicComment[] {
  const hot = useCommentsStore((state) => (
    trackId ? state.buckets[trackId]?.hot ?? EMPTY_HOT : EMPTY_HOT
  ))
  const load = useCommentsStore((state) => state.load)

  useEffect(() => {
    if (!trackId || !enabled) return
    void load(trackId)
  }, [trackId, enabled, load])

  return hot
}

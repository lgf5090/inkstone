/**
 * The comments pane of Now Playing: the hot page, then the latest page the sentinel extends.
 *
 * The pane reads the track the player is showing and renders only what the comments store holds; the
 * store owns request sequencing, caching and the optimistic like. A row's press reports its outcome
 * here, because the two failures ask different things of the reader: an expired content account gets
 * a toast with the way to the login screen, while any other refusal keeps the rollback the store
 * already applied and says what happened.
 */
import { useCallback, useEffect, useMemo, useRef, type ReactElement } from 'react'
import { Heart } from 'lucide-react'
import type { MusicComment } from '@shared/music/comments'
import { ApiError } from '../../../lib/api'
import { cn } from '../../../lib/cn'
import { useEvent, useRelativeTime } from '../../../lib/hooks'
import { fullTime } from '../../../lib/time'
import { navigateToPath } from '../../../lib/app-history'
import { useUi } from '../../../store/ui'
import { Button } from '../../../components/primitives'
import { LoadingBlock } from '../../../components/feedback'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'
import { musicText } from '../components/labels'
import { RemoteAvatar } from '../pages/parts/P2MediaCard'
import { commentAvatarUrl } from './comment-display'
import { useComments } from './use-comments'
import './comments.css'

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Report a like the store rolled back, naming the one failure the reader can resolve themselves. */
function reportLikeFailure(error: unknown): void {
  if (error instanceof ApiError && error.isAuth) {
    useUi.getState().toast({
      title: musicText('music.login.not_connected'),
      tone: 'warning',
      action: {
        label: musicText('music.settings.account.connect'),
        run: () => navigateToPath('/music/login'),
      },
    })
    return
  }
  useUi.getState().toast({
    title: musicText('common.action_failed'),
    description: detailOf(error),
    tone: 'danger',
  })
}

function CommentRow({
  comment,
  busy,
  onLike,
}: {
  comment: MusicComment
  busy: boolean
  onLike: (comment: MusicComment) => void
}): ReactElement {
  const when = useRelativeTime(comment.createdAt)
  const avatar = commentAvatarUrl(comment.avatarUrl)
  const liked = comment.liked
  const likeLabel = musicText(liked ? 'music.comments.unlike' : 'music.comments.like', { name: comment.nickname })

  return (
    <article className="music-comments__row" data-comment-id={comment.id}>
      <RemoteAvatar src={avatar} name={comment.nickname} size={34} />
      <div className="music-comments__main">
        <div className="music-comments__meta">
          <span className="music-comments__author">{comment.nickname}</span>
          <time className="music-comments__time" dateTime={new Date(comment.createdAt).toISOString()} title={fullTime(comment.createdAt)}>
            {when}
          </time>
        </div>
        {comment.replyTo && (
          <p className="music-comments__reply">
            <span className="music-comments__reply-label">{musicText('music.comments.reply_to')} </span>
            <span className="music-comments__reply-author">{comment.replyTo.nickname}</span>
            <span aria-hidden="true">: </span>
            <span>{comment.replyTo.content}</span>
          </p>
        )}
        <p className="music-comments__content">{comment.content}</p>
        <div className="music-comments__footer">
          {comment.ipLocation && <span className="music-comments__ip">{comment.ipLocation}</span>}
          <button
            type="button"
            className={cn('music-comments__like', liked && 'music-comments__like--on')}
            aria-label={likeLabel}
            aria-pressed={liked}
            disabled={busy}
            onClick={() => onLike(comment)}
          >
            <Heart size={13} aria-hidden="true" fill={liked ? 'currentColor' : 'none'} />
            <span className="music-comments__likes">{comment.likedCount}</span>
          </button>
        </div>
      </div>
    </article>
  )
}

function CommentsError({ detail, onRetry }: { detail: string; onRetry: () => void }): ReactElement {
  return (
    <div role="alert" className="music-comments__error">
      <p className="music-comments__error-title">{musicText('common.action_failed')}</p>
      <p className="music-comments__error-detail">{detail}</p>
      <Button size="sm" variant="secondary" onClick={onRetry}>
        {musicText('common.retry')}
      </Button>
    </div>
  )
}

export function CommentsPane(): ReactElement {
  const track = useMusicPlayer(selectCurrentTrack)
  const trackId = track?.id
  const view = useComments(trackId)
  const bucket = view.bucket
  const hot = bucket?.hot ?? []
  const latest = useMemo(() => {
    if (!bucket) return []
    const seen = new Set(bucket.hot.map((comment) => comment.id))
    return bucket.latest.filter((comment) => !seen.has(comment.id))
  }, [bucket])

  const onLike = useCallback(async (comment: MusicComment) => {
    const outcome = await view.like(comment)
    if (!outcome.ok && !outcome.busy) reportLikeFailure(outcome.error)
  }, [view])

  const sentinelRef = useRef<HTMLDivElement>(null)
  const loadMore = useEvent(view.loadMore)
  const hasMore = bucket?.hasMore === true
  const loadingMore = bucket?.loadingMore === true
  const moreError = bucket?.loadMoreError ?? null
  useEffect(() => {
    if (!hasMore || loadingMore || moreError) return
    const node = sentinelRef.current
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore()
    }, { rootMargin: '160px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, loadingMore, moreError, loadMore])

  if (!track) {
    return (
      <div className="music-np__pane-body music-np__empty">
        <p className="music-np__empty-title">{musicText('music.nowplaying.empty')}</p>
      </div>
    )
  }

  const firstLoad = !bucket || bucket.status === 'idle' || bucket.status === 'loading'
  const failed = bucket?.status === 'error'

  return (
    <div className="music-np__pane-body music-comments">
      <header className="music-comments__header">
        <h2 className="music-comments__title">{musicText('music.comments.title')}</h2>
        {bucket?.status === 'ready' && bucket.total > 0 && (
          <span className="music-comments__total">{bucket.total}</span>
        )}
      </header>

      {firstLoad && <LoadingBlock label={musicText('common.loading')} />}

      {failed && (
        <CommentsError detail={bucket?.error ?? ''} onRetry={view.retry} />
      )}

      {bucket?.status === 'ready' && (
        <>
          {hot.length === 0 && latest.length === 0 && (
            <div className="music-comments__empty">
              <p className="music-comments__empty-title">{musicText('music.comments.empty')}</p>
              <p className="music-comments__empty-hint">{musicText('music.comments.empty_hint')}</p>
            </div>
          )}

          {hot.length > 0 && (
            <section className="music-comments__section" aria-label={musicText('music.comments.hot_section')}>
              <h3 className="music-comments__section-title">{musicText('music.comments.hot_section')}</h3>
              {hot.map((comment) => (
                <CommentRow
                  key={comment.id}
                  comment={comment}
                  busy={bucket.likeBusy[comment.id] === true}
                  onLike={onLike}
                />
              ))}
            </section>
          )}

          {latest.length > 0 && (
            <section className="music-comments__section" aria-label={musicText('music.comments.latest')}>
              <h3 className="music-comments__section-title">{musicText('music.comments.latest')}</h3>
              {latest.map((comment) => (
                <CommentRow
                  key={comment.id}
                  comment={comment}
                  busy={bucket.likeBusy[comment.id] === true}
                  onLike={onLike}
                />
              ))}
            </section>
          )}

          {hasMore && (
            <footer className="music-comments__more">
              <div ref={sentinelRef} className="music-comments__sentinel" data-testid="comments-sentinel" />
              {moreError ? (
                <div role="alert" className="music-comments__more-error">
                  <p>{moreError}</p>
                  <Button size="sm" variant="secondary" onClick={view.retryMore}>
                    {musicText('common.retry')}
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={loadingMore}
                  disabled={loadingMore}
                  onClick={view.loadMore}
                >
                  {loadingMore ? musicText('music.comments.loading_more') : musicText('music.pager.load_more')}
                </Button>
              )}
            </footer>
          )}

          {!hasMore && (hot.length > 0 || latest.length > 0) && (
            <p className="music-comments__no-more">{musicText('music.comments.no_more')}</p>
          )}
        </>
      )}
    </div>
  )
}

/**
 * The comment thread under a video.
 *
 * Pages are appended by `nextPageToken`, deduplicated by comment id, and fenced by a generation
 * counter plus an `AbortController`: a response that belongs to a video the reader has already left
 * is dropped instead of painted under the new one. A video's comments can also be turned off, so a
 * failed load is a row in the thread — it never blocks the video itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageCircle, ThumbsUp } from 'lucide-react'
import type { YouTubeComment } from '@shared/youtube/model'
import { formatCount, formatPublished } from '@shared/youtube/model'
import { getLocale, t } from '../../../lib/i18n'
import { Button, Spinner } from '../../../components/primitives'
import { fetchComments } from '../api'
import { renderCommentBody } from './comment-html'

type LoadStatus = 'loading' | 'ready' | 'error'

export function CommentList({
  videoId,
  commentCount,
}: {
  videoId: string
  commentCount: number
}) {
  const [comments, setComments] = useState<YouTubeComment[]>([])
  const [nextToken, setNextToken] = useState<string | null>(null)
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [failedToken, setFailedToken] = useState<string | null>(null)
  const generationRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(
    async (token: string | null, generation: number, signal: AbortSignal) => {
      setStatus('loading')
      setError(null)
      try {
        const page = await fetchComments(videoId, token ?? undefined, signal)
        if (generation !== generationRef.current || signal.aborted) return

        setComments((previous) => {
          const base = token === null ? [] : previous
          const seen = new Set(base.map((comment) => comment.id))
          const additions: YouTubeComment[] = []
          for (const comment of page.items ?? []) {
            if (!comment?.id || seen.has(comment.id)) continue
            seen.add(comment.id)
            additions.push(comment)
          }
          return [...base, ...additions]
        })
        setNextToken(page.nextPageToken ?? null)
        setStatus('ready')
      } catch (cause) {
        if (generation !== generationRef.current || signal.aborted) return
        setFailedToken(token)
        setError(messageOf(cause))
        setStatus('error')
      }
    },
    [videoId],
  )

  const request = useCallback(
    (token: string | null) => {
      const generation = ++generationRef.current
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      if (token === null) {
        setComments([])
        setNextToken(null)
      }
      void load(token, generation, controller.signal)
    },
    [load],
  )

  useEffect(() => {
    request(null)
    return () => {
      generationRef.current++
      abortRef.current?.abort()
    }
  }, [request])

  const locale = getLocale()
  const total = Number.isFinite(commentCount) && commentCount > 0 ? commentCount : 0

  return (
    <section aria-label={t('youtube.detail.comments_title')}>
      <div className="mb-[var(--sp-3)] flex flex-wrap items-center gap-[var(--sp-2)]">
        <MessageCircle size={15} aria-hidden="true" className="text-[var(--text-tertiary)]" />
        <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('youtube.detail.comments_title')}
        </h3>
        {total > 0 && (
          <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            {t('youtube.detail.comments_count', { count: formatCount(total) })}
          </span>
        )}
      </div>

      {comments.length > 0 && (
        <div className="flex flex-col gap-[var(--sp-3)]">
          {comments.map((comment) => (
            <CommentRow key={comment.id} comment={comment} locale={locale} />
          ))}
        </div>
      )}

      {status === 'loading' && <LoadingRow />}

      {status === 'error' && (
        <ErrorRow detail={error} onRetry={() => request(failedToken)} />
      )}

      {status === 'ready' && comments.length === 0 && (
        <p className="rounded-[var(--r-md)] border border-dashed border-[var(--border-subtle)] p-[var(--sp-4)] text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('youtube.detail.comments_empty')}
        </p>
      )}

      {status === 'ready' && nextToken && comments.length > 0 && (
        <div className="mt-[var(--sp-3)] flex justify-center">
          <Button size="sm" variant="secondary" onClick={() => request(nextToken)}>
            {t('youtube.detail.load_more_comments')}
          </Button>
        </div>
      )}
    </section>
  )
}

function CommentRow({ comment, locale }: { comment: YouTubeComment; locale: string }) {
  const [avatarFailed, setAvatarFailed] = useState(false)
  const author = comment.authorDisplayName?.trim() || ''
  const initial = (author || '?').slice(0, 1).toUpperCase()
  const avatarUrl = comment.authorProfileImageUrl?.trim() || ''
  const published = formatPublished(comment.publishedAt, locale)
  const body = renderCommentBody(comment)
  const original =
    typeof comment.textOriginal === 'string' && comment.textOriginal.trim()
      ? comment.textOriginal
      : ''
  const likes = Number.isFinite(comment.likeCount) && comment.likeCount > 0 ? comment.likeCount : 0
  const replies =
    Number.isFinite(comment.replyCount) && comment.replyCount > 0 ? comment.replyCount : 0

  return (
    <article className="flex gap-[var(--sp-3)] border-b border-[var(--border-subtle)] pb-[var(--sp-3)] last:border-b-0 last:pb-0">
      {avatarUrl && !avatarFailed ? (
        <img
          src={avatarUrl}
          alt=""
          width={32}
          height={32}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setAvatarFailed(true)}
          className="size-8 shrink-0 rounded-[var(--r-full)] bg-[var(--bg-raised)] object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-[var(--r-full)] bg-[var(--bg-raised)] text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] ring-1 ring-[var(--border-subtle)]"
        >
          {initial}
        </span>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-[var(--sp-2)]">
          {author && (
            <span className="truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
              {author}
            </span>
          )}
          {published && (
            <time
              dateTime={comment.publishedAt}
              className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]"
            >
              {published}
            </time>
          )}
        </div>

        {body ? (
          // `body.html` is the allowlisted, link-hardened output of `sanitizeCommentHtml`.
          <div
            className="mt-[var(--sp-1)] text-[length:var(--text-12)] leading-relaxed break-words text-[var(--text-secondary)] [&_a]:text-[var(--accent)] [&_a]:underline"
            dangerouslySetInnerHTML={{ __html: body.html }}
          />
        ) : original ? (
          <p className="mt-[var(--sp-1)] whitespace-pre-wrap text-[length:var(--text-12)] leading-relaxed break-words text-[var(--text-secondary)]">
            {original}
          </p>
        ) : null}

        <div className="mt-[var(--sp-1)] flex flex-wrap items-center gap-[var(--sp-3)] text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          <span className="inline-flex items-center gap-[var(--sp-1)]">
            <ThumbsUp size={11} aria-hidden="true" />
            {t('youtube.detail.comment_likes', { count: formatCount(likes) })}
          </span>
          {replies > 0 && (
            <span className="inline-flex items-center gap-[var(--sp-1)]">
              <MessageCircle size={11} aria-hidden="true" />
              {t('youtube.detail.comment_replies', { count: formatCount(replies) })}
            </span>
          )}
        </div>
      </div>
    </article>
  )
}

function LoadingRow() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mt-[var(--sp-3)] flex items-center justify-center gap-[var(--sp-2)] py-[var(--sp-2)] text-[length:var(--text-11)] text-[var(--text-quaternary)]"
    >
      <Spinner size={13} />
      {t('common.loading')}
    </div>
  )
}

function ErrorRow({ detail, onRetry }: { detail: string | null; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="mt-[var(--sp-3)] flex flex-col items-center gap-[var(--sp-2)] rounded-[var(--r-md)] border border-dashed border-[var(--border-subtle)] p-[var(--sp-4)] text-center"
    >
      <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
        {t('youtube.detail.comments_error')}
      </p>
      {detail && (
        <p className="max-w-prose text-[length:var(--text-11)] break-words text-[var(--text-quaternary)]">
          {detail}
        </p>
      )}
      <Button size="sm" variant="secondary" onClick={onRetry}>
        {t('youtube.retry')}
      </Button>
    </div>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

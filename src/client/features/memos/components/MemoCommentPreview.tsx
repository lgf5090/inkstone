import { useEffect, useRef, useState, type MouseEvent, type ReactElement } from 'react'
import { MEMOS_APP_PATH } from '@shared/memos/constants'
import type { Memo } from '@shared/memos/types'
import { Button } from '../../../components/primitives'
import { t } from '../../../lib/i18n'
import { memosApi } from '../api'

const PREVIEW_LIMIT = 3

export interface MemoCommentPreviewProps {
  memoId: string
  commentCount: number
  onOpen?: (id: string) => void
}

interface PreviewResult {
  memoId: string
  commentCount: number
  status: 'loading' | 'ready' | 'error'
  items: Memo[]
}

function commentText(comment: Memo): string {
  return (comment.snippet || comment.content).replace(/\s+/g, ' ').trim()
}

/**
 * The latest comments under a card. The request waits until the card is near the viewport, so a feed
 * with hundreds of commented memos does not fetch every preview at once.
 */
export function MemoCommentPreview({
  memoId,
  commentCount,
  onOpen,
}: MemoCommentPreviewProps): ReactElement | null {
  const hostRef = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')
  const [retry, setRetry] = useState(0)
  const [result, setResult] = useState<PreviewResult | null>(null)
  const enabled = commentCount > 0

  useEffect(() => {
    if (!enabled || near) return
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return
    }
    const node = hostRef.current
    if (!node) return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setNear(true)
      observer.disconnect()
    }, { rootMargin: '200px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [enabled, near])

  useEffect(() => {
    if (!enabled || !near) return
    const controller = new AbortController()
    setResult({ memoId, commentCount, status: 'loading', items: [] })
    memosApi.comments.list(memoId, { limit: PREVIEW_LIMIT }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return
        setResult({ memoId, commentCount, status: 'ready', items: page.items.slice(0, PREVIEW_LIMIT) })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        // The card keeps working; the preview reports its own failure with a retry.
        console.warn('[inkstone] Memo comment preview failed', error)
        setResult({ memoId, commentCount, status: 'error', items: [] })
      })
    return () => controller.abort()
  }, [enabled, near, memoId, commentCount, retry])

  if (!enabled) return null

  const href = `${MEMOS_APP_PATH}/m/${encodeURIComponent(memoId)}#memos-comments`
  const current = result?.memoId === memoId && result.commentCount === commentCount ? result : null
  const onLinkClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (!onOpen || event.defaultPrevented || event.button !== 0
      || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onOpen(memoId)
  }

  return (
    <div
      ref={hostRef}
      data-memo-comments-preview={memoId}
      className="mt-2 border-t border-[var(--border-subtle)] pt-1.5"
    >
      {current === null || current.status === 'loading' ? (
        <div
          data-memo-comments-preview-loading=""
          aria-hidden="true"
          className="h-3.5 w-2/3 animate-pulse rounded-[var(--r-xs)] bg-[var(--bg-inset)]"
        />
      ) : current.status === 'error' ? (
        <div className="flex min-h-6 flex-wrap items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          <span role="alert">{t('memos.card.comments_preview_failed')}</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[length:var(--text-11)]"
            onClick={() => setRetry((value) => value + 1)}
          >
            {t('memos.common.retry')}
          </Button>
        </div>
      ) : current.items.length === 0 ? null : (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[length:var(--text-10-5)] font-semibold tracking-[0.06em] uppercase text-[var(--text-quaternary)]">
              {t('memos.card.comments_preview_title')}
            </span>
            <a
              href={href}
              onClick={onLinkClick}
              className="shrink-0 rounded-[var(--r-xs)] text-[length:var(--text-11)] text-[var(--accent)] transition-colors hover:text-[var(--accent-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            >
              {t('memos.card.comments_preview_view_all')}
            </a>
          </div>
          <ul className="mt-1 space-y-0.5">
            {current.items.map((comment) => (
              <li key={comment.id}>
                <a
                  href={href}
                  onClick={onLinkClick}
                  className="block rounded-[var(--r-xs)] px-1 py-0.5 line-clamp-2 break-words text-[length:var(--text-11)] leading-snug text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                >
                  {commentText(comment)}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

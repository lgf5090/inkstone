import { useCallback, useState, type ReactElement } from 'react'
import { CornerDownRight } from 'lucide-react'
import { MEMOS_APP_PATH } from '@shared/memos/constants'
import type { Memo } from '@shared/memos/types'
import { Button } from '../../../components/primitives'
import { Empty, Skeleton } from '../../../components/feedback'
import { t } from '../../../lib/i18n'
import { shortTime } from '../../../lib/time'
import { memosApi } from '../api'
import { memoErrorMessage, memoIsAbortError } from '../errors'
import { useRevision } from '../events'
import { useMemoResource } from '../use-resource'
import { navigateMemoUrl } from '../url-state'
import { MemoBody } from '../components/MemoBody'

const INBOX_PAGE = 16

export function MemoInboxPage(): ReactElement {
  const revision = useRevision('list')
  const [more, setMore] = useState<Memo[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)
  const resource = useMemoResource(
    (signal) => memosApi.list({ commentsOnly: true, limit: INBOX_PAGE, orderBy: 'created', order: 'desc' }, signal),
    [revision],
  )
  const items = [...(resource.data?.items ?? []), ...more]
  const nextCursor = cursor ?? resource.data?.nextCursor ?? null

  const loadMore = useCallback(async (): Promise<void> => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await memosApi.list({
        commentsOnly: true,
        limit: INBOX_PAGE,
        orderBy: 'created',
        order: 'desc',
        cursor: nextCursor,
      })
      setMore((current) => [...current, ...page.items])
      setCursor(page.nextCursor)
    } catch (error) {
      if (memoIsAbortError(error)) return
      setMoreError(memoErrorMessage(error))
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, nextCursor])

  const loading = resource.status === 'loading' && resource.data === null
  const failed = resource.status === 'error' && resource.data === null

  return (
    <div className="h-full min-h-0 overflow-y-auto" data-memos-inbox="">
      <div className="mx-auto w-full max-w-[var(--memo-page-width)] px-3 py-3 md:px-5 md:py-4">
        <h2 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">
          {t('memos.nav.inbox')}
        </h2>
        <p className="mt-0.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
          {t('memos.inbox.description')}
        </p>
        {loading ? (
          <div className="mt-3 space-y-2">
            <Skeleton className="h-20 rounded-[var(--r-lg)]" />
            <Skeleton className="h-20 rounded-[var(--r-lg)]" />
          </div>
        ) : null}
        {failed ? (
          <Empty
            art="notes"
            title={t('memos.inbox.error')}
            description={resource.error ?? t('memos.feed.error_description')}
            action={<Button size="sm" onClick={resource.reload}>{t('memos.common.retry')}</Button>}
          />
        ) : null}
        {resource.status === 'ready' && items.length === 0 ? (
          <Empty
            art="archive"
            title={t('memos.inbox.empty_title')}
            description={t('memos.inbox.empty_description')}
            action={(
              <Button size="sm" onClick={() => navigateMemoUrl(MEMOS_APP_PATH, '')}>
                {t('memos.inbox.go_to_memos')}
              </Button>
            )}
          />
        ) : null}
        {items.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {items.map((comment) => (
              <li
                key={comment.id}
                className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 shadow-sm"
              >
                <header className="flex items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  <CornerDownRight size={12} aria-hidden="true" />
                  <time dateTime={new Date(comment.createdAt * 1000).toISOString()}>
                    {shortTime(comment.createdAt * 1000)}
                  </time>
                </header>
                <MemoBody content={comment.content} className="mt-2 text-[length:var(--text-12-5)]" />
                {comment.parentId ? (
                  <a
                    href={`${MEMOS_APP_PATH}/m/${encodeURIComponent(comment.parentId)}`}
                    className="mt-2 inline-flex min-h-8 items-center text-[length:var(--text-11-5)] font-medium text-[var(--accent)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                  >
                    {t('memos.inbox.open_parent')}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {nextCursor ? (
          <div className="mt-3 flex justify-center">
            <Button size="sm" variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? t('memos.inbox.loading_more') : t('memos.inbox.load_more')}
            </Button>
          </div>
        ) : null}
        {moreError ? (
          <p role="alert" className="mt-2 text-[length:var(--text-11-5)] text-[var(--danger)]">{moreError}</p>
        ) : null}
      </div>
    </div>
  )
}

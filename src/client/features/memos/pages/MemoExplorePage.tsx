import { useEffect, useRef, useState, type ReactElement } from 'react'
import { MEMOS_APP_PATH } from '@shared/memos/constants'
import type { Memo, MemoListResponse } from '@shared/memos/types'
import { Button } from '../../../components/primitives'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { t } from '../../../lib/i18n'
import { memosApi } from '../api'
import { MemoPublicCard } from '../components/MemoPublicCard'
import { memoErrorMessage, memoIsAbortError } from '../errors'

interface ExploreState {
  items: Memo[]
  cursor: string | null
  status: 'loading' | 'ready' | 'error'
  error: string | null
}

export function MemoExplorePage(): ReactElement {
  const [ticket, setTicket] = useState(0)
  const [state, setState] = useState<ExploreState>({ items: [], cursor: null, status: 'loading', error: null })
  const [moreStatus, setMoreStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [moreError, setMoreError] = useState<string | null>(null)
  const moreController = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setState({ items: [], cursor: null, status: 'loading', error: null })
    setMoreStatus('idle')
    setMoreError(null)
    memosApi.publicMemos.explore({}, controller.signal)
      .then((page: MemoListResponse) => {
        if (controller.signal.aborted) return
        setState({ items: page.items, cursor: page.nextCursor, status: 'ready', error: null })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || memoIsAbortError(error)) return
        setState({ items: [], cursor: null, status: 'error', error: memoErrorMessage(error) })
      })
    return () => controller.abort()
  }, [ticket])

  useEffect(() => () => {
    moreController.current?.abort()
  }, [])

  const loadMore = (): void => {
    if (!state.cursor || moreStatus === 'loading') return
    moreController.current?.abort()
    const controller = new AbortController()
    moreController.current = controller
    setMoreStatus('loading')
    setMoreError(null)
    memosApi.publicMemos.explore({ cursor: state.cursor }, controller.signal)
      .then((page: MemoListResponse) => {
        if (controller.signal.aborted) return
        setState((current) => ({
          ...current,
          items: [...current.items, ...page.items],
          cursor: page.nextCursor,
        }))
        setMoreStatus('idle')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || memoIsAbortError(error)) return
        setMoreStatus('error')
        setMoreError(memoErrorMessage(error))
      })
  }

  let body: ReactElement
  if (state.status === 'loading') {
    body = <LoadingBlock label={t('memos.common.loading')} />
  } else if (state.status === 'error') {
    body = (
      <Empty
        art="search"
        title={t('memos.public.error_title')}
        description={state.error ?? t('memos.public.error_description')}
        action={(
          <Button size="sm" onClick={() => setTicket((value) => value + 1)}>
            {t('memos.common.retry')}
          </Button>
        )}
      />
    )
  } else if (state.items.length === 0) {
    body = (
      <Empty
        art="notes"
        title={t('memos.public.empty_title')}
        description={t('memos.public.empty_description')}
      />
    )
  } else {
    body = (
      <>
        <div className="mt-4 space-y-3">
          {state.items.map((memo) => {
            const username = memo.creator?.username
            return (
              <MemoPublicCard
                key={memo.id}
                memo={memo}
                href={username
                  ? `${MEMOS_APP_PATH}/u/${encodeURIComponent(username)}/m/${encodeURIComponent(memo.id)}`
                  : undefined}
              />
            )
          })}
        </div>
        {state.cursor ? (
          <div className="mt-4 flex flex-col items-center gap-2">
            {moreStatus === 'error' ? (
              <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">
                {moreError ?? t('memos.public.error_description')}
              </p>
            ) : null}
            <Button size="sm" variant="secondary" loading={moreStatus === 'loading'} onClick={loadMore}>
              {moreStatus === 'loading' ? t('memos.public.loading_more') : t('memos.public.load_more')}
            </Button>
          </div>
        ) : null}
      </>
    )
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto" data-memos-explore="">
      <div className="mx-auto w-full max-w-[var(--memo-reading-width)] px-4 py-4 md:px-5 md:py-5">
        <h2 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">
          {t('memos.public.explore_title')}
        </h2>
        <p className="mt-1 text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">
          {t('memos.public.explore_description')}
        </p>
        {body}
      </div>
    </div>
  )
}

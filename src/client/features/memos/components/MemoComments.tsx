import { useEffect, useRef, useState, type ReactElement } from 'react'
import { MEMO_COMMENT_PAGE_SIZE } from '@shared/memos/constants'
import type { Memo } from '@shared/memos/types'
import { Button } from '../../../components/primitives'
import { Textarea } from '../../../components/form'
import { Skeleton } from '../../../components/feedback'
import { t } from '../../../lib/i18n'
import { shortTime } from '../../../lib/time'
import { useUi } from '../../../store/ui'
import { memosApi } from '../api'
import { memoErrorMessage, memoIsAbortError } from '../errors'
import { bump } from '../events'
import { MemoBody } from './MemoBody'

interface CommentsState {
  items: Memo[]
  nextCursor: string | null
  status: 'loading' | 'ready' | 'error'
  error: string | null
}

export interface MemoCommentsProps {
  memoId: string
  initialCount: number
  disabled?: boolean
  onTagPress?: (tag: string) => void
}

export function MemoComments({ memoId, initialCount, disabled = false, onTagPress }: MemoCommentsProps): ReactElement {
  const [state, setState] = useState<CommentsState>({
    items: [],
    nextCursor: null,
    status: 'loading',
    error: null,
  })
  const [text, setText] = useState('')
  const [posting, setPosting] = useState(false)
  const [added, setAdded] = useState(0)
  const [reloadTicket, setReloadTicket] = useState(0)
  const controllerRef = useRef<AbortController | null>(null)
  const total = Math.max(initialCount + added, state.items.length)

  useEffect(() => {
    setAdded(0)
    setState({ items: [], nextCursor: null, status: 'loading', error: null })
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    memosApi.comments.list(memoId, { limit: MEMO_COMMENT_PAGE_SIZE }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return
        setState({ items: page.items, nextCursor: page.nextCursor, status: 'ready', error: null })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || memoIsAbortError(error)) return
        setState({ items: [], nextCursor: null, status: 'error', error: memoErrorMessage(error) })
      })
    return () => controller.abort()
  }, [memoId, reloadTicket])

  const loadMore = async (): Promise<void> => {
    if (!state.nextCursor) return
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const page = await memosApi.comments.list(
        memoId,
        { cursor: state.nextCursor, limit: MEMO_COMMENT_PAGE_SIZE },
        controller.signal,
      )
      if (controller.signal.aborted) return
      setState((current) => ({
        items: [...current.items, ...page.items.filter((item) => !current.items.some((known) => known.id === item.id))],
        nextCursor: page.nextCursor,
        status: 'ready',
        error: null,
      }))
    } catch (error) {
      if (controller.signal.aborted || memoIsAbortError(error)) return
      setState((current) => ({ ...current, status: 'error', error: memoErrorMessage(error) }))
    }
  }

  const submit = async (): Promise<void> => {
    const content = text.trim()
    if (!content || posting || disabled) return
    setPosting(true)
    try {
      const comment = await memosApi.comments.create(memoId, { content })
      setState((current) => ({ ...current, items: [...current.items, comment] }))
      setAdded((value) => value + 1)
      setText('')
      bump('list')
    } catch (error) {
      useUi.getState().toast({
        title: t('memos.comments.failed'),
        description: memoErrorMessage(error),
        tone: 'danger',
      })
    } finally {
      setPosting(false)
    }
  }

  const countLabel = t(total === 1 ? 'memos.comments.count_one' : 'memos.comments.count', { count: total })

  return (
    <section id="memos-comments" className="border-t border-[var(--border-subtle)] pt-3">
      <div className="flex items-center gap-2">
        <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('memos.comments.heading')}
        </h3>
        <span className="text-[length:var(--text-11)] tabular text-[var(--text-quaternary)]">{countLabel}</span>
      </div>
      {state.status === 'loading' && state.items.length === 0 ? (
        <div className="mt-2 space-y-1.5">
          <Skeleton className="h-12" />
          <Skeleton className="h-12 w-5/6" />
        </div>
      ) : null}
      {state.status === 'error' && state.items.length === 0 ? (
        <div className="mt-2">
          <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
            {state.error ?? t('memos.comments.error')}
          </p>
          <Button size="sm" variant="ghost" className="mt-1 h-7 px-1.5" onClick={() => setReloadTicket((value) => value + 1)}>
            {t('memos.common.retry')}
          </Button>
        </div>
      ) : null}
      {state.status === 'ready' && state.items.length === 0 ? (
        <p className="mt-2 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('memos.comments.empty')}</p>
      ) : null}
      {state.items.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {state.items.map((comment) => (
            <li key={comment.id} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2.5">
              <time
                dateTime={new Date(comment.createdAt * 1000).toISOString()}
                className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]"
              >
                {shortTime(comment.createdAt * 1000)}
              </time>
              <MemoBody content={comment.content} onTagPress={onTagPress} className="mt-1 text-[length:var(--text-12)]" />
            </li>
          ))}
        </ul>
      ) : null}
      {state.nextCursor ? (
        <Button size="sm" variant="ghost" className="mt-2 h-7 px-1.5" onClick={() => void loadMore()}>
          {t('memos.comments.load_more')}
        </Button>
      ) : null}
      {state.status === 'error' && state.items.length > 0 ? (
        <p role="alert" className="mt-2 text-[length:var(--text-11-5)] text-[var(--danger)]">
          {state.error ?? t('memos.comments.error')}
        </p>
      ) : null}
      {disabled ? (
        <p className="mt-3 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('memos.comments.disabled')}</p>
      ) : (
        <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <Textarea
            aria-label={t('memos.comments.placeholder')}
            placeholder={t('memos.comments.placeholder')}
            rows={2}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="mt-1.5 flex justify-end">
            <Button type="submit" size="sm" variant="primary" loading={posting} disabled={!text.trim()}>
              {posting ? t('memos.comments.submitting') : t('memos.comments.submit')}
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}

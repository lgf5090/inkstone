import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { MEMO_COMMENT_PAGE_SIZE } from '@shared/memos/constants'
import type { Memo } from '@shared/memos/types'
import { Button, IconButton, Spinner } from '../../../components/primitives'
import { Textarea } from '../../../components/form'
import { Skeleton } from '../../../components/feedback'
import { confirm } from '../../../components/overlay'
import { ApiError } from '../../../lib/api'
import { t } from '../../../lib/i18n'
import { isImeComposing } from '../../../lib/ime'
import { shortTime } from '../../../lib/time'
import { useSession } from '../../../store/session'
import { memosApi } from '../api'
import { memoErrorMessage, memoIsAbortError } from '../errors'
import { bump } from '../events'
import { loadMemoDraft } from '../state'
import { useMemoDraft } from '../use-memo-draft'
import { MemoBody } from './MemoBody'

interface CommentsState {
  items: Memo[]
  nextCursor: string | null
  status: 'loading' | 'ready' | 'error'
  error: string | null
  loadingMore: boolean
}

export interface MemoCommentsProps {
  memoId: string
  initialCount: number
  disabled?: boolean
  onTagPress?: (tag: string) => void
}

export function memoCommentDraftScope(memoId: string): string {
  return `comment:${memoId}`
}

function submitOnModEnter(event: KeyboardEvent<HTMLTextAreaElement>, submit: () => void): void {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || isImeComposing(event)) return
  if (!event.metaKey && !event.ctrlKey) return
  event.preventDefault()
  submit()
}

function commentIsOwn(comment: Memo, userId: string): boolean {
  return !comment.creator || comment.creator.id === userId
}

export function MemoComments(props: MemoCommentsProps): ReactElement {
  return <MemoCommentsThread key={props.memoId} {...props} />
}

function MemoCommentsThread({
  memoId,
  initialCount,
  disabled = false,
  onTagPress,
}: MemoCommentsProps): ReactElement {
  const userId = useSession((state) => state.user?.id ?? 'guest')
  const scope = memoCommentDraftScope(memoId)
  const [state, setState] = useState<CommentsState>({
    items: [],
    nextCursor: null,
    status: 'loading',
    error: null,
    loadingMore: false,
  })
  const [text, setText] = useState(() => (disabled ? '' : loadMemoDraft(userId, scope)?.content ?? ''))
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [added, setAdded] = useState(0)
  const [reloadTicket, setReloadTicket] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const { clearDraft } = useMemoDraft({
    userId,
    scope,
    enabled: !disabled,
    value: text,
  })
  const total = Math.max(initialCount + added, state.items.length)

  useEffect(() => {
    setAdded(0)
    setPostError(null)
    setActionError(null)
    setState({ items: [], nextCursor: null, status: 'loading', error: null, loadingMore: false })
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    memosApi.comments.list(memoId, { limit: MEMO_COMMENT_PAGE_SIZE }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return
        setState({ items: page.items, nextCursor: page.nextCursor, status: 'ready', error: null, loadingMore: false })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || memoIsAbortError(error)) return
        setState({ items: [], nextCursor: null, status: 'error', error: memoErrorMessage(error), loadingMore: false })
      })
    return () => controller.abort()
  }, [memoId, reloadTicket])

  const loadMore = async (): Promise<void> => {
    if (!state.nextCursor || state.loadingMore) return
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setState((current) => ({ ...current, loadingMore: true, error: null }))
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
        loadingMore: false,
      }))
    } catch (error) {
      if (controller.signal.aborted || memoIsAbortError(error)) return
      setState((current) => ({
        ...current,
        status: 'error',
        error: memoErrorMessage(error),
        loadingMore: false,
      }))
    }
  }

  const submit = async (): Promise<void> => {
    const content = text.trim()
    if (!content || posting || disabled) return
    setPosting(true)
    setPostError(null)
    try {
      const comment = await memosApi.comments.create(memoId, { content })
      setState((current) => ({ ...current, items: [...current.items, comment] }))
      setAdded((value) => value + 1)
      clearDraft()
      setText('')
      bump('list')
    } catch (error) {
      setPostError(memoErrorMessage(error))
    } finally {
      setPosting(false)
    }
  }

  const startEdit = (comment: Memo): void => {
    setEditingId(comment.id)
    setEditingText(comment.content)
    setEditError(null)
    setActionError(null)
  }

  const cancelEdit = (): void => {
    setEditingId(null)
    setEditingText('')
    setEditError(null)
  }

  const saveEdit = async (comment: Memo): Promise<void> => {
    const content = editingText.trim()
    if (!content || savingEdit || disabled) return
    setSavingEdit(true)
    setEditError(null)
    try {
      const saved = await memosApi.patch(comment.id, { rev: comment.rev, content })
      setState((current) => ({
        ...current,
        items: current.items.map((item) => (item.id === comment.id ? saved : item)),
      }))
      setEditingId(null)
      setEditingText('')
      bump('list')
    } catch (error) {
      setEditError(error instanceof ApiError && error.isConflict
        ? t('memos.comments.conflict')
        : memoErrorMessage(error))
    } finally {
      setSavingEdit(false)
    }
  }

  const removeComment = async (comment: Memo): Promise<void> => {
    if (deletingId || disabled) return
    const accepted = await confirm({
      title: t('memos.comments.delete_title'),
      description: t('memos.comments.delete_description'),
      confirmLabel: t('memos.comments.delete_confirm'),
      tone: 'danger',
    })
    if (!accepted) return
    setDeletingId(comment.id)
    setActionError(null)
    try {
      await memosApi.remove(comment.id)
      setState((current) => ({
        ...current,
        items: current.items.filter((item) => item.id !== comment.id),
      }))
      setAdded((value) => value - 1)
      if (editingId === comment.id) cancelEdit()
      bump('list')
    } catch (error) {
      setActionError(memoErrorMessage(error))
    } finally {
      setDeletingId(null)
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
          {state.items.map((comment) => {
            const canManage = !disabled && commentIsOwn(comment, userId)
            const busy = savingEdit || deletingId === comment.id
            return (
              <li key={comment.id} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2.5">
                <div className="flex items-center gap-2">
                  <time
                    dateTime={new Date(comment.createdAt * 1000).toISOString()}
                    className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]"
                  >
                    {shortTime(comment.createdAt * 1000)}
                  </time>
                  {canManage ? (
                    <div className="ml-auto flex shrink-0 items-center gap-0.5">
                      <IconButton
                        label={t('memos.comments.edit')}
                        size="xs"
                        disabled={busy}
                        onClick={() => startEdit(comment)}
                      >
                        <Pencil size={12} />
                      </IconButton>
                      <IconButton
                        label={t('memos.comments.delete')}
                        size="xs"
                        disabled={busy}
                        onClick={() => void removeComment(comment)}
                      >
                        {deletingId === comment.id ? <Spinner size={12} /> : <Trash2 size={12} />}
                      </IconButton>
                    </div>
                  ) : null}
                </div>
                {editingId === comment.id ? (
                  <form
                    className="mt-1"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void saveEdit(comment)
                    }}
                  >
                    <Textarea
                      aria-label={t('memos.comments.edit_label')}
                      value={editingText}
                      rows={2}
                      autoFocus
                      onChange={(event) => setEditingText(event.target.value)}
                      onKeyDown={(event) => submitOnModEnter(event, () => void saveEdit(comment))}
                    />
                    <div className="mt-1.5 flex flex-wrap items-center justify-end gap-1.5">
                      <Button size="sm" variant="ghost" onClick={cancelEdit}>
                        {t('memos.common.cancel')}
                      </Button>
                      <Button
                        type="submit"
                        size="sm"
                        variant="primary"
                        loading={savingEdit}
                        disabled={!editingText.trim()}
                      >
                        {savingEdit ? t('memos.comments.saving') : t('memos.comments.save')}
                      </Button>
                    </div>
                    {editError ? (
                      <p role="alert" className="mt-1 text-[length:var(--text-11)] text-[var(--danger)]">
                        {editError}
                      </p>
                    ) : null}
                  </form>
                ) : (
                  <MemoBody content={comment.content} onTagPress={onTagPress} className="mt-1 text-[length:var(--text-12)]" />
                )}
              </li>
            )
          })}
        </ul>
      ) : null}
      {state.nextCursor ? (
        <Button
          size="sm"
          variant="ghost"
          className="mt-2 h-7 px-1.5"
          loading={state.loadingMore}
          onClick={() => void loadMore()}
        >
          {state.loadingMore ? t('memos.comments.loading_more') : t('memos.comments.load_more')}
        </Button>
      ) : null}
      {state.status === 'error' && state.items.length > 0 ? (
        <p role="alert" className="mt-2 text-[length:var(--text-11-5)] text-[var(--danger)]">
          {state.error ?? t('memos.comments.error')}
        </p>
      ) : null}
      {actionError ? (
        <p role="alert" className="mt-2 text-[length:var(--text-11-5)] text-[var(--danger)]">
          {actionError}
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
            onKeyDown={(event) => submitOnModEnter(event, () => void submit())}
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="hidden text-[length:var(--text-10-5)] text-[var(--text-quaternary)] sm:inline">
              {t('memos.comments.hint')}
            </span>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              className="ml-auto"
              loading={posting}
              disabled={!text.trim()}
            >
              {posting ? t('memos.comments.submitting') : t('memos.comments.submit')}
            </Button>
          </div>
          {postError ? (
            <p role="alert" className="mt-1 text-[length:var(--text-11)] text-[var(--danger)]">
              {postError}
            </p>
          ) : null}
        </form>
      )}
    </section>
  )
}

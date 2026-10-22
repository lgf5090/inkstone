import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Paperclip, Pencil, Trash2, X } from 'lucide-react'
import { MEMO_ATTACHMENT_MAX_BYTES, MEMO_COMMENT_PAGE_SIZE } from '@shared/memos/constants'
import type { Memo, MemoAttachment } from '@shared/memos/types'
import { Button, IconButton, Spinner } from '../../../components/primitives'
import { Skeleton } from '../../../components/feedback'
import { confirm } from '../../../components/overlay'
import { ApiError } from '../../../lib/api'
import { t } from '../../../lib/i18n'
import { shortTime } from '../../../lib/time'
import { useSession } from '../../../store/session'
import { memosApi } from '../api'
import { memoErrorMessage, memoIsAbortError } from '../errors'
import { bump } from '../events'
import { prepareMemoAttachment } from '../image-metadata'
import { loadMemoDraft } from '../state'
import { useMemoDraft } from '../use-memo-draft'
import { useMemoPreferences } from '../use-memo-preferences'
import { MemoAttachments } from './MemoAttachments'
import { MemoBody } from './MemoBody'
import { MemoEditor } from './MemoEditor'

const MEGABYTE = 1024 * 1024

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

function commentIsOwn(comment: Memo, userId: string): boolean {
  return !comment.creator || comment.creator.id === userId
}

function sameIds(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every((id, index) => id === second[index])
}

async function uploadCommentAttachment(file: File, saveMediaMetadata: boolean): Promise<MemoAttachment> {
  const prepared = await prepareMemoAttachment(file, { saveMediaMetadata })
  return memosApi.attachments.upload({
    file: prepared.file,
    thumbnail: prepared.thumbnail,
    metadata: prepared.metadata,
    memoId: null,
  })
}

async function deleteCommentAttachments(attachments: MemoAttachment[]): Promise<void> {
  for (const attachment of attachments) {
    try {
      await memosApi.attachments.delete(attachment.id)
    } catch (error) {
      console.warn('[inkstone] Could not roll back a comment attachment', error)
    }
  }
}

function AttachmentDraftList({
  attachments,
  disabled,
  onRemove,
}: {
  attachments: MemoAttachment[]
  disabled: boolean
  onRemove: (attachment: MemoAttachment) => void
}): ReactElement | null {
  if (attachments.length === 0) return null
  return (
    <ul className="mt-1.5 space-y-1">
      {attachments.map((attachment) => (
        <li
          key={attachment.id}
          className="flex min-h-8 items-center gap-1.5 rounded-[var(--r-sm)] bg-[var(--bg-raised)] px-1.5 text-[length:var(--text-11)] text-[var(--text-secondary)]"
        >
          <Paperclip size={11} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
          <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
          <IconButton
            label={t('memos.comments.remove_attachment', { name: attachment.filename })}
            size="xs"
            disabled={disabled}
            onClick={() => onRemove(attachment)}
          >
            <X size={11} />
          </IconButton>
        </li>
      ))}
    </ul>
  )
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
  const { preferences } = useMemoPreferences()
  const scope = memoCommentDraftScope(memoId)
  const [state, setState] = useState<CommentsState>({
    items: [],
    nextCursor: null,
    status: 'loading',
    error: null,
    loadingMore: false,
  })
  const [text, setText] = useState(() => (disabled ? '' : loadMemoDraft(userId, scope)?.content ?? ''))
  const [newAttachments, setNewAttachments] = useState<MemoAttachment[]>([])
  const [uploadingNew, setUploadingNew] = useState(false)
  const [newAttachmentError, setNewAttachmentError] = useState<string | null>(null)
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [added, setAdded] = useState(0)
  const [reloadTicket, setReloadTicket] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [editingAttachments, setEditingAttachments] = useState<MemoAttachment[]>([])
  const [editingNewIds, setEditingNewIds] = useState<string[]>([])
  const [uploadingEdit, setUploadingEdit] = useState(false)
  const [editAttachmentError, setEditAttachmentError] = useState<string | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const newFileInputRef = useRef<HTMLInputElement>(null)
  const editFileInputRef = useRef<HTMLInputElement>(null)
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

  const uploadFiles = async (
    files: File[],
    addUploaded: (attachment: MemoAttachment) => void,
    setUploading: (value: boolean) => void,
    setUploadError: (value: string | null) => void,
  ): Promise<void> => {
    if (files.length === 0) return
    setUploading(true)
    setUploadError(null)
    try {
      for (const file of files) {
        if (file.size > MEMO_ATTACHMENT_MAX_BYTES) {
          setUploadError(t('memos.composer.upload_too_large', {
            name: file.name,
            limit: Math.floor(MEMO_ATTACHMENT_MAX_BYTES / MEGABYTE),
          }))
          continue
        }
        try {
          addUploaded(await uploadCommentAttachment(file, preferences.saveMediaMetadata))
        } catch (error) {
          setUploadError(memoErrorMessage(error))
        }
      }
    } finally {
      setUploading(false)
    }
  }

  const removeNewAttachment = (attachment: MemoAttachment): void => {
    setNewAttachments((current) => current.filter((item) => item.id !== attachment.id))
    void deleteCommentAttachments([attachment])
  }

  const removeEditingAttachment = (attachment: MemoAttachment): void => {
    setEditingAttachments((current) => current.filter((item) => item.id !== attachment.id))
    if (editingNewIds.includes(attachment.id)) {
      setEditingNewIds((current) => current.filter((id) => id !== attachment.id))
      void deleteCommentAttachments([attachment])
    }
  }

  const submit = async (): Promise<void> => {
    const content = text.trim()
    if (!content || posting || disabled || uploadingNew) return
    setPosting(true)
    setPostError(null)
    const pending = newAttachments
    try {
      const comment = await memosApi.comments.create(memoId, pending.length > 0
        ? { content, attachmentIds: pending.map((attachment) => attachment.id) }
        : { content })
      setState((current) => ({ ...current, items: [...current.items, comment] }))
      setAdded((value) => value + 1)
      clearDraft()
      setText('')
      setNewAttachments([])
      setNewAttachmentError(null)
      bump('list')
    } catch (error) {
      setPostError(memoErrorMessage(error))
      if (pending.length > 0) {
        await deleteCommentAttachments(pending)
        setNewAttachments([])
      }
    } finally {
      setPosting(false)
    }
  }

  const startEdit = (comment: Memo): void => {
    setEditingId(comment.id)
    setEditingText(comment.content)
    setEditingAttachments(comment.attachments)
    setEditingNewIds([])
    setEditAttachmentError(null)
    setEditError(null)
    setActionError(null)
  }

  const cancelEdit = (): void => {
    const pending = editingAttachments.filter((attachment) => editingNewIds.includes(attachment.id))
    setEditingId(null)
    setEditingText('')
    setEditingAttachments([])
    setEditingNewIds([])
    setEditAttachmentError(null)
    setEditError(null)
    if (pending.length > 0) void deleteCommentAttachments(pending)
  }

  const saveEdit = async (comment: Memo): Promise<void> => {
    const content = editingText.trim()
    if (!content || savingEdit || uploadingEdit || disabled) return
    setSavingEdit(true)
    setEditError(null)
    const attachmentIds = editingAttachments.map((attachment) => attachment.id)
    const input = sameIds(attachmentIds, comment.attachments.map((attachment) => attachment.id))
      ? { rev: comment.rev, content }
      : { rev: comment.rev, content, attachmentIds }
    try {
      const saved = await memosApi.patch(comment.id, input)
      setState((current) => ({
        ...current,
        items: current.items.map((item) => (item.id === comment.id ? saved : item)),
      }))
      setEditingId(null)
      setEditingText('')
      setEditingAttachments([])
      setEditingNewIds([])
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
            const busy = savingEdit || deletingId === comment.id || uploadingEdit
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
                    <MemoEditor
                      value={editingText}
                      label={t('memos.comments.edit_label')}
                      placeholder={t('memos.comments.placeholder')}
                      onChange={setEditingText}
                      onSubmit={() => void saveEdit(comment)}
                      autoFocus
                      disabled={savingEdit}
                    />
                    <AttachmentDraftList
                      attachments={editingAttachments}
                      disabled={savingEdit || uploadingEdit}
                      onRemove={removeEditingAttachment}
                    />
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <IconButton
                        label={t('memos.comments.attach_file')}
                        size="sm"
                        disabled={savingEdit || uploadingEdit}
                        onClick={() => editFileInputRef.current?.click()}
                      >
                        <Paperclip size={14} />
                      </IconButton>
                      {uploadingEdit ? (
                        <span role="status" className="inline-flex items-center gap-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                          <Spinner size={12} />
                          {t('memos.comments.uploading_attachment')}
                        </span>
                      ) : null}
                      <span className="ml-auto flex items-center gap-1.5">
                        <Button size="sm" variant="ghost" disabled={savingEdit} onClick={cancelEdit}>
                          {t('memos.common.cancel')}
                        </Button>
                        <Button
                          type="submit"
                          size="sm"
                          variant="primary"
                          loading={savingEdit}
                          disabled={!editingText.trim() || uploadingEdit}
                        >
                          {savingEdit ? t('memos.comments.saving') : t('memos.comments.save')}
                        </Button>
                      </span>
                    </div>
                    <input
                      ref={editFileInputRef}
                      type="file"
                      multiple
                      tabIndex={-1}
                      aria-hidden="true"
                      className="sr-only"
                      onChange={(event) => {
                        const files = Array.from(event.target.files ?? [])
                        event.target.value = ''
                        void uploadFiles(
                          files,
                          (attachment) => {
                            setEditingAttachments((current) => [...current, attachment])
                            setEditingNewIds((current) => [...current, attachment.id])
                          },
                          setUploadingEdit,
                          setEditAttachmentError,
                        )
                      }}
                    />
                    {editAttachmentError ? (
                      <p role="alert" className="mt-1 text-[length:var(--text-11)] text-[var(--danger)]">
                        {editAttachmentError}
                      </p>
                    ) : null}
                    {editError ? (
                      <p role="alert" className="mt-1 text-[length:var(--text-11)] text-[var(--danger)]">
                        {editError}
                      </p>
                    ) : null}
                  </form>
                ) : (
                  <>
                    <MemoBody content={comment.content} onTagPress={onTagPress} className="mt-1 text-[length:var(--text-12)]" />
                    <MemoAttachments attachments={comment.attachments} compact className="mt-1" />
                  </>
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
          <MemoEditor
            value={text}
            label={t('memos.comments.placeholder')}
            placeholder={t('memos.comments.placeholder')}
            onChange={setText}
            onSubmit={() => void submit()}
            disabled={posting}
          />
          <AttachmentDraftList
            attachments={newAttachments}
            disabled={posting || uploadingNew}
            onRemove={removeNewAttachment}
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <IconButton
              label={t('memos.comments.attach_file')}
              size="sm"
              disabled={posting || uploadingNew}
              onClick={() => newFileInputRef.current?.click()}
            >
              <Paperclip size={14} />
            </IconButton>
            {uploadingNew ? (
              <span role="status" className="inline-flex items-center gap-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                <Spinner size={12} />
                {t('memos.comments.uploading_attachment')}
              </span>
            ) : null}
            <span className="hidden text-[length:var(--text-10-5)] text-[var(--text-quaternary)] sm:inline">
              {t('memos.comments.hint')}
            </span>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              className="ml-auto"
              loading={posting}
              disabled={!text.trim() || uploadingNew}
            >
              {posting ? t('memos.comments.submitting') : t('memos.comments.submit')}
            </Button>
          </div>
          <input
            ref={newFileInputRef}
            type="file"
            multiple
            tabIndex={-1}
            aria-hidden="true"
            className="sr-only"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              event.target.value = ''
              void uploadFiles(
                files,
                (attachment) => setNewAttachments((current) => [...current, attachment]),
                setUploadingNew,
                setNewAttachmentError,
              )
            }}
          />
          {newAttachmentError ? (
            <p role="alert" className="mt-1 text-[length:var(--text-11)] text-[var(--danger)]">
              {newAttachmentError}
            </p>
          ) : null}
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

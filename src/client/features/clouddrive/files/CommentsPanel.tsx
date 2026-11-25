import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AtSign, MessageSquare, MoreHorizontal, Trash2 } from 'lucide-react'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import { t } from '../../../lib/i18n'
import { isImeComposing } from '../../../lib/ime'
import { Avatar, Button, IconButton, Spinner } from '../../../components/primitives'
import { Field, Input, Textarea } from '../../../components/form'
import { Menu, Modal, type MenuItem } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { clouddriveApi, type CloudDriveComment, type CloudDriveCommentPerson } from '../api'
import { formatEntryDate } from './format'

const COMMENT_MAX_LENGTH = 4000
const MENTION_TOKEN = /(@[a-z0-9][a-z0-9_-]{2,31})/gi

function authorLabel(comment: CloudDriveComment): string {
  return comment.author.name && comment.author.name !== comment.author.username
    ? `${comment.author.username} · ${comment.author.name}`
    : comment.author.username
}

function CommentBody({ comment }: { comment: CloudDriveComment }) {
  const mentioned = new Set(comment.mentions.map((mention) => mention.username.toLowerCase()))
  return (
    <p className="whitespace-pre-wrap break-words text-[length:var(--text-12)] leading-relaxed text-[var(--text-secondary)]">
      {comment.body.split(MENTION_TOKEN).map((part, index) => (
        mentioned.has(part.slice(1).toLowerCase()) && part.startsWith('@')
          ? <span key={`${part}-${index}`} className="font-medium text-[var(--accent)]">{part}</span>
          : <span key={`${part}-${index}`}>{part}</span>
      ))}
    </p>
  )
}

function CommentActions({
  comment,
  disabled,
  onDelete,
}: {
  comment: CloudDriveComment
  disabled: boolean
  onDelete: (commentId: string) => Promise<void>
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  if (!comment.canDelete) return null
  const items: MenuItem[] = [{
    id: 'delete',
    label: t('clouddrive.comments.delete'),
    icon: <Trash2 size={13} />,
    tone: 'danger',
    disabled,
    onSelect: () => { void onDelete(comment.id) },
  }]
  return (
    <>
      <IconButton
        ref={anchor}
        size="sm"
        label={`${t('clouddrive.comments.actions')}: ${authorLabel(comment)}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <MoreHorizontal size={14} />
      </IconButton>
      <Menu
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        align="end"
        width={180}
        label={`${t('clouddrive.comments.actions')}: ${authorLabel(comment)}`}
        container={anchor.current?.closest<HTMLElement>('[role="dialog"]') ?? null}
      />
    </>
  )
}

export function CommentsPanel({
  entry,
  ownerId,
  currentUserId,
}: {
  entry: CloudDriveEntry
  ownerId: string
  currentUserId: string
}) {
  const toast = useUi((state) => state.toast)
  const [open, setOpen] = useState(false)
  const [comments, setComments] = useState<CloudDriveComment[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [people, setPeople] = useState<CloudDriveCommentPerson[]>([])
  const [peopleStatus, setPeopleStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionOpen, setMentionOpen] = useState(false)
  const mentionInput = useRef<HTMLInputElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const mentionMenuId = useId()

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      const result = await clouddriveApi.comments(ownerId, entry.id)
      setComments(result.comments)
      setStatus('ready')
    } catch {
      setStatus('error')
    }
  }, [entry.id, ownerId])

  const loadPeople = useCallback(async () => {
    setPeopleStatus('loading')
    try {
      const result = await clouddriveApi.commentPeople(ownerId, entry.id)
      setPeople(result.users.filter((person) => person.id !== currentUserId))
      setPeopleStatus('ready')
    } catch {
      setPeopleStatus('error')
    }
  }, [currentUserId, entry.id, ownerId])

  useEffect(() => {
    setDraft('')
    setComments([])
    setStatus('loading')
    setMentionQuery('')
    setMentionOpen(false)
  }, [entry.id, ownerId])

  useEffect(() => {
    if (open) void load()
  }, [load, open])

  useEffect(() => {
    if (open) void loadPeople()
  }, [loadPeople, open])

  const visiblePeople = useMemo(() => {
    const query = mentionQuery.trim().replace(/^@/, '').toLowerCase()
    return people.filter((person) => !query || person.username.toLowerCase().includes(query))
  }, [mentionQuery, people])

  const insertMention = (person: CloudDriveCommentPerson) => {
    const field = composer.current
    const start = field?.selectionStart ?? draft.length
    const end = field?.selectionEnd ?? start
    const separator = start > 0 && !/\s/.test(draft[start - 1] ?? '') ? ' ' : ''
    const insertion = `${separator}@${person.username} `
    setDraft(`${draft.slice(0, start)}${insertion}${draft.slice(end)}`)
    setMentionQuery('')
    setMentionOpen(false)
    requestAnimationFrame(() => {
      const caret = start + insertion.length
      composer.current?.focus()
      composer.current?.setSelectionRange(caret, caret)
    })
  }

  const mentionItems: MenuItem[] = visiblePeople.map((person) => ({
    id: person.id,
    label: person.name && person.name !== person.username ? `@${person.username} · ${person.name}` : `@${person.username}`,
    icon: <AtSign size={13} />,
    onSelect: () => insertMention(person),
  }))

  const submit = async () => {
    const body = draft.trim()
    if (!body || submitting) return
    setSubmitting(true)
    setNotice('')
    try {
      const result = await clouddriveApi.createComment(ownerId, entry.id, body)
      setComments((current) => [...current, result.comment])
      setDraft('')
      setMentionQuery('')
      setMentionOpen(false)
      setNotice(t('clouddrive.comments.created'))
      toast({ title: t('clouddrive.comments.created') })
    } catch (caught) {
      toast({
        title: t('clouddrive.toast.failed'),
        description: caught instanceof Error ? caught.message : '',
        tone: 'danger',
      })
    } finally {
      setSubmitting(false)
    }
  }

  const remove = async (commentId: string) => {
    if (deletingId) return
    setDeletingId(commentId)
    setNotice('')
    try {
      await clouddriveApi.deleteComment(ownerId, entry.id, commentId)
      setComments((current) => current.filter((comment) => comment.id !== commentId))
      setNotice(t('clouddrive.comments.deleted'))
      toast({ title: t('clouddrive.comments.deleted') })
    } catch (caught) {
      toast({
        title: t('clouddrive.toast.failed'),
        description: caught instanceof Error ? caught.message : '',
        tone: 'danger',
      })
    } finally {
      setDeletingId(null)
    }
  }

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !isImeComposing(event)) {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <section aria-labelledby={`${mentionMenuId}-comments-title`}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 id={`${mentionMenuId}-comments-title`} className="text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">
          {t('clouddrive.comments.title')}
        </h3>
        <Button size="sm" variant="secondary" icon={<MessageSquare size={12} />} onClick={() => setOpen(true)}>
          {t('clouddrive.comments.open')}
        </Button>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{notice}</p>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('clouddrive.comments.title')}
        description={entry.name}
        width={560}
        dismissible={!submitting && deletingId === null}
        footer={<Button variant="ghost" onClick={() => setOpen(false)} disabled={submitting || deletingId !== null}>{t('common.close')}</Button>}
      >
        <div className="flex flex-col gap-3">
          {status === 'loading' && (
            <div role="status" className="flex h-20 items-center justify-center gap-2 text-[var(--text-tertiary)]">
              <Spinner />
              <span className="sr-only">{t('clouddrive.loading')}</span>
            </div>
          )}
          {status === 'error' && (
            <div role="alert" className="flex flex-col items-center gap-2 py-4">
              <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('clouddrive.comments.failed')}</p>
              <Button size="sm" variant="secondary" onClick={() => void load()}>{t('clouddrive.retry')}</Button>
            </div>
          )}
          {status === 'ready' && comments.length === 0 && (
            <p className="py-4 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('clouddrive.comments.empty')}</p>
          )}
          {comments.length > 0 && (
            <ul aria-label={t('clouddrive.comments.title')} className="flex max-h-64 flex-col gap-2 overflow-y-auto">
              {comments.map((comment) => (
                <li key={comment.id} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5">
                  <article aria-label={authorLabel(comment)}>
                    <div className="flex items-start gap-2">
                      <Avatar src={comment.author.avatarUrl} name={comment.author.name || comment.author.username} size={24} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{authorLabel(comment)}</span>
                          <time dateTime={new Date(comment.createdAt).toISOString()} className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                            {formatEntryDate(comment.createdAt)}
                          </time>
                        </div>
                        <CommentBody comment={comment} />
                      </div>
                      <CommentActions
                        comment={comment}
                        disabled={deletingId !== null}
                        onDelete={remove}
                      />
                    </div>
                  </article>
                </li>
              ))}
            </ul>
          )}

          <form
            className="flex flex-col gap-2 border-t border-[var(--border-subtle)] pt-3"
            onSubmit={(event) => { event.preventDefault(); void submit() }}
          >
            <Field label={t('clouddrive.comments.composer_label')} hint={t('clouddrive.comments.hint')}>
              <Textarea
                ref={composer}
                data-autofocus
                value={draft}
                maxLength={COMMENT_MAX_LENGTH}
                rows={4}
                placeholder={t('clouddrive.comments.placeholder')}
                disabled={submitting}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onComposerKeyDown}
              />
            </Field>
            <Field label={t('clouddrive.comments.mention_search')}>
              <div className="relative">
                <Input
                  ref={mentionInput}
                  type="search"
                  value={mentionQuery}
                  placeholder={t('clouddrive.comments.mention_placeholder')}
                  aria-label={t('clouddrive.comments.mention_search')}
                  aria-haspopup="menu"
                  aria-expanded={mentionOpen && visiblePeople.length > 0}
                  aria-controls={mentionOpen && visiblePeople.length > 0 ? mentionMenuId : undefined}
                  aria-autocomplete="list"
                  autoComplete="off"
                  disabled={submitting}
                  onFocus={() => setMentionOpen(true)}
                  onChange={(event) => { setMentionQuery(event.target.value); setMentionOpen(true) }}
                />
                <Menu
                  anchor={mentionInput}
                  open={mentionOpen && visiblePeople.length > 0}
                  onClose={() => setMentionOpen(false)}
                  items={mentionItems}
                  panelId={mentionMenuId}
                  width={260}
                  label={t('clouddrive.comments.mention_search')}
                  container={mentionInput.current?.closest<HTMLElement>('[role="dialog"]') ?? null}
                />
              </div>
            </Field>
            {peopleStatus === 'loading' && <p role="status" className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('clouddrive.loading')}</p>}
            {peopleStatus === 'error' && (
              <div role="alert" className="flex items-center gap-2 text-[length:var(--text-11)] text-[var(--text-secondary)]">
                <span>{t('clouddrive.comments.mention_failed')}</span>
                <Button size="sm" variant="ghost" onClick={() => void loadPeople()}>{t('clouddrive.retry')}</Button>
              </div>
            )}
            {peopleStatus === 'ready' && people.length > 0 && visiblePeople.length === 0 && (
              <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('clouddrive.comments.mention_empty')}</p>
            )}
            <Button type="submit" size="sm" variant="primary" loading={submitting} disabled={!draft.trim()} className="self-start">
              {t('clouddrive.comments.submit')}
            </Button>
          </form>
        </div>
      </Modal>
    </section>
  )
}

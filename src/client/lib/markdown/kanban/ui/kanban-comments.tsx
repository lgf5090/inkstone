import { useId, useState } from 'react'
import { Pencil, Send, Trash2 } from 'lucide-react'
import { fullTime, shortTime } from '../../../time'
import { t } from '../../../i18n'
import {
  KANBAN_COMMENT_MAX_CHARS,
  kanbanAddComment,
  kanbanCommentExcerpt,
  kanbanCommentTime,
  kanbanCommentsOf,
  kanbanEditComment,
  kanbanLastCommentAuthor,
  kanbanRemoveComment,
} from '../comments'
import type { KanbanComment, KanbanItem } from '../types'
import { KanbanPersonAvatar } from './kanban-person-picker'

/** The counter appears for the last stretch, so the bound is seen coming rather than only hit. */
const KANBAN_COMMENT_WARN_CHARS = KANBAN_COMMENT_MAX_CHARS - 200
const COMMENT_TEXT_CLASS = 'w-full rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-2 text-[length:var(--text-12)] text-[var(--text-primary)]'
const COMMENT_CONTROL_CLASS = 'inline-flex items-center gap-1 rounded-[var(--r-xs)] p-1 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
const COMMENT_SAVE_CLASS = 'rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-raised)] px-2.5 py-1 text-[length:var(--text-11)] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'

/**
 * The same length bound the writer sees, drawn the same way in the composer and in an open edit: the
 * notice only once an input was refused, the count while the bound is in sight.
 */
function CommentFeedback({ count, trimmed }: { count: number; trimmed: boolean }) {
  if (!trimmed && count < KANBAN_COMMENT_WARN_CHARS) return null
  return (
    <>
      {trimmed ? (
        <p role='status' className='text-[length:var(--text-11)] text-[var(--text-secondary)]'>
          {t('preview.kanban_comment_limit_reached', { limit: KANBAN_COMMENT_MAX_CHARS })}
        </p>
      ) : null}
      {count >= KANBAN_COMMENT_WARN_CHARS ? (
        <p data-kanban-comment-count className='text-[length:var(--text-11)] text-[var(--text-tertiary)] tabular'>
          {t('preview.kanban_comment_count', { count, limit: KANBAN_COMMENT_MAX_CHARS })}
        </p>
      ) : null}
    </>
  )
}

/** Text with a ceiling: what a writer types is kept, and what the ceiling refused is remembered. */
function useBoundedText(initial: string) {
  const [text, setText] = useState(initial)
  const [trimmed, setTrimmed] = useState(false)
  return {
    text,
    trimmed,
    write: (next: string) => {
      // A stored comment can already be longer than the bound (a hand-written fence), and trimming it
      // back on the first keystroke would delete what the card holds.
      const ceiling = Math.max(KANBAN_COMMENT_MAX_CHARS, text.length)
      const kept = next.slice(0, ceiling)
      setTrimmed(kept.length < next.length)
      setText(kept)
    },
    clear: () => {
      setText('')
      setTrimmed(false)
    },
  }
}

/** Who is speaking: a name the writer types, with the names this board already knows on offer. */
function CommentAuthorField({
  name,
  choices,
  onChange,
}: {
  name: string
  choices: string[]
  onChange: (name: string) => void
}) {
  const listId = useId()
  return (
    <>
      <input
        type='text'
        data-kanban-comment-author
        value={name}
        onChange={(e) => onChange(e.target.value)}
        aria-label={t('preview.kanban_comment_author')}
        placeholder={t('preview.kanban_comment_author')}
        {...(choices.length > 0 ? { list: listId } : {})}
        className='h-7 w-40 self-start rounded-[var(--r-xs)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 text-[length:var(--text-11)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]'
      />
      {choices.length > 0 ? (
        <datalist id={listId}>
          {choices.map((choice) => (
            <option key={choice} value={choice} />
          ))}
        </datalist>
      ) : null}
    </>
  )
}

/** The bound the draft is inside, next to the key that sends it. */
function CommentSendRow({ canSend, count, trimmed }: { canSend: boolean; count: number; trimmed: boolean }) {
  return (
    <div className='flex items-center justify-between gap-2'>
      <CommentFeedback count={count} trimmed={trimmed} />
      <button
        type='submit'
        data-kanban-comment-send
        disabled={!canSend}
        className={`${COMMENT_SAVE_CLASS} inline-flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <Send size={12} aria-hidden />
        <span>{t('preview.kanban_comment_send')}</span>
      </button>
    </div>
  )
}

/** The box that writes a new comment: who is speaking, what they say, and the key that means send. */
function CommentComposer({
  author,
  choices,
  onSend,
}: {
  author: string
  choices: string[]
  onSend: (author: string, text: string) => void
}) {
  const box = useBoundedText('')
  const [name, setName] = useState(author)
  const canSend = box.text.trim() !== ''

  const handleSend = () => {
    if (!canSend) return
    onSend(name, box.text)
    box.clear()
  }

  return (
    <form
      data-kanban-comment-form
      className='flex flex-col gap-1.5'
      onSubmit={(e) => {
        e.preventDefault()
        handleSend()
      }}
    >
      <CommentAuthorField name={name} choices={choices} onChange={setName} />
      <textarea
        data-kanban-comment-draft
        data-owns-escape='true'
        value={box.text}
        rows={2}
        onChange={(e) => box.write(e.target.value)}
        // Enter stays a newline here as it does in the description; the chord is what means send.
        onKeyDown={(e) => {
          if (e.key === 'Escape') box.clear()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            handleSend()
          }
        }}
        aria-label={t('preview.kanban_comment_placeholder')}
        placeholder={t('preview.kanban_comment_placeholder')}
        className={`${COMMENT_TEXT_CLASS} outline-none resize-y focus:border-[var(--accent)]`}
      />
      <CommentSendRow canSend={canSend} count={box.text.length} trimmed={box.trimmed} />
    </form>
  )
}

/** The same box with a stored comment already in it; it exists only while that row is being edited. */
function CommentEditor({
  comment,
  onSave,
  onCancel,
}: {
  comment: KanbanComment
  onSave: (text: string) => void
  onCancel: () => void
}) {
  const box = useBoundedText(comment.text)
  return (
    <div className='flex flex-col gap-1.5'>
      <textarea
        data-kanban-comment-edit-box
        data-owns-escape='true'
        autoFocus
        value={box.text}
        rows={3}
        onChange={(e) => box.write(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            onSave(box.text)
          }
        }}
        aria-label={t('preview.kanban_comment_edit')}
        className={`${COMMENT_TEXT_CLASS} outline-none resize-y focus:border-[var(--accent)]`}
      />
      <div className='flex items-center justify-between gap-2'>
        <CommentFeedback count={box.text.length} trimmed={box.trimmed} />
        <div className='flex items-center gap-1'>
          <button type='button' data-kanban-comment-save onClick={() => onSave(box.text)} className={COMMENT_SAVE_CLASS}>
            {t('preview.kanban_comment_save')}
          </button>
          <button type='button' data-kanban-comment-cancel onClick={onCancel} className={COMMENT_SAVE_CLASS}>
            {t('preview.kanban_comment_cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Who wrote it and when, next to the two controls that change what they wrote. */
function CommentByline({
  comment,
  onEdit,
  onRemove,
}: {
  comment: KanbanComment
  onEdit: () => void
  onRemove: () => void
}) {
  const when = kanbanCommentTime(comment)
  return (
    <div className='flex items-center gap-1.5'>
      {comment.author ? <KanbanPersonAvatar name={comment.author} /> : null}
      <span className='truncate text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]'>
        {comment.author || t('preview.kanban_comment_anonymous')}
      </span>
      {when !== null ? (
        <time dateTime={comment.at} title={fullTime(when)} className='text-[length:var(--text-11)] text-[var(--text-tertiary)]'>
          {shortTime(when)}
        </time>
      ) : null}
      <span className='ml-auto flex items-center gap-0.5'>
        <button
          type='button'
          data-kanban-comment-edit
          onClick={onEdit}
          aria-label={t('preview.kanban_comment_edit')}
          className={COMMENT_CONTROL_CLASS}
        >
          <Pencil size={13} />
        </button>
        <button
          type='button'
          data-kanban-comment-delete
          onClick={onRemove}
          aria-label={t('preview.kanban_comment_delete', { text: kanbanCommentExcerpt(comment.text) })}
          className={COMMENT_CONTROL_CLASS}
        >
          <Trash2 size={13} />
        </button>
      </span>
    </div>
  )
}

function CommentRow({
  comment,
  onSave,
  onRemove,
}: {
  comment: KanbanComment
  onSave: (text: string) => void
  onRemove: () => void
}) {
  const [editing, setEditing] = useState(false)
  return (
    <li data-kanban-comment className='flex flex-col gap-1.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-2.5'>
      {editing ? (
        <CommentEditor
          comment={comment}
          onSave={(text) => {
            onSave(text)
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <CommentByline comment={comment} onEdit={() => setEditing(true)} onRemove={onRemove} />
          <p className='text-[length:var(--text-12)] break-words whitespace-pre-wrap text-[var(--text-primary)]'>
            {comment.text}
          </p>
        </>
      )}
    </li>
  )
}

/** Who a card may be commented under: the people the board names, plus every name already used here. */
function authorChoices(item: KanbanItem, people?: Record<string, string[]>): string[] {
  const names = [
    ...(people ? Object.values(people).flat() : []),
    ...kanbanCommentsOf(item).map((comment) => comment.author ?? ''),
  ]
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))]
}

/**
 * The card's conversation. A fence has no accounts behind it, so the name is something the writer
 * types and not an identity the board vouches for; and it has no server keeping an event log, so this
 * is the whole activity record rather than one stream among several.
 */
export function DetailComments({
  item,
  people,
  onUpdate,
}: {
  item: KanbanItem
  people?: Record<string, string[]>
  onUpdate: (updated: KanbanItem) => void
}) {
  const headingId = useId()
  const comments = kanbanCommentsOf(item)

  return (
    <div data-kanban-comments className='flex flex-col gap-2'>
      {/* The type goes on this wrapper, not on the heading: prose owns a note's `h4` and wins any
          utility written on it (see the hand-back block in `styles/kanban.css`). */}
      <div className='text-[length:var(--text-13)] font-semibold'>
        <h4 id={headingId} className='text-[var(--text-secondary)]'>
          {t('preview.kanban_comments')}
        </h4>
      </div>
      {comments.length > 0 ? (
        <ol aria-labelledby={headingId} className='flex flex-col gap-1.5'>
          {comments.map((comment) => (
            <CommentRow
              key={comment.id}
              comment={comment}
              onSave={(text) => {
                const next = kanbanEditComment(item, comment.id, text)
                if (next !== item) onUpdate(next)
              }}
              onRemove={() => onUpdate(kanbanRemoveComment(item, comment.id))}
            />
          ))}
        </ol>
      ) : (
        <p className='text-[length:var(--text-11)] text-[var(--text-tertiary)]'>
          {t('preview.kanban_comments_empty')}
        </p>
      )}
      <CommentComposer
        author={kanbanLastCommentAuthor(item)}
        choices={authorChoices(item, people)}
        onSend={(author, text) => onUpdate(kanbanAddComment(item, { author, text }))}
      />
    </div>
  )
}

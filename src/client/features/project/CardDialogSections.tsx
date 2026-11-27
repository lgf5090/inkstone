import { useRef, useState } from 'react'
import { AtSign, Link2, ListTodo, MessageSquare, Paperclip, Pencil, Plus, Sparkles, Trash2, type LucideIcon } from 'lucide-react'
import type { ProjectAttachment, ProjectBoardMember, ProjectCard, ProjectCardLink, ProjectComment, ProjectPeople, ProjectProperty } from '@shared/project/model'
import { isProjectCardDone, projectPersonLabel } from '@shared/project/model'
import { t } from '../../lib/i18n'
import { Avatar, Button, IconButton } from '../../components/primitives'
import { Checkbox, Textarea } from '../../components/form'
import { SelectMenu } from '../../components/select-menu'
import { Menu } from '../../components/overlay'
import { projectFileUrl } from './api'

function SectionHeading({ icon: Icon, label }: { icon: LucideIcon, label: string }) {
  return (
    <h3 className="flex items-center gap-1.5 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
      <Icon size={13} aria-hidden="true" />{label}
    </h3>
  )
}

export function CardCommentsSection({ comments, error, onRetry, draft, onDraftChange, posting, onPost, editingId, onStartEdit, editDraft, onEditDraftChange, onSaveEdit, onCancelEdit, onDelete, onMention, members, people, currentUserId, canEdit }: {
  comments: ProjectComment[] | null
  error: boolean
  onRetry: () => void
  draft: string
  onDraftChange: (value: string) => void
  posting: boolean
  onPost: () => void
  editingId: string | null
  onStartEdit: (id: string, body: string) => void
  editDraft: string
  onEditDraftChange: (value: string) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onDelete: (id: string) => void
  onMention: (name: string) => void
  members: ProjectBoardMember[]
  people: ProjectPeople
  currentUserId?: string
  canEdit: boolean
}) {
  const mentionAnchor = useRef<HTMLButtonElement>(null)
  const [mentionOpen, setMentionOpen] = useState(false)
  return (
    <section aria-label={t('project.card.comments')} className="space-y-2">
      <SectionHeading icon={MessageSquare} label={t('project.card.comments')} />
      {error
        ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-[length:var(--text-12)] text-[var(--danger)]">
              {t('project.common.load_failed')}
              <Button size="sm" variant="ghost" onClick={onRetry}>{t('project.common.retry')}</Button>
            </div>
          )
        : comments === null
          ? <p role="status" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('common.loading')}</p>
          : comments.length === 0
            ? <p className="rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-3 py-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.card.comments_empty')}</p>
            : (
      <ul className="space-y-2">
        {comments.map((comment) => (
          <li key={comment.id} className="rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-3 py-2">
            <div className="flex items-center gap-2">
              <Avatar src={people[comment.authorId]?.avatarUrl} name={projectPersonLabel(people, comment.authorId)} size={18} />
              <p className="min-w-0 flex-1 truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{projectPersonLabel(people, comment.authorId)}</p>
              {canEdit && comment.authorId === currentUserId && editingId !== comment.id && (
                <>
                  <IconButton label={t('project.card.edit_comment')} size="sm" onClick={() => onStartEdit(comment.id, comment.body)}><Pencil size={13} /></IconButton>
                  <IconButton label={t('common.delete')} size="sm" onClick={() => onDelete(comment.id)}><Trash2 size={13} /></IconButton>
                </>
              )}
            </div>
            {editingId === comment.id
              ? (
                  <div className="space-y-2">
                    <Textarea className="w-full" rows={2} value={editDraft} aria-label={t('project.card.edit_comment')} onChange={(event) => onEditDraftChange(event.target.value)} />
                    <div className="flex gap-2">
                      <Button size="sm" variant="primary" disabled={!editDraft.trim()} onClick={onSaveEdit}>{t('common.save')}</Button>
                      <Button size="sm" variant="ghost" onClick={onCancelEdit}>{t('common.cancel')}</Button>
                    </div>
                  </div>
                )
              : <p className="whitespace-pre-wrap text-[length:var(--text-13)] text-[var(--text-primary)]">{comment.body}</p>}
          </li>
        ))}
      </ul>
      )}
      <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); onPost() }}>
        <Textarea
          className="w-full"
          rows={2}
          value={draft}
          placeholder={t('project.card.comment_placeholder')}
          aria-label={t('project.card.comment_placeholder')}
          onChange={(event) => onDraftChange(event.target.value)}
        />
        <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.card.mention_hint')}</span>
        <IconButton ref={mentionAnchor} label={t('project.card.mention')} size="sm" onClick={() => setMentionOpen(true)}>
          <AtSign size={13} />
        </IconButton>
        <Menu
          anchor={mentionAnchor}
          open={mentionOpen}
          onClose={() => setMentionOpen(false)}
          label={t('project.card.mention')}
          items={members.map((member) => ({
            id: member.userId,
            label: projectPersonLabel(people, member.userId),
            onSelect: () => {
              setMentionOpen(false)
              onMention(projectPersonLabel(people, member.userId))
            },
          }))}
        />
        <Button type="submit" variant="primary" size="sm" disabled={posting || comments === null || error || !draft.trim()}>
          {t('project.card.post_comment')}
        </Button>
      </form>
    </section>
  )
}

export function CardAttachmentsSection({ files, error, onRetry, canEdit, onAttach, onDelete }: {
  files: ProjectAttachment[] | null
  error: boolean
  onRetry: () => void
  canEdit: boolean
  onAttach: (file: File) => void
  onDelete: (id: string) => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  return (
    <section aria-label={t('project.card.attachments')} className="space-y-2">
      <div className="flex items-center gap-2">
        <SectionHeading icon={Paperclip} label={t('project.card.attachments')} />
        {canEdit && (
          <>
            <input ref={fileInput} type="file" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) onAttach(file); event.target.value = '' }} />
            <Button size="sm" icon={<Paperclip size={14} />} onClick={() => fileInput.current?.click()}>{t('project.card.add_attachment')}</Button>
          </>
        )}
      </div>
      {error
        ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-[length:var(--text-12)] text-[var(--danger)]">
              {t('project.common.load_failed')}
              <Button size="sm" variant="ghost" onClick={onRetry}>{t('project.common.retry')}</Button>
            </div>
          )
        : files === null
          ? <p role="status" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('common.loading')}</p>
          : files.length === 0
            ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.card.attachments_empty')}</p>
            : (
      <ul className="space-y-1">
        {files.map((file) => (
          <li key={file.id} className="flex items-center gap-2">
            <a className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--accent)]" href={projectFileUrl(file.id)} target="_blank" rel="noreferrer">{file.filename}</a>
            {canEdit && <IconButton label={t('common.delete')} size="sm" onClick={() => onDelete(file.id)}><Trash2 size={14} /></IconButton>}
          </li>
        ))}
      </ul>
      )}
    </section>
  )
}

export function CardDependenciesSection({ links, error, onRetry, blockers, siblings, cardId, canEdit, blocker, onBlockerChange, onAdd, onRemove }: {
  links: ProjectCardLink[] | null
  error: boolean
  onRetry: () => void
  blockers: ProjectCardLink[]
  siblings: ProjectCard[]
  cardId: string
  canEdit: boolean
  blocker: string
  onBlockerChange: (value: string) => void
  onAdd: () => void
  onRemove: (id: string) => void
}) {
  return (
    <section aria-label={t('project.card.dependencies')} className="space-y-2">
      <SectionHeading icon={Link2} label={t('project.card.dependencies')} />
      {error
        ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-[length:var(--text-12)] text-[var(--danger)]">
              {t('project.common.load_failed')}
              <Button size="sm" variant="ghost" onClick={onRetry}>{t('project.common.retry')}</Button>
            </div>
          )
        : links === null
          ? <p role="status" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('common.loading')}</p>
          : blockers.length === 0
            ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.card.dependencies_empty')}</p>
            : (
      <ul className="space-y-1">
        {blockers.map((link) => (
          <li key={link.fromCardId} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{siblings.find((sibling) => sibling.id === link.fromCardId)?.title ?? link.fromCardId}</span>
            {canEdit && <IconButton label={t('common.delete')} size="sm" onClick={() => onRemove(link.fromCardId)}><Trash2 size={14} /></IconButton>}
          </li>
        ))}
      </ul>
      )}
      {canEdit && (
        <div className="flex items-center gap-2">
          <SelectMenu className="min-w-0 flex-1" value={blocker} label={t('project.card.add_dependency')} searchable onChange={onBlockerChange} options={[{ value: '', label: t('project.card.add_dependency') }, ...siblings.filter((sibling) => sibling.id !== cardId && !blockers.some((entry) => entry.fromCardId === sibling.id)).map((sibling) => ({ value: sibling.id, label: sibling.title }))]} />
          <Button size="sm" disabled={!blocker} onClick={onAdd}>{t('project.card.add_dependency')}</Button>
        </div>
      )}
    </section>
  )
}

export function CardSubtasksSection({ subtasks, properties, doneCount, canEdit, canAiSplit, aiSplitting, onToggle, onOpen, onDelete, onAdd, onAiSplit }: {
  subtasks: ProjectCard[]
  properties: ProjectProperty[]
  doneCount: number
  canEdit: boolean
  canAiSplit: boolean
  aiSplitting: boolean
  onToggle: (card: ProjectCard, checked: boolean) => void
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onAdd: () => void
  onAiSplit: () => void
}) {
  return (
    <section aria-label={t('project.card.subtasks')} className="space-y-2">
      <div className="flex items-center gap-2">
        <SectionHeading icon={ListTodo} label={t('project.card.subtasks')} />
        {canEdit && (
          <>
            <Button size="sm" icon={<Plus size={14} />} onClick={onAdd}>{t('project.card.add_subtask')}</Button>
            <Button size="sm" variant="ghost" icon={<Sparkles size={14} />} disabled={aiSplitting || !canAiSplit} onClick={onAiSplit}>
              {aiSplitting ? t('project.card.ai_split_loading') : t('project.card.ai_split')}
            </Button>
          </>
        )}
      </div>
      {subtasks.length > 0 && (
        <div className="flex items-center gap-2">
          <div role="progressbar" aria-valuenow={doneCount} aria-valuemin={0} aria-valuemax={subtasks.length} aria-valuetext={`${doneCount}/${subtasks.length}`} aria-label={t('project.card.subtask_progress')} className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--bg-sunken)]">
            <div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-200" style={{ width: `${Math.round((doneCount / subtasks.length) * 100)}%` }} />
          </div>
          <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{doneCount}/{subtasks.length}</span>
        </div>
      )}
      <ul className="space-y-1">
        {subtasks.map((subtask) => {
          const done = isProjectCardDone(subtask, properties)
          return (
            <li key={subtask.id} className="group flex items-center gap-1.5 text-[length:var(--text-13)] text-[var(--text-primary)]">
              <Checkbox ariaLabel={subtask.title || t('project.board.untitled_card')} checked={done} disabled={!canEdit} onChange={(checked) => onToggle(subtask, checked)} />
              <button type="button" className={`min-w-0 flex-1 truncate text-left hover:text-[var(--accent)] hover:underline focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${done ? 'text-[var(--text-tertiary)] line-through' : ''}`} onClick={() => onOpen(subtask.id)}>
                {subtask.title || t('project.board.untitled_card')}
              </button>
              {canEdit && <IconButton label={t('common.delete')} size="sm" className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100" data-touch-reveal="" onClick={() => onDelete(subtask.id)}><Trash2 size={13} /></IconButton>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

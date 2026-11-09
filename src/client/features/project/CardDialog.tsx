import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type ReactElement } from 'react'
import { Archive, CheckSquare, ChevronDown, ChevronUp, Copy, FileText, Link2, ListTodo, MessageSquare, Minus, MoreHorizontal, Paperclip, Pencil, Plus, SlidersHorizontal, Trash2, Type, type LucideIcon } from 'lucide-react'
import type { ProjectAttachment, ProjectBoardMember, ProjectCard, ProjectCardLink, ProjectComment, ProjectContent, ProjectProperty } from '@shared/project/model'
import { moveContentOrder } from '@shared/project/content-order'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, commitOnEnter, Input, Select, Textarea } from '../../components/form'
import { Menu, Modal, prompt, type MenuItem } from '../../components/overlay'
import { addCardLink, createCardComment, createCardContent, createProjectCard, deleteCardContent, deleteCardComment, deleteProjectFile, duplicateProjectCard, fetchCardComments, fetchCardLinks, listBoardFiles, patchCardContent, patchCardComment, patchProjectCard, projectFileUrl, removeCardLink, saveCardAsTemplate, uploadBoardFile } from './api'
import { PropertyValueEditor } from './PropertyValueEditor'
import { useUi } from '../../store/ui'
import { useSession } from '../../store/session'

interface CardDialogProps {
  card: ProjectCard
  properties: ProjectProperty[]
  members: ProjectBoardMember[]
  contents: ProjectContent[]
  siblings: ProjectCard[]
  canEdit: boolean
  onClose: () => void
  onUpdated: (card: ProjectCard) => void
  onRefresh: () => void
  onDelete: (id: string) => void
  onOpenCard?: (id: string) => void
}

function SectionHeading({ icon: Icon, label }: { icon: LucideIcon, label: string }): ReactElement {
  return (
    <h3 className="flex items-center gap-1.5 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
      <Icon size={13} aria-hidden="true" />{label}
    </h3>
  )
}

function ArchivedFile(): ReactElement {
  return (
    <p className="flex items-center gap-1 rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-2 py-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
      <Archive size={13} aria-hidden="true" />{t('project.card.archived_file')}
    </p>
  )
}

export function CardDialog({ card, properties, members, contents, siblings, canEdit, onClose, onUpdated, onRefresh, onDelete, onOpenCard }: CardDialogProps): ReactElement {
  const [title, setTitle] = useState(card.title)
  const [comments, setComments] = useState<ProjectComment[]>([])
  const [commentDraft, setCommentDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [blocks, setBlocks] = useState<ProjectContent[]>(contents)
  const [links, setLinks] = useState<ProjectCardLink[]>([])
  const [files, setFiles] = useState<ProjectAttachment[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const [blocker, setBlocker] = useState('')
  const addAnchor = useRef<HTMLButtonElement>(null)
  const [addOpen, setAddOpen] = useState(false)
  const menuAnchor = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const toast = useUi((state) => state.toast)
  const currentUserId = useSession((state) => state.user?.id)
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')

  const duplicateCard = async () => {
    try {
      await duplicateProjectCard(card.id)
      onRefresh()
    } catch (reason) {
      toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
    }
  }
  const copyLink = async () => {
    const url = `${window.location.origin}/project/boards/${encodeURIComponent(card.boardId)}?card=${encodeURIComponent(card.id)}`
    try {
      await navigator.clipboard.writeText(url)
      toast({ title: t('common.copied') })
    } catch {
      toast({ title: t('project.card.copy_link_failed'), tone: 'danger' })
    }
  }

  useEffect(() => {
    fetchCardLinks(card.id).then(setLinks).catch(() => setLinks([]))
    listBoardFiles(card.boardId, card.id).then(setFiles).catch(() => setFiles([]))
  }, [card.id, card.boardId])

  const attachFile = async (file: File) => {
    const uploaded = await uploadBoardFile(card.boardId, file, card.id)
    setFiles((current) => [uploaded, ...current])
  }

  useEffect(() => { setTitle(card.title) }, [card.title])
  useEffect(() => {
    const controller = new AbortController()
    fetchCardComments(card.id, controller.signal)
      .then(setComments)
      .catch(() => { if (!controller.signal.aborted) setComments([]) })
    return () => controller.abort()
  }, [card.id])

  const patch = useCallback(async (body: Record<string, unknown>) => {
    const updated = await patchProjectCard(card.id, body)
    onUpdated(updated)
  }, [card.id, onUpdated])

  const commitTitle = () => {
    if (title !== card.title) void patch({ title })
  }

  const postComment = async () => {
    const body = commentDraft.trim()
    if (!body || posting) return
    setPosting(true)
    try {
      const comment = await createCardComment(card.id, body)
      setComments((current) => [...current, comment])
      setCommentDraft('')
    } finally {
      setPosting(false)
    }
  }

  const saveCommentEdit = async () => {
    if (!editingCommentId) return
    const body = editDraft.trim()
    if (!body) return
    const updated = await patchCardComment(editingCommentId, body)
    setComments((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)))
    setEditingCommentId(null)
  }
  const removeComment = async (id: string) => {
    await deleteCardComment(id)
    setComments((current) => current.filter((entry) => entry.id !== id))
  }
  const pasteImage = async (event: ClipboardEvent) => {
    if (!canEdit) return
    const image = [...event.clipboardData.files].find((file) => file.type.startsWith('image/'))
    if (!image) return
    event.preventDefault()
    const uploaded = await uploadBoardFile(card.boardId, image, card.id)
    const block = await createCardContent(card.id, { type: 'image', title: image.name, fields: { attachmentId: uploaded.id } })
    setFiles((current) => [uploaded, ...current])
    setBlocks((current) => [...current, block])
  }

  const addBlock = async (type: ProjectContent['type']) => {
    let title = ''
    if (type === 'text') {
      const entered = await prompt({ title: t('project.card.text_block'), confirmLabel: t('project.card.add_content') })
      if (entered === null) return
      title = entered
    }
    const block = await createCardContent(card.id, { type, title, fields: type === 'checkbox' ? { checked: false } : {} })
    setBlocks((current) => [...current, block])
  }

  const toggleBlock = async (block: ProjectContent, checked: boolean) => {
    const updated = await patchCardContent(block.id, { fields: { ...block.fields, checked } })
    setBlocks((current) => current.map((entry) => (entry.id === block.id ? updated : entry)))
  }

  const removeBlock = async (block: ProjectContent) => {
    await deleteCardContent(block.id)
    setBlocks((current) => current.filter((entry) => entry.id !== block.id))
  }
  const reorderBlock = async (id: string, targetId: string, where: 'before' | 'after') => {
    const newOrder = moveContentOrder(card.contentOrder, id, targetId, where)
    const updated = await patchProjectCard(card.id, { contentOrder: newOrder })
    onUpdated(updated)
    const flat = newOrder.flat()
    setBlocks((current) => [...current].sort((a, b) => flat.indexOf(a.id) - flat.indexOf(b.id)))
  }
  const moveBlock = (block: ProjectContent, direction: 'up' | 'down') => {
    const ids = blocks.map((entry) => entry.id)
    const index = ids.indexOf(block.id)
    const neighbor = direction === 'up' ? ids[index - 1] : ids[index + 1]
    if (!neighbor) return
    void reorderBlock(block.id, neighbor, direction === 'up' ? 'before' : 'after')
  }

  const contentMenu: MenuItem[] = [
    { id: 'text', label: t('project.card.text_block'), icon: <Type size={15} />, onSelect: () => void addBlock('text') },
    { id: 'checkbox', label: t('project.card.checkbox_block'), icon: <CheckSquare size={15} />, onSelect: () => void addBlock('checkbox') },
    { id: 'divider', label: t('project.card.divider_block'), icon: <Minus size={15} />, onSelect: () => void addBlock('divider') },
  ]

  const subtasks = siblings.filter((sibling) => sibling.parentId === card.id)
  const statusProperty = properties.find((property) => property.type === 'select')
  const doneLabel = t('project.card.done_label').toLowerCase()
  const isSubtaskDone = (sibling: ProjectCard): boolean => {
    const option = statusProperty?.options.find((entry) => entry.id === sibling.values[statusProperty.id])
    if (!option) return false
    const value = option.value.toLowerCase()
    return value === doneLabel || /done|complete/.test(value)
  }
  const subtaskDone = subtasks.filter(isSubtaskDone).length
  const toggleSubtask = async (subtask: ProjectCard, checked: boolean) => {
    if (!statusProperty) return
    const doneOption = statusProperty.options.find((entry) => {
      const value = entry.value.toLowerCase()
      return value === doneLabel || /done|complete/.test(value)
    })
    await patchProjectCard(subtask.id, { values: { [statusProperty.id]: checked && doneOption ? doneOption.id : null } })
    onRefresh()
  }
  const blockers = links.filter((link) => link.toCardId === card.id && link.kind === 'blocks')

  const addSubtask = async () => {
    const name = await prompt({ title: t('project.card.add_subtask'), confirmLabel: t('project.card.add_subtask') })
    if (name === null || !name.trim()) return
    await createProjectCard(card.boardId, { title: name.trim(), parentId: card.id })
    onRefresh()
  }
  const addDependency = async () => {
    if (!blocker) return
    await addCardLink(blocker, card.id, 'blocks')
    setLinks(await fetchCardLinks(card.id))
    setBlocker('')
  }
  const removeDependency = async (fromId: string) => {
    await removeCardLink(fromId, card.id, 'blocks')
    setLinks(await fetchCardLinks(card.id))
  }

  return (
    <Modal open onClose={onClose} title={card.title || t('project.board.untitled_card')} width={640}>
      <div className="space-y-4">
        {card.parentId && siblings.some((s) => s.id === card.parentId) && (
          <nav aria-label={t('project.card.subtasks')} className="flex items-center gap-1.5 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            <button
              type="button"
              className="truncate font-medium text-[var(--text-secondary)] hover:text-[var(--accent)] hover:underline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              onClick={() => onOpenCard?.(card.parentId)}
            >
              {siblings.find((s) => s.id === card.parentId)?.title || t('project.board.untitled_card')}
            </button>
            <span aria-hidden="true">/</span>
            <span className="truncate font-semibold text-[var(--text-primary)]">{card.title || t('project.board.untitled_card')}</span>
          </nav>
        )}
        <Input
          className="w-full"
          value={title}
          disabled={!canEdit}
          aria-label={t('project.board.title_column')}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={(event) => commitOnEnter(event, commitTitle)}
        />
        <div className="flex items-center gap-1">
          {canEdit && (
            <Button size="sm" variant="ghost" onClick={() => { void saveCardAsTemplate(card.id).then(onRefresh) }}>{t('project.card.save_as_template')}</Button>
          )}
          <IconButton ref={menuAnchor} label={t('project.card.menu')} size="sm" onClick={() => setMenuOpen(true)}>
            <MoreHorizontal size={15} />
          </IconButton>
          <Menu
            anchor={menuAnchor}
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            label={t('project.card.menu')}
            items={[
              ...(canEdit ? [{ id: 'duplicate', label: t('project.card.duplicate'), icon: <Copy size={15} />, onSelect: () => { void duplicateCard() } }] : []),
              { id: 'copy-link', label: t('project.card.copy_link'), icon: <Link2 size={15} />, onSelect: () => { void copyLink() } },
              ...(canEdit ? [{ id: 'delete', label: t('project.board.delete_card'), icon: <Trash2 size={15} />, tone: 'danger' as const, separatorBefore: true, onSelect: () => { onClose(); onDelete(card.id) } }] : []),
            ] as MenuItem[]}
          />
        </div>
        <section aria-label={t('project.card.properties')} className="space-y-2">
          <SectionHeading icon={SlidersHorizontal} label={t('project.card.properties')} />
          {properties.length === 0 && <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">—</p>}
          {properties.map((property) => (
            <div key={property.id} className="flex items-start gap-3">
              <span className="w-28 shrink-0 pt-1.5 text-[length:var(--text-12)] text-[var(--text-secondary)]">{property.name}</span>
              <div className="min-w-0 flex-1">
                <PropertyValueEditor
                  property={property}
                  value={card.values[property.id] ?? ''}
                  members={members}
                  disabled={!canEdit}
                  onChange={(value) => void patch({ values: { [property.id]: value } })}
                />
              </div>
            </div>
          ))}
        </section>
        <section aria-label={t('project.card.content')} className="space-y-2" onPaste={(event) => void pasteImage(event)}>
          <div className="flex items-center gap-2">
            <SectionHeading icon={FileText} label={t('project.card.content')} />
            {canEdit && (
              <>
                <IconButton ref={addAnchor} label={t('project.card.add_content')} size="sm" onClick={() => setAddOpen(true)}><Plus size={14} /></IconButton>
                <Menu anchor={addAnchor} open={addOpen} onClose={() => setAddOpen(false)} items={contentMenu} label={t('project.card.add_content')} />
              </>
            )}
          </div>
          {blocks.length === 0 && <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">—</p>}
          <div className="space-y-2">
            {blocks.map((block) => (
              <div
                key={block.id}
                className="flex items-start gap-2"
                data-project-content={block.id}
                draggable={canEdit}
                onDragStart={(event) => { event.dataTransfer.setData('text/plain', block.id) }}
                onDragOver={(event) => { if (canEdit) event.preventDefault() }}
                onDrop={(event) => {
                  if (!canEdit) return
                  event.preventDefault()
                  const source = event.dataTransfer.getData('text/plain')
                  if (source && source !== block.id) void reorderBlock(source, block.id, 'before')
                }}
              >
                <div className="min-w-0 flex-1">
                  {block.type === 'checkbox'
                    ? <Checkbox label={block.title || t('project.card.checkbox_block')} checked={block.fields.checked === true} disabled={!canEdit} onChange={(checked) => void toggleBlock(block, checked)} />
                    : block.type === 'divider'
                      ? <hr className="border-[var(--border-subtle)]" />
                      : block.type === 'image'
                        ? (block.fields.attachmentId && files.some((file) => file.id === block.fields.attachmentId)
                          ? <img src={projectFileUrl(block.fields.attachmentId)} alt={block.title} className="max-h-64 rounded-[var(--r-sm)]" />
                          : <ArchivedFile />)
                        : block.type === 'attachment'
                          ? (block.fields.attachmentId && files.some((file) => file.id === block.fields.attachmentId)
                            ? <a className="text-[length:var(--text-13)] text-[var(--accent)]" href={projectFileUrl(block.fields.attachmentId)} target="_blank" rel="noreferrer">{block.title}</a>
                            : <ArchivedFile />)
                          : <p className="whitespace-pre-wrap text-[length:var(--text-13)] text-[var(--text-primary)]">{block.title}</p>}
                </div>
                {canEdit && (
                  <>
                    <IconButton label={t('project.card.move_up')} size="sm" onClick={() => moveBlock(block, 'up')}><ChevronUp size={14} /></IconButton>
                    <IconButton label={t('project.card.move_down')} size="sm" onClick={() => moveBlock(block, 'down')}><ChevronDown size={14} /></IconButton>
                    <IconButton label={t('common.delete')} size="sm" onClick={() => void removeBlock(block)}><Trash2 size={14} /></IconButton>
                  </>
                )}
              </div>
            ))}
          </div>
        </section>
        <section aria-label={t('project.card.subtasks')} className="space-y-2">
          <div className="flex items-center gap-2">
            <SectionHeading icon={ListTodo} label={t('project.card.subtasks')} />
            {canEdit && <Button size="sm" icon={<Plus size={14} />} onClick={() => void addSubtask()}>{t('project.card.add_subtask')}</Button>}
          </div>
          {subtasks.length > 0 && (
            <div className="flex items-center gap-2">
              <div role="progressbar" aria-valuenow={subtaskDone} aria-valuemin={0} aria-valuemax={subtasks.length} aria-valuetext={`${subtaskDone}/${subtasks.length}`} aria-label={t('project.card.subtask_progress')} className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--bg-sunken)]">
                <div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-200" style={{ width: `${Math.round((subtaskDone / subtasks.length) * 100)}%` }} />
              </div>
              <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{subtaskDone}/{subtasks.length}</span>
            </div>
          )}
          <ul className="space-y-1">
            {subtasks.map((subtask) => (
              <li key={subtask.id} className="group flex items-center gap-1.5 text-[length:var(--text-13)] text-[var(--text-primary)]">
                <Checkbox ariaLabel={subtask.title || t('project.board.untitled_card')} checked={isSubtaskDone(subtask)} disabled={!canEdit} onChange={(checked) => void toggleSubtask(subtask, checked)} />
                <button
                  type="button"
                  className={`min-w-0 flex-1 truncate text-left hover:text-[var(--accent)] hover:underline focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${isSubtaskDone(subtask) ? 'text-[var(--text-tertiary)] line-through' : ''}`}
                  onClick={() => onOpenCard?.(subtask.id)}
                >
                  {subtask.title || t('project.board.untitled_card')}
                </button>
                {canEdit && (
                  <IconButton
                    label={t('common.delete')}
                    size="sm"
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={() => {
                      onDelete(subtask.id)
                    }}
                  >
                    <Trash2 size={13} />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        </section>
        <section aria-label={t('project.card.dependencies')} className="space-y-2">
          <SectionHeading icon={Link2} label={t('project.card.dependencies')} />
          <ul className="space-y-1">
            {blockers.map((link) => (
              <li key={link.fromCardId} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{siblings.find((s) => s.id === link.fromCardId)?.title ?? link.fromCardId}</span>
                {canEdit && <IconButton label={t('common.delete')} size="sm" onClick={() => void removeDependency(link.fromCardId)}><Trash2 size={14} /></IconButton>}
              </li>
            ))}
          </ul>
          {canEdit && (
            <div className="flex items-center gap-2">
              <Select className="min-w-0 flex-1" value={blocker} aria-label={t('project.card.add_dependency')} onChange={(event) => setBlocker(event.target.value)}>
                <option value="">{t('project.card.add_dependency')}</option>
                {siblings.filter((s) => s.id !== card.id).map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
              </Select>
              <Button size="sm" disabled={!blocker} onClick={() => void addDependency()}>{t('project.card.add_dependency')}</Button>
            </div>
          )}
        </section>
        <section aria-label={t('project.card.attachments')} className="space-y-2">
          <div className="flex items-center gap-2">
            <SectionHeading icon={Paperclip} label={t('project.card.attachments')} />
            {canEdit && (
              <>
                <input ref={fileInput} type="file" className="hidden" onChange={(event) => { const f = event.target.files?.[0]; if (f) void attachFile(f); event.target.value = '' }} />
                <Button size="sm" icon={<Paperclip size={14} />} onClick={() => fileInput.current?.click()}>{t('project.card.add_attachment')}</Button>
              </>
            )}
          </div>
          <ul className="space-y-1">
            {files.map((file) => (
              <li key={file.id} className="flex items-center gap-2">
                <a className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--accent)]" href={projectFileUrl(file.id)} target="_blank" rel="noreferrer">{file.filename}</a>
                {canEdit && <IconButton label={t('common.delete')} size="sm" onClick={() => { void deleteProjectFile(file.id).then(() => setFiles((current) => current.filter((f) => f.id !== file.id))) }}><Trash2 size={14} /></IconButton>}
              </li>
            ))}
          </ul>
        </section>
        <section aria-label={t('project.card.comments')} className="space-y-2">
          <SectionHeading icon={MessageSquare} label={t('project.card.comments')} />
          <ul className="space-y-2">
            {comments.map((comment) => (
              <li key={comment.id} className="rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-3 py-2">
                <div className="flex items-center gap-2">
                  <p className="min-w-0 flex-1 truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{comment.authorId}</p>
                  {canEdit && comment.authorId === currentUserId && editingCommentId !== comment.id && (
                    <>
                      <IconButton label={t('project.card.edit_comment')} size="sm" onClick={() => { setEditingCommentId(comment.id); setEditDraft(comment.body) }}><Pencil size={13} /></IconButton>
                      <IconButton label={t('common.delete')} size="sm" onClick={() => void removeComment(comment.id)}><Trash2 size={13} /></IconButton>
                    </>
                  )}
                </div>
                {editingCommentId === comment.id
                  ? (
                    <div className="space-y-2">
                      <Textarea className="w-full" rows={2} value={editDraft} aria-label={t('project.card.edit_comment')} onChange={(event) => setEditDraft(event.target.value)} />
                      <div className="flex gap-2">
                        <Button size="sm" variant="primary" disabled={!editDraft.trim()} onClick={() => void saveCommentEdit()}>{t('common.save')}</Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingCommentId(null)}>{t('common.cancel')}</Button>
                      </div>
                    </div>
                  )
                  : <p className="whitespace-pre-wrap text-[length:var(--text-13)] text-[var(--text-primary)]">{comment.body}</p>}
              </li>
            ))}
          </ul>
          <form
            className="space-y-2"
            onSubmit={(event) => { event.preventDefault(); void postComment() }}
          >
            <Textarea
              className="w-full"
              rows={2}
              value={commentDraft}
              placeholder={t('project.card.comment_placeholder')}
              aria-label={t('project.card.comment_placeholder')}
              onChange={(event) => setCommentDraft(event.target.value)}
            />
            <Button type="submit" variant="primary" size="sm" disabled={posting || !commentDraft.trim()}>
              {t('project.card.post_comment')}
            </Button>
          </form>
        </section>
      </div>
    </Modal>
  )
}
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type ReactElement } from 'react'
import { Archive, AtSign, Bell, CheckSquare, ChevronDown, ChevronUp, Copy, FileText, GripVertical, Link2, ListTodo, MessageSquare, Minus, MoreHorizontal, Paperclip, Pencil, Plus, Repeat, SlidersHorizontal, Sparkles, Trash2, Type, type LucideIcon } from 'lucide-react'
import type { ProjectAttachment, ProjectBoardMember, ProjectCard, ProjectCardLink, ProjectComment, ProjectContent, ProjectPeople, ProjectProperty } from '@shared/project/model'
import { isProjectCardDone, projectDonePatch, projectPersonLabel } from '@shared/project/model'
import { moveContentOrder } from '@shared/project/content-order'
import { t, useLocale } from '../../lib/i18n'
import { Avatar, Button, IconButton } from '../../components/primitives'
import { Checkbox, commitOnEnter, Input, Textarea } from '../../components/form'
import { SelectMenu } from '../../components/select-menu'
import { confirm, Menu, Modal, prompt, type MenuItem } from '../../components/overlay'
import { sendForAnswerDetailed } from '../chat/editor-ai'
import { addCardLink, createCardComment, createCardContent, createProjectCard, deleteCardContent, deleteCardComment, deleteProjectFile, duplicateProjectCard, fetchCardComments, fetchCardDetail, fetchCardLinks, listBoardFiles, patchCardContent, patchCardComment, patchProjectCard, projectFileUrl, removeCardLink, saveCardAsTemplate, uploadBoardFile } from './api'
import { PropertyValueEditor } from './PropertyValueEditor'
import { RecurrenceEditor } from './RecurrenceEditor'
import { useBandDrag } from './views/use-band-drag'
import { useUi } from '../../store/ui'
import { useSession } from '../../store/session'
import { useProjectWatch } from './use-watch'

interface CardDialogProps {
  card: ProjectCard
  properties: ProjectProperty[]
  members: ProjectBoardMember[]
  people: ProjectPeople
  contents: ProjectContent[]
  siblings: ProjectCard[]
  canEdit: boolean
  detailTruncated?: boolean
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

export function CardDialog({ card, properties, members, people, contents, siblings, canEdit, detailTruncated, onClose, onUpdated, onRefresh, onDelete, onOpenCard }: CardDialogProps): ReactElement {
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
  const mentionAnchor = useRef<HTMLButtonElement>(null)
  const [mentionOpen, setMentionOpen] = useState(false)
  const toast = useUi((state) => state.toast)
  const currentUserId = useSession((state) => state.user?.id)
  const watch = useProjectWatch('card', card.id)
  const locale = useLocale()
  const answerIn = locale === 'zh-CN' ? 'Answer in Simplified Chinese.' : 'Answer in English.'
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    try {
      await action()
    } catch (reason) {
      toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
    }
  }, [toast])

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

  const [aiSplitting, setAiSplitting] = useState(false)
  const splitSubtasksWithAi = async () => {
    if (aiSplitting || !card.title.trim()) return
    setAiSplitting(true)
    try {
      const context = blocks.filter((b) => b.title).map((b) => b.title).join('\n')
      const promptText = `${answerIn} Break down the following project task into 3 to 5 concise actionable subtask titles. Return ONLY the subtask titles, one per line, without numbering, bullets, asterisks or markdown prefixes:\nTask: ${card.title}${context ? `\nContext:\n${context}` : ''}`
      const res = await sendForAnswerDetailed(promptText)
      if (res.status === 'ok') {
        const lines = res.text
          .split('\n')
          .map((l) => l.replace(/^[-*•0-9.)\s]+/, '').trim())
          .filter(Boolean)
        await Promise.all(lines.map((subTitle) => createProjectCard(card.boardId, { title: subTitle, parentId: card.id })))
        onRefresh()
      } else {
        toast({ title: t('project.card.ai_split_failed'), tone: 'danger' })
      }
    } catch {
      toast({ title: t('project.card.ai_split_failed'), tone: 'danger' })
    } finally {
      setAiSplitting(false)
    }
  }

  const summarizeCardWithAi = async () => {
    try {
      const parts = [
        `Card title: ${card.title}`,
        blocks.length ? `Content:\n${blocks.map((b) => `- ${b.title}`).join('\n')}` : '',
        comments.length ? `Comments:\n${comments.map((c) => `- ${c.body}`).join('\n')}` : '',
      ].filter(Boolean).join('\n\n')
      const promptText = `${answerIn} Summarize the following card and its discussion into a concise 2-3 sentence overview:\n${parts}`
      const res = await sendForAnswerDetailed(promptText)
      if (res.status === 'ok') {
        const comment = await createCardComment(card.id, `🤖 ${t('project.card.ai_summary_heading')}\n${res.text}`)
        setComments((current) => [...current, comment])
      } else {
        toast({ title: t('project.card.ai_summarize_failed'), tone: 'danger' })
      }
    } catch {
      toast({ title: t('project.card.ai_summarize_failed'), tone: 'danger' })
    }
  }

  useEffect(() => {
    fetchCardLinks(card.id).then(setLinks).catch(() => setLinks([]))
    listBoardFiles(card.boardId, card.id).then(setFiles).catch(() => setFiles([]))
  }, [card.id, card.boardId])

  const attachFile = async (file: File) => {
    await run(async () => {
      const uploaded = await uploadBoardFile(card.boardId, file, card.id)
      setFiles((current) => [uploaded, ...current])
    })
  }

  useEffect(() => { setTitle(card.title) }, [card.title])
  useEffect(() => {
    if (detailTruncated) return
    setBlocks((current) => {
      const incoming = new Map(contents.map((block) => [block.id, block]))
      const known = new Set(current.map((block) => block.id))
      let changed = false
      const next = current
        .filter((block) => incoming.has(block.id))
        .map((block) => {
          const fresh = incoming.get(block.id)!
          if (fresh.updateAt === block.updateAt) return block
          changed = true
          return fresh
        })
      for (const block of contents) {
        if (known.has(block.id)) continue
        next.push(block)
        changed = true
      }
      return changed ? next : current
    })
  }, [contents, detailTruncated])
  useEffect(() => {
    const controller = new AbortController()
    fetchCardComments(card.id, controller.signal)
      .then(setComments)
      .catch(() => { if (!controller.signal.aborted) setComments([]) })
    return () => controller.abort()
  }, [card.id])
  useEffect(() => {
    if (!detailTruncated) return
    const controller = new AbortController()
    fetchCardDetail(card.id, controller.signal)
      .then((detail) => {
        if (controller.signal.aborted) return
        setBlocks(detail.contents)
        setComments(detail.comments)
      })
      .catch(() => { /* best-effort: the bundle copy stays on screen */ })
    return () => controller.abort()
  }, [card.id, detailTruncated])

  const patch = useCallback(async (body: Record<string, unknown>) => {
    const updated = await patchProjectCard(card.id, body)
    onUpdated(updated)
  }, [card.id, onUpdated])

  const commitTitle = () => {
    if (title !== card.title) void run(() => patch({ title }))
  }

  const postComment = async () => {
    const body = commentDraft.trim()
    if (!body || posting) return
    setPosting(true)
    try {
      await run(async () => {
        const comment = await createCardComment(card.id, body)
        setComments((current) => [...current, comment])
        setCommentDraft('')
      })
    } finally {
      setPosting(false)
    }
  }

  const saveCommentEdit = async () => {
    if (!editingCommentId) return
    const body = editDraft.trim()
    if (!body) return
    await run(async () => {
      const updated = await patchCardComment(editingCommentId, body)
      setComments((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)))
      setEditingCommentId(null)
    })
  }
  const removeComment = async (id: string) => {
    const ok = await confirm({ title: t('project.card.delete_comment'), tone: 'danger', confirmLabel: t('common.delete') })
    if (!ok) return
    await run(async () => {
      await deleteCardComment(id)
      setComments((current) => current.filter((entry) => entry.id !== id))
    })
  }
  const pasteImage = async (event: ClipboardEvent) => {
    if (!canEdit) return
    const image = [...event.clipboardData.files].find((file) => file.type.startsWith('image/'))
    if (!image) return
    event.preventDefault()
    await run(async () => {
      const uploaded = await uploadBoardFile(card.boardId, image, card.id)
      const block = await createCardContent(card.id, { type: 'image', title: image.name, fields: { attachmentId: uploaded.id } })
      setFiles((current) => [uploaded, ...current])
      setBlocks((current) => [...current, block])
    })
  }

  const addBlock = async (type: ProjectContent['type']) => {
    let title = ''
    if (type === 'text') {
      const entered = await prompt({ title: t('project.card.text_block'), confirmLabel: t('project.card.add_content') })
      if (entered === null) return
      title = entered
    }
    await run(async () => {
      const block = await createCardContent(card.id, { type, title, fields: type === 'checkbox' ? { checked: false } : {} })
      setBlocks((current) => [...current, block])
    })
  }

  const toggleBlock = async (block: ProjectContent, checked: boolean) => {
    await run(async () => {
      const updated = await patchCardContent(block.id, { fields: { ...block.fields, checked } })
      setBlocks((current) => current.map((entry) => (entry.id === block.id ? updated : entry)))
    })
  }

  const removeBlock = async (block: ProjectContent) => {
    const ok = await confirm({ title: t('project.card.delete_block'), tone: 'danger', confirmLabel: t('common.delete') })
    if (!ok) return
    await run(async () => {
      await deleteCardContent(block.id)
      setBlocks((current) => current.filter((entry) => entry.id !== block.id))
    })
  }
  const reorderBlock = async (id: string, targetId: string, where: 'before' | 'after') => {
    await run(async () => {
      const newOrder = moveContentOrder(card.contentOrder, id, targetId, where)
      const updated = await patchProjectCard(card.id, { contentOrder: newOrder })
      onUpdated(updated)
      const flat = newOrder.flat()
      setBlocks((current) => [...current].sort((a, b) => flat.indexOf(a.id) - flat.indexOf(b.id)))
    })
  }
  const blocksRef = useRef<HTMLDivElement>(null)
  const blockDrag = useBandDrag({
    enabled: canEdit,
    axis: 'y',
    measure: () => [...(blocksRef.current?.querySelectorAll<HTMLElement>('[data-content-id]') ?? [])].map((node) => {
      const rect = node.getBoundingClientRect()
      return { id: node.dataset.contentId ?? '', from: rect.top, to: rect.bottom }
    }),
    onDrop: (source, target) => {
      const forwards = blocks.findIndex((block) => block.id === source) < blocks.findIndex((block) => block.id === target)
      void reorderBlock(source, target, forwards ? 'after' : 'before')
    },
  })
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

  const breadcrumbs = useMemo(() => {
    const trail: ProjectCard[] = []
    let curr = card.parentId ? siblings.find((s) => s.id === card.parentId) : undefined
    const seen = new Set<string>([card.id])
    while (curr && !seen.has(curr.id)) {
      seen.add(curr.id)
      trail.unshift(curr)
      const parentId: string | undefined = curr.parentId
      curr = parentId ? siblings.find((s) => s.id === parentId) : undefined
    }
    return trail
  }, [card.id, card.parentId, siblings])

  const subtasks = siblings.filter((sibling) => sibling.parentId === card.id)
  const subtaskDone = subtasks.filter((s) => isProjectCardDone(s, properties)).length
  const toggleSubtask = async (subtask: ProjectCard, checked: boolean) => {
    const values = projectDonePatch(properties, checked)
    if (!values) return
    await run(async () => {
      await patchProjectCard(subtask.id, { values })
      onRefresh()
    })
  }
  const blockers = links.filter((link) => link.toCardId === card.id && link.kind === 'blocks')

  const addSubtask = async () => {
    const name = await prompt({ title: t('project.card.add_subtask'), confirmLabel: t('project.card.add_subtask') })
    if (name === null || !name.trim()) return
    await run(async () => {
      await createProjectCard(card.boardId, { title: name.trim(), parentId: card.id })
      onRefresh()
    })
  }
  const addDependency = async () => {
    if (!blocker) return
    await run(async () => {
      await addCardLink(blocker, card.id, 'blocks')
      setLinks(await fetchCardLinks(card.id))
      setBlocker('')
    })
  }
  const removeDependency = async (fromId: string) => {
    await run(async () => {
      await removeCardLink(fromId, card.id, 'blocks')
      setLinks(await fetchCardLinks(card.id))
    })
  }

  return (
    <Modal open onClose={onClose} title={card.title || t('project.board.untitled_card')} width={980}>
      <div className="flex flex-col gap-4 md:flex-row" data-card-detail={card.id}>
      <div className="min-w-0 flex-1 space-y-4">
        {breadcrumbs.length > 0 && (
          <nav aria-label={t('project.card.subtasks')} className="flex flex-wrap items-center gap-1.5 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {breadcrumbs.map((ancestor) => (
              <Fragment key={ancestor.id}>
                <button
                  type="button"
                  className="truncate font-medium text-[var(--text-secondary)] hover:text-[var(--accent)] hover:underline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                  onClick={() => onOpenCard?.(ancestor.id)}
                >
                  {ancestor.title || t('project.board.untitled_card')}
                </button>
                <span aria-hidden="true">/</span>
              </Fragment>
            ))}
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
            <Button size="sm" variant="ghost" onClick={() => { void run(async () => { await saveCardAsTemplate(card.id); onRefresh() }) }}>{t('project.card.save_as_template')}</Button>
          )}
          <Button size="sm" variant={watch.watching ? 'primary' : 'ghost'} icon={<Bell size={14} />} onClick={() => { void watch.toggle() }}>
            {watch.watching ? t('project.watch.off') : t('project.watch.on')}
          </Button>
          <IconButton ref={menuAnchor} label={t('project.card.menu')} size="sm" onClick={() => setMenuOpen(true)}>
            <MoreHorizontal size={15} />
          </IconButton>
          <Menu
            anchor={menuAnchor}
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            label={t('project.card.menu')}
            items={[
              ...(canEdit ? [
                { id: 'duplicate', label: t('project.card.duplicate'), icon: <Copy size={15} />, onSelect: () => { void duplicateCard() } },
                { id: 'ai-summarize', label: t('project.card.ai_summarize'), icon: <Sparkles size={15} />, onSelect: () => { void summarizeCardWithAi() } },
              ] : []),
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
                  card={card}
                  value={card.values[property.id] ?? ''}
                  members={members}
                  people={people}
                  disabled={!canEdit}
                  onChange={(value) => void run(() => patch({ values: { [property.id]: value } }))}
                />
              </div>
            </div>
          ))}
        </section>
        <section aria-label={t('project.card.recurrence')} className="space-y-2">
          <SectionHeading icon={Repeat} label={t('project.card.recurrence')} />
          <RecurrenceEditor value={card.recurrence} disabled={!canEdit} onChange={(rule) => void run(() => patch({ recurrence: rule }))} />
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
          <div className="space-y-2" ref={blocksRef}>
            {blocks.map((block) => (
              <div
                key={block.id}
                className="flex items-start gap-2"
                data-project-content={block.id}
                data-content-id={block.id}
                data-drop-target={blockDrag.overId === block.id && blockDrag.draggingId !== block.id}
                data-dragging={blockDrag.draggingId === block.id}
              >
                {canEdit && (
                  <button
                    type="button"
                    className="pv-block-grip"
                    data-content-grip={block.id}
                    aria-label={t('project.card.drag_block', { title: block.title || t('project.card.checkbox_block') })}
                    onPointerDown={(event) => blockDrag.start(event, block.id)}
                  >
                    <GripVertical size={13} aria-hidden="true" />
                  </button>
                )}
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
            {canEdit && (
              <>
                <Button size="sm" icon={<Plus size={14} />} onClick={() => void addSubtask()}>{t('project.card.add_subtask')}</Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Sparkles size={14} />}
                  disabled={aiSplitting || !card.title.trim()}
                  onClick={() => void splitSubtasksWithAi()}
                >
                  {aiSplitting ? t('project.card.ai_split_loading') : t('project.card.ai_split')}
                </Button>
              </>
            )}
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
            {subtasks.map((subtask) => {
              const isDone = isProjectCardDone(subtask, properties)
              return (
                <li key={subtask.id} className="group flex items-center gap-1.5 text-[length:var(--text-13)] text-[var(--text-primary)]">
                  <Checkbox ariaLabel={subtask.title || t('project.board.untitled_card')} checked={isDone} disabled={!canEdit} onChange={(checked) => void toggleSubtask(subtask, checked)} />
                  <button
                    type="button"
                    className={`min-w-0 flex-1 truncate text-left hover:text-[var(--accent)] hover:underline focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${isDone ? 'text-[var(--text-tertiary)] line-through' : ''}`}
                    onClick={() => onOpenCard?.(subtask.id)}
                  >
                    {subtask.title || t('project.board.untitled_card')}
                  </button>
                  {canEdit && (
                    <IconButton
                      label={t('common.delete')}
                      size="sm"
                      className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => {
                        onDelete(subtask.id)
                      }}
                    >
                      <Trash2 size={13} />
                    </IconButton>
                  )}
                </li>
              )
            })}
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
              <SelectMenu className="min-w-0 flex-1" value={blocker} label={t('project.card.add_dependency')} searchable onChange={setBlocker} options={[{ value: '', label: t('project.card.add_dependency') }, ...siblings.filter((s) => s.id !== card.id && !blockers.some((b) => b.fromCardId === s.id)).map((s) => ({ value: s.id, label: s.title }))]} />
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
                {canEdit && (
                  <IconButton
                    label={t('common.delete')}
                    size="sm"
                    onClick={() => {
                      void run(async () => {
                        const ok = await confirm({ title: t('project.card.delete_attachment'), tone: 'danger', confirmLabel: t('common.delete') })
                        if (!ok) return
                        await deleteProjectFile(file.id)
                        setFiles((current) => current.filter((f) => f.id !== file.id))
                      })
                    }}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
      <div className="min-w-0 flex-1 space-y-2 border-t border-[var(--border-subtle)] pt-4 md:border-l md:border-t-0 md:pl-4 md:pt-0">
        <section aria-label={t('project.card.comments')} className="space-y-2">
          <SectionHeading icon={MessageSquare} label={t('project.card.comments')} />
          {comments.length === 0 && (
            <p className="rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-3 py-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.card.comments_empty')}</p>
          )}
          <ul className="space-y-2">
            {comments.map((comment) => (
              <li key={comment.id} className="rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-3 py-2">
                <div className="flex items-center gap-2">
                  <Avatar src={people[comment.authorId]?.avatarUrl} name={projectPersonLabel(people, comment.authorId)} size={18} />
                  <p className="min-w-0 flex-1 truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{projectPersonLabel(people, comment.authorId)}</p>
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
                  setCommentDraft((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}@${projectPersonLabel(people, member.userId)} `)
                },
              }))}
            />
            <Button type="submit" variant="primary" size="sm" disabled={posting || !commentDraft.trim()}>
              {t('project.card.post_comment')}
            </Button>
          </form>
        </section>
      </div>
    </div>
    </Modal>
  )
}
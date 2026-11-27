import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type ReactElement } from 'react'
import { Archive, Bell, CheckSquare, ChevronDown, ChevronUp, Copy, FileText, GripVertical, History, Link2, Minus, MoreHorizontal, Pencil, Plus, Repeat, SlidersHorizontal, Sparkles, Trash2, Type, type LucideIcon } from 'lucide-react'
import type { ProjectAttachment, ProjectBoardMember, ProjectCard, ProjectCardLink, ProjectComment, ProjectContent, ProjectPeople, ProjectProperty } from '@shared/project/model'
import { isProjectCardDone, projectDonePatch, projectPersonLabel } from '@shared/project/model'
import { projectInputToStamp, projectStampToInput } from '@shared/project/date'
import { moveContentOrder, type ProjectContentOrder } from '@shared/project/content-order'
import { t, useLocale } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, commitOnEnter, Input, Textarea } from '../../components/form'
import { SelectMenu } from '../../components/select-menu'
import { confirm, Menu, Modal, prompt, type MenuItem } from '../../components/overlay'
import { MarkdownBody } from '../preview/MarkdownBody'
import { sendForAnswerDetailed } from '../chat/editor-ai'
import { addCardLink, createCardComment, createCardContent, createProjectCard, deleteCardContent, deleteCardComment, deleteProjectFile, duplicateProjectCard, fetchCardComments, fetchCardDetail, fetchCardLinks, listBoardFiles, moveCardContent, patchCardContent, patchCardComment, patchProjectCard, projectFileUrl, removeCardLink, saveCardAsTemplate, undeleteCardContent, uploadBoardFile } from './api'
import { PropertyValueEditor } from './PropertyValueEditor'
import { RecurrenceEditor } from './RecurrenceEditor'
import { CardTimeTracker } from './CardTimeTracker'
import { useBandDrag } from './views/use-band-drag'
import { useUi } from '../../store/ui'
import { useSession } from '../../store/session'
import { useProjectWatch } from './use-watch'
import type { UndoCommand } from './undo'
import { CardAttachmentsSection, CardCommentsSection, CardDependenciesSection, CardSubtasksSection } from './CardDialogSections'
import { PROJECT_REALTIME_EVENT, type ProjectRealtimeDetail } from './realtime-events'
import { CardVersionsDialog } from './CardVersionsDialog'
import { CardNotesSection } from './CardNotesSection'
import { CardCalendarLinksSection } from './CardCalendarLinksSection'
import { CardExternalLinksSection } from './CardExternalLinksSection'

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
  onPatchCard?: (id: string, patch: Record<string, unknown>) => Promise<ProjectCard | void>
  onCommand?: (command: UndoCommand) => void
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

export function CardDialog({ card, properties, members, people, contents, siblings, canEdit, detailTruncated, onClose, onUpdated, onRefresh, onDelete, onOpenCard, onPatchCard, onCommand }: CardDialogProps): ReactElement {
  const cardRef = useRef(card)
  cardRef.current = card
  const [title, setTitle] = useState(card.title)
  const [comments, setComments] = useState<ProjectComment[] | null>(null)
  const [commentsError, setCommentsError] = useState(false)
  const [commentsAttempt, setCommentsAttempt] = useState(0)
  const [commentDraft, setCommentDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [blocks, setBlocks] = useState<ProjectContent[]>(contents)
  const [links, setLinks] = useState<ProjectCardLink[] | null>(null)
  const [linksError, setLinksError] = useState(false)
  const [linksAttempt, setLinksAttempt] = useState(0)
  const [files, setFiles] = useState<ProjectAttachment[] | null>(null)
  const [filesError, setFilesError] = useState(false)
  const [filesAttempt, setFilesAttempt] = useState(0)
  const [detailError, setDetailError] = useState(false)
  const [detailAttempt, setDetailAttempt] = useState(0)
  const [blocker, setBlocker] = useState('')
  const addAnchor = useRef<HTMLButtonElement>(null)
  const [addOpen, setAddOpen] = useState(false)
  const menuAnchor = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const toast = useUi((state) => state.toast)
  const currentUserId = useSession((state) => state.user?.id)
  const watch = useProjectWatch('card', card.id)
  const locale = useLocale()
  const answerIn = locale === 'zh-CN' ? 'Answer in Simplified Chinese.' : 'Answer in English.'
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null)
  const [blockDraft, setBlockDraft] = useState('')
  const [checklistEdit, setChecklistEdit] = useState<{ id: string, title: string, assigneeId: string, dueAt: string, dueInvalid: boolean } | null>(null)

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

  const [aiSummarizing, setAiSummarizing] = useState(false)
  const summarizeCardWithAi = async () => {
    if (aiSummarizing) return
    setAiSummarizing(true)
    try {
      const parts = [
        `Card title: ${card.title}`,
        blocks.length ? `Content:\n${blocks.map((b) => `- ${b.title}`).join('\n')}` : '',
        comments?.length ? `Comments:\n${comments.map((c) => `- ${c.body}`).join('\n')}` : '',
      ].filter(Boolean).join('\n\n')
      const promptText = `${answerIn} Summarize the following card and its discussion into a concise 2-3 sentence overview:\n${parts}`
      const res = await sendForAnswerDetailed(promptText)
      if (res.status === 'ok') {
        const comment = await createCardComment(card.id, `🤖 ${t('project.card.ai_summary_heading')}\n${res.text}`)
        setComments((current) => [...(current ?? []), comment])
      } else {
        toast({ title: t('project.card.ai_summarize_failed'), tone: 'danger' })
      }
    } catch {
      toast({ title: t('project.card.ai_summarize_failed'), tone: 'danger' })
    } finally {
      setAiSummarizing(false)
    }
  }

  useEffect(() => {
    let alive = true
    setLinks(null)
    setLinksError(false)
    fetchCardLinks(card.id)
      .then((list) => { if (alive) setLinks(list) })
      .catch(() => { if (alive) setLinksError(true) })
    return () => { alive = false }
  }, [card.id, linksAttempt])

  useEffect(() => {
    let alive = true
    setFiles(null)
    setFilesError(false)
    listBoardFiles(card.boardId, card.id)
      .then((list) => { if (alive) setFiles(list) })
      .catch(() => { if (alive) setFilesError(true) })
    return () => { alive = false }
  }, [card.id, card.boardId, filesAttempt])

  const attachFile = async (file: File) => {
    await run(async () => {
      await uploadBoardFile(card.boardId, file, card.id)
      setFiles(await listBoardFiles(card.boardId, card.id))
      setFilesError(false)
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
    if (detailTruncated) return
    const controller = new AbortController()
    setComments(null)
    setCommentsError(false)
    fetchCardComments(card.id, controller.signal)
      .then(setComments)
      .catch(() => { if (!controller.signal.aborted) setCommentsError(true) })
    return () => controller.abort()
  }, [card.id, commentsAttempt, detailTruncated])
  useEffect(() => {
    const onProjectChange = (event: Event): void => {
      const detail = (event as CustomEvent<ProjectRealtimeDetail>).detail
      if (detail?.boardId === card.boardId && detail.entity === 'comment') {
        setCommentsAttempt((current) => current + 1)
      }
    }
    window.addEventListener(PROJECT_REALTIME_EVENT, onProjectChange)
    return () => window.removeEventListener(PROJECT_REALTIME_EVENT, onProjectChange)
  }, [card.boardId])
  useEffect(() => {
    if (!detailTruncated) return
    const controller = new AbortController()
    setDetailError(false)
    fetchCardDetail(card.id, controller.signal)
      .then((detail) => {
        if (controller.signal.aborted) return
        setBlocks(detail.contents)
        setComments(detail.comments)
        setCommentsError(false)
      })
      .catch(() => { if (!controller.signal.aborted) setDetailError(true) })
    return () => controller.abort()
  }, [card.id, detailTruncated, detailAttempt])

  const patch = useCallback(async (body: Record<string, unknown>) => {
    const updated = onPatchCard
      ? await onPatchCard(card.id, body)
      : await patchProjectCard(card.id, body)
    if (updated) onUpdated(updated)
  }, [card.id, onPatchCard, onUpdated])

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
        setComments((current) => [...(current ?? []), comment])
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
      setComments((current) => (current ?? []).map((entry) => (entry.id === updated.id ? updated : entry)))
      setEditingCommentId(null)
    })
  }
  const removeComment = async (id: string) => {
    const ok = await confirm({ title: t('project.card.delete_comment'), tone: 'danger', confirmLabel: t('common.delete') })
    if (!ok) return
    await run(async () => {
      await deleteCardComment(id)
      setComments((current) => (current ?? []).filter((entry) => entry.id !== id))
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
      setFiles(await listBoardFiles(card.boardId, card.id))
      setFilesError(false)
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
      const input = { type, title, fields: type === 'checkbox' ? { checked: false } : {} }
      const block = await createCardContent(card.id, input)
      let targetId = block.id
      setBlocks((current) => [...current, block])
      onCommand?.({
        undo: async () => { await deleteCardContent(targetId); setBlocks((current) => current.filter((entry) => entry.id !== targetId)); onRefresh() },
        redo: async () => { const restored = await createCardContent(card.id, input); targetId = restored.id; setBlocks((current) => [...current, restored]); onRefresh() },
      })
    })
  }

  const toggleBlock = async (block: ProjectContent, checked: boolean) => {
    const previous = block.fields
    const next = { ...block.fields, checked }
    await run(async () => {
      const updated = await patchCardContent(block.id, { fields: next })
      setBlocks((current) => current.map((entry) => (entry.id === block.id ? updated : entry)))
      onCommand?.({
        undo: async () => { const restored = await patchCardContent(block.id, { fields: previous }); setBlocks((current) => current.map((entry) => (entry.id === block.id ? restored : entry))) },
        redo: async () => { const reapplied = await patchCardContent(block.id, { fields: next }); setBlocks((current) => current.map((entry) => (entry.id === block.id ? reapplied : entry))) },
      })
    })
  }

  const editBlock = (block: ProjectContent) => {
    setEditingBlockId(block.id)
    setBlockDraft(block.title)
  }

  const saveBlockEdit = async (block: ProjectContent) => {
    const title = blockDraft
    const previous = block.title
    setEditingBlockId(null)
    await run(async () => {
      const updated = await patchCardContent(block.id, { title })
      setBlocks((current) => current.map((entry) => (entry.id === block.id ? updated : entry)))
      onCommand?.({
        undo: async () => { const restored = await patchCardContent(block.id, { title: previous }); setBlocks((current) => current.map((entry) => (entry.id === block.id ? restored : entry))) },
        redo: async () => { const reapplied = await patchCardContent(block.id, { title }); setBlocks((current) => current.map((entry) => (entry.id === block.id ? reapplied : entry))) },
      })
    })
  }

  const editChecklist = (block: ProjectContent) => {
    setChecklistEdit({
      id: block.id,
      title: block.title,
      assigneeId: block.fields.assigneeId ?? '',
      dueAt: block.fields.dueAt === undefined ? '' : projectStampToInput(block.fields.dueAt, false, 'UTC'),
      dueInvalid: false,
    })
  }
  const saveChecklistEdit = async () => {
    const draft = checklistEdit
    const block = blocks.find((entry) => entry.id === draft?.id)
    if (!draft || !block) return
    const dueAt = draft.dueAt ? projectInputToStamp(draft.dueAt, false, 'UTC') : null
    if (draft.dueInvalid || (draft.dueAt && dueAt === null)) {
      toast({ title: t('project.card.invalid_due_date'), tone: 'danger' })
      return
    }
    const fields = { ...block.fields, assigneeId: draft.assigneeId || undefined, dueAt: dueAt ?? undefined }
    setChecklistEdit(null)
    await run(async () => {
      const updated = await patchCardContent(block.id, { title: draft.title, fields })
      setBlocks((current) => current.map((entry) => entry.id === block.id ? updated : entry))
      onCommand?.({
        undo: async () => { const restored = await patchCardContent(block.id, { title: block.title, fields: block.fields }); setBlocks((current) => current.map((entry) => entry.id === block.id ? restored : entry)) },
        redo: async () => { const reapplied = await patchCardContent(block.id, { title: draft.title, fields }); setBlocks((current) => current.map((entry) => entry.id === block.id ? reapplied : entry)) },
      })
    })
  }

  const removeBlock = async (block: ProjectContent) => {
    const ok = await confirm({ title: t('project.card.delete_block'), tone: 'danger', confirmLabel: t('common.delete') })
    if (!ok) return
    await run(async () => {
      const previousOrder = cardRef.current.contentOrder
      await deleteCardContent(block.id)
      setBlocks((current) => current.filter((entry) => entry.id !== block.id))
      onCommand?.({
        undo: async () => {
          await undeleteCardContent(block.id)
          await patchProjectCard(card.id, { contentOrder: previousOrder })
          setBlocks((current) => [...current.filter((entry) => entry.id !== block.id), block]
            .toSorted((a, b) => previousOrder.flat().indexOf(a.id) - previousOrder.flat().indexOf(b.id)))
          onUpdated({ ...cardRef.current, contentOrder: previousOrder })
          onRefresh()
        },
        redo: async () => { await deleteCardContent(block.id); setBlocks((current) => current.filter((entry) => entry.id !== block.id)); onRefresh() },
      })
    })
  }
  const reorderBlock = async (id: string, targetId: string, where: 'before' | 'after') => {
    await run(async () => {
      const order = moveContentOrder(card.contentOrder, id, targetId, where)
      const previousOrder = card.contentOrder
      await moveCardContent(id, targetId, where)
      onUpdated({ ...cardRef.current, contentOrder: order })
      const applyOrder = (next: ProjectContentOrder): void => {
        const flat = next.flat()
        setBlocks((current) => current.toSorted((a, b) => flat.indexOf(a.id) - flat.indexOf(b.id)))
        onUpdated({ ...cardRef.current, contentOrder: next })
      }
      onCommand?.({
        undo: async () => { await patchProjectCard(card.id, { contentOrder: previousOrder }); applyOrder(previousOrder) },
        redo: async () => { await patchProjectCard(card.id, { contentOrder: order }); applyOrder(order) },
      })
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
      if (onPatchCard) await onPatchCard(subtask.id, { values })
      else await patchProjectCard(subtask.id, { values })
      onRefresh()
    })
  }
  const blockers = (links ?? []).filter((link) => link.toCardId === card.id && link.kind === 'blocks')

  const attachedBlock = (block: ProjectContent): ReactElement => {
    if (filesError) return <p className="text-[length:var(--text-12)] text-[var(--danger)]">{t('project.common.load_failed')}</p>
    if (files === null) return <p role="status" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('common.loading')}</p>
    const attachmentId = block.fields.attachmentId
    if (attachmentId && files.some((file) => file.id === attachmentId)) {
      return block.type === 'image'
        ? <img src={projectFileUrl(attachmentId)} alt={block.title} className="max-h-64 rounded-[var(--r-sm)]" />
        : <a className="text-[length:var(--text-13)] text-[var(--accent)]" href={projectFileUrl(attachmentId)} target="_blank" rel="noreferrer">{block.title}</a>
    }
    return <ArchivedFile />
  }

  const renderBlockBody = (block: ProjectContent): ReactElement => {
    if (block.type === 'checkbox') {
      if (checklistEdit?.id === block.id) return (
        <div className="space-y-2">
          <Input value={checklistEdit.title} aria-label={t('project.card.checkbox_block')} onChange={(event) => setChecklistEdit((current) => current ? { ...current, title: event.target.value } : current)} />
          <SelectMenu
            label={t('project.card.checklist_assignee')}
            value={checklistEdit.assigneeId}
            onChange={(assigneeId) => setChecklistEdit((current) => current ? { ...current, assigneeId } : current)}
            options={[{ value: '', label: t('project.card.checklist_unassigned') }, ...members.map((member) => ({ value: member.userId, label: projectPersonLabel(people, member.userId) }))]}
          />
          <Input
            type="date"
            value={checklistEdit.dueAt}
            aria-label={t('project.card.checklist_due')}
            aria-invalid={checklistEdit.dueInvalid}
            onChange={(event) => {
              const value = event.currentTarget.value
              const dueInvalid = event.currentTarget.validity.badInput
              setChecklistEdit((current) => current ? { ...current, dueAt: value, dueInvalid } : current)
            }}
          />
          {checklistEdit.dueInvalid && <p role="alert" className="text-[length:var(--text-11)] text-[var(--danger)]">{t('project.card.invalid_due_date')}</p>}
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={() => void saveChecklistEdit()}>{t('common.save')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setChecklistEdit(null)}>{t('common.cancel')}</Button>
          </div>
        </div>
      )
      return (
        <div className="min-w-0 space-y-1">
          <Checkbox label={block.title || t('project.card.checkbox_block')} checked={block.fields.checked === true} disabled={!canEdit} onChange={(checked) => void toggleBlock(block, checked)} />
          {(block.fields.assigneeId || block.fields.dueAt !== undefined) && (
            <p className="pl-8 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {block.fields.assigneeId ? projectPersonLabel(people, block.fields.assigneeId) : t('project.card.checklist_unassigned')}
              {block.fields.dueAt !== undefined ? ` · ${projectStampToInput(block.fields.dueAt, false, 'UTC')}` : ''}
            </p>
          )}
        </div>
      )
    }
    if (block.type === 'divider') return <hr className="border-[var(--border-subtle)]" />
    if (block.type === 'image' || block.type === 'attachment') return attachedBlock(block)
    if (editingBlockId === block.id) return (
      <div className="space-y-2">
        <Textarea className="w-full" rows={3} value={blockDraft} aria-label={t('project.card.edit_content')} onChange={(event) => setBlockDraft(event.target.value)} />
        <div className="flex gap-2">
          <Button size="sm" variant="primary" onClick={() => void saveBlockEdit(block)}>{t('common.save')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setEditingBlockId(null)}>{t('common.cancel')}</Button>
        </div>
      </div>
    )
    if (block.type === 'text') return <MarkdownBody source={block.title} className="text-[length:var(--text-13)]" />
    return <p className="whitespace-pre-wrap text-[length:var(--text-13)] text-[var(--text-primary)]">{block.title}</p>
  }

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
      setLinksError(false)
      setBlocker('')
    })
  }
  const removeDependency = async (fromId: string) => {
    await run(async () => {
      await removeCardLink(fromId, card.id, 'blocks')
      setLinks(await fetchCardLinks(card.id))
      setLinksError(false)
    })
  }

  return (
    <>
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
        {detailError && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-[length:var(--text-12)] text-[var(--danger)]">
            {t('project.common.load_failed')}
            <Button size="sm" variant="ghost" onClick={() => setDetailAttempt((current) => current + 1)}>{t('project.common.retry')}</Button>
          </div>
        )}
        <div className="flex items-center gap-1">
          {canEdit && (
            <Button size="sm" variant="ghost" onClick={() => { void run(async () => { await saveCardAsTemplate(card.id); onRefresh() }) }}>{t('project.card.save_as_template')}</Button>
          )}
          <Button size="sm" variant={watch.watching ? 'primary' : 'ghost'} icon={<Bell size={14} />} disabled={watch.status !== 'ready'} onClick={() => { void watch.toggle() }}>
            {watch.watching ? t('project.watch.off') : t('project.watch.on')}
          </Button>
          {watch.status === 'error' && (
            <span role="alert" className="flex items-center gap-1">
              <span className="text-[length:var(--text-11)] text-[var(--danger)]">{t('project.common.load_failed')}</span>
              <Button size="sm" variant="ghost" onClick={watch.retry}>{t('project.common.retry')}</Button>
            </span>
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
              { id: 'versions', label: t('common.version_history'), icon: <History size={15} />, onSelect: () => setShowVersions(true) },
              ...(canEdit ? [
                { id: 'duplicate', label: t('project.card.duplicate'), icon: <Copy size={15} />, onSelect: () => { void duplicateCard() } },
                { id: 'ai-summarize', label: t(aiSummarizing ? 'project.card.ai_summarizing' : 'project.card.ai_summarize'), icon: <Sparkles size={15} />, disabled: aiSummarizing, onSelect: () => { void summarizeCardWithAi() } },
              ] : []),
              { id: 'copy-link', label: t('project.card.copy_link'), icon: <Link2 size={15} />, onSelect: () => { void copyLink() } },
              ...(canEdit ? [{ id: 'delete', label: t('project.board.delete_card'), icon: <Trash2 size={15} />, tone: 'danger' as const, separatorBefore: true, onSelect: () => { onClose(); onDelete(card.id) } }] : []),
            ] as MenuItem[]}
          />
        </div>
        <section aria-label={t('project.card.properties')} className="space-y-2">
          <SectionHeading icon={SlidersHorizontal} label={t('project.card.properties')} />
          {properties.length === 0 && <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.value.empty')}</p>}
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
          {blocks.length === 0 && <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.value.empty')}</p>}
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
                    aria-pressed={blockDrag.keyboardDragId === block.id}
                    onPointerDown={(event) => blockDrag.start(event, block.id)}
                    onKeyDown={(event) => blockDrag.onKeyDown(event, block.id)}
                  >
                    <GripVertical size={13} aria-hidden="true" />
                    <span className="sr-only">{t('project.view.keyboard_drag_help')}</span>
                  </button>
                )}
                <div className="min-w-0 flex-1">{renderBlockBody(block)}</div>
                {canEdit && (
                  <>
                    {(block.type === 'text' || block.type === 'checkbox') && (
                      <IconButton label={t(block.type === 'checkbox' ? 'project.card.edit_checklist' : 'project.card.edit_content')} size="sm" onClick={() => block.type === 'checkbox' ? editChecklist(block) : editBlock(block)}><Pencil size={14} /></IconButton>
                    )}
                    <IconButton label={t('project.card.move_up')} size="sm" onClick={() => moveBlock(block, 'up')}><ChevronUp size={14} /></IconButton>
                    <IconButton label={t('project.card.move_down')} size="sm" onClick={() => moveBlock(block, 'down')}><ChevronDown size={14} /></IconButton>
                    <IconButton label={t('common.delete')} size="sm" onClick={() => void removeBlock(block)}><Trash2 size={14} /></IconButton>
                  </>
                )}
              </div>
            ))}
          </div>
        </section>
        <CardSubtasksSection
          subtasks={subtasks}
          properties={properties}
          doneCount={subtaskDone}
          canEdit={canEdit}
          canAiSplit={Boolean(card.title.trim())}
          aiSplitting={aiSplitting}
          onToggle={(subtask, checked) => void toggleSubtask(subtask, checked)}
          onOpen={(id) => onOpenCard?.(id)}
          onDelete={onDelete}
          onAdd={() => void addSubtask()}
          onAiSplit={() => void splitSubtasksWithAi()}
        />
        <CardDependenciesSection
          links={links}
          error={linksError}
          onRetry={() => setLinksAttempt((current) => current + 1)}
          blockers={blockers}
          siblings={siblings}
          cardId={card.id}
          canEdit={canEdit}
          blocker={blocker}
          onBlockerChange={setBlocker}
          onAdd={() => void addDependency()}
          onRemove={(id) => void removeDependency(id)}
        />
        <CardNotesSection cardId={card.id} canEdit={canEdit} />
        <CardCalendarLinksSection cardId={card.id} properties={properties} canEdit={canEdit} />
        <CardExternalLinksSection boardId={card.boardId} cardId={card.id} canEdit={canEdit} />
        <CardAttachmentsSection
          files={files}
          error={filesError}
          onRetry={() => setFilesAttempt((current) => current + 1)}
          canEdit={canEdit}
          onAttach={(file) => void attachFile(file)}
          onDelete={(id) => void run(async () => {
            const ok = await confirm({ title: t('project.card.delete_attachment'), tone: 'danger', confirmLabel: t('common.delete') })
            if (!ok) return
            await deleteProjectFile(id)
            setFiles((current) => (current ?? []).filter((file) => file.id !== id))
          })}
        />
      </div>
      <div className="min-w-0 flex-1 space-y-2 border-t border-[var(--border-subtle)] pt-4 md:border-l md:border-t-0 md:pl-4 md:pt-0">
        <CardTimeTracker cardId={card.id} canEdit={canEdit} />
        <CardCommentsSection
          comments={comments}
          error={commentsError}
          onRetry={() => setCommentsAttempt((current) => current + 1)}
          draft={commentDraft}
          onDraftChange={setCommentDraft}
          posting={posting}
          onPost={() => void postComment()}
          editingId={editingCommentId}
          onStartEdit={(id, body) => { setEditingCommentId(id); setEditDraft(body) }}
          editDraft={editDraft}
          onEditDraftChange={setEditDraft}
          onSaveEdit={() => void saveCommentEdit()}
          onCancelEdit={() => setEditingCommentId(null)}
          onDelete={(id) => void removeComment(id)}
          onMention={(name) => setCommentDraft((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}@${name} `)}
          members={members}
          people={people}
          currentUserId={currentUserId}
          canEdit={canEdit}
        />
      </div>
    </div>
    </Modal>
    {showVersions && (
      <CardVersionsDialog
        cardId={card.id}
        cardTitle={card.title || t('project.board.untitled_card')}
        expectedUpdateAt={card.updateAt}
        canEdit={canEdit}
        onClose={() => setShowVersions(false)}
        onRestored={(updated) => {
          onUpdated(updated)
          onRefresh()
          setShowVersions(false)
          onClose()
        }}
      />
    )}
    </>
  )
}
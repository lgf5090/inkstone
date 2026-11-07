import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { CheckSquare, Minus, Plus, Trash2, Type } from 'lucide-react'
import type { ProjectBoardMember, ProjectCard, ProjectComment, ProjectContent, ProjectProperty } from '@shared/project/model'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, Input, Textarea } from '../../components/form'
import { Menu, Modal, prompt, type MenuItem } from '../../components/overlay'
import { createCardComment, createCardContent, deleteCardContent, fetchCardComments, patchCardContent, patchProjectCard } from './api'
import { PropertyValueEditor } from './PropertyValueEditor'

interface CardDialogProps {
  card: ProjectCard
  properties: ProjectProperty[]
  members: ProjectBoardMember[]
  contents: ProjectContent[]
  canEdit: boolean
  onClose: () => void
  onUpdated: (card: ProjectCard) => void
}

export function CardDialog({ card, properties, members, contents, canEdit, onClose, onUpdated }: CardDialogProps): ReactElement {
  const [title, setTitle] = useState(card.title)
  const [comments, setComments] = useState<ProjectComment[]>([])
  const [commentDraft, setCommentDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [blocks, setBlocks] = useState<ProjectContent[]>(contents)
  const addAnchor = useRef<HTMLButtonElement>(null)
  const [addOpen, setAddOpen] = useState(false)

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

  const contentMenu: MenuItem[] = [
    { id: 'text', label: t('project.card.text_block'), icon: <Type size={15} />, onSelect: () => void addBlock('text') },
    { id: 'checkbox', label: t('project.card.checkbox_block'), icon: <CheckSquare size={15} />, onSelect: () => void addBlock('checkbox') },
    { id: 'divider', label: t('project.card.divider_block'), icon: <Minus size={15} />, onSelect: () => void addBlock('divider') },
  ]

  return (
    <Modal open onClose={onClose} title={card.title || t('project.board.untitled_card')} width={640}>
      <div className="space-y-4">
        <Input
          className="w-full"
          value={title}
          disabled={!canEdit}
          aria-label={t('project.board.title_column')}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={(event) => { if (event.key === 'Enter') commitTitle() }}
        />
        <section aria-label={t('project.card.properties')} className="space-y-2">
          <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{t('project.card.properties')}</h3>
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
        <section aria-label={t('project.card.content')} className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{t('project.card.content')}</h3>
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
              <div key={block.id} className="flex items-start gap-2" data-project-content={block.id}>
                <div className="min-w-0 flex-1">
                  {block.type === 'checkbox'
                    ? <Checkbox label={block.title || t('project.card.checkbox_block')} checked={block.fields.checked === true} disabled={!canEdit} onChange={(checked) => void toggleBlock(block, checked)} />
                    : block.type === 'divider'
                      ? <hr className="border-[var(--border-subtle)]" />
                      : <p className="whitespace-pre-wrap text-[length:var(--text-13)] text-[var(--text-primary)]">{block.title}</p>}
                </div>
                {canEdit && (
                  <IconButton label={t('common.delete')} size="sm" onClick={() => void removeBlock(block)}><Trash2 size={14} /></IconButton>
                )}
              </div>
            ))}
          </div>
        </section>
        <section aria-label={t('project.card.comments')} className="space-y-2">
          <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{t('project.card.comments')}</h3>
          <ul className="space-y-2">
            {comments.map((comment) => (
              <li key={comment.id} className="rounded-[var(--r-sm)] bg-[var(--bg-subtle)] px-3 py-2">
                <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{comment.authorId}</p>
                <p className="whitespace-pre-wrap text-[length:var(--text-13)] text-[var(--text-primary)]">{comment.body}</p>
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
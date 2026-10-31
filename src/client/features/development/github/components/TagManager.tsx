import { useMemo, useState } from 'react'
import { Check, Pencil, Plus, Tag as TagIcon, Trash2, X } from 'lucide-react'
import type { GithubTag } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { isImeComposing } from '../../../../lib/ime'
import { Button, IconButton } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { Modal, confirm } from '../../../../components/overlay'
import { SelectMenu } from '../../../../components/select-menu'
import { TagColorPicker } from './TagColorPicker'
import { collectTagDescendants } from '../lib/tags'

const ROOT = '__root__'

export function TagManager({
  open,
  onClose,
  tags,
  title,
  description,
  onAdd,
  onUpdate,
  onDelete,
}: {
  open: boolean
  onClose: () => void
  tags: GithubTag[]
  title: string
  description?: string
  onAdd: (name: string, color: string, parentId: string | null) => void
  onUpdate: (id: string, patch: { name: string; color: string; parentId: string | null }) => void
  onDelete: (id: string) => void
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState('#64748b')
  const [parentId, setParentId] = useState(ROOT)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('#64748b')
  const [editParentId, setEditParentId] = useState(ROOT)

  const parentOptions = useMemo(() => [
    { value: ROOT, label: t('development.github.tags.top_level') },
    ...tags.map((tag) => ({ value: tag.id, label: tag.name })),
  ], [tags])

  const editParentOptions = useMemo(() => {
    const excluded = new Set(editingId ? collectTagDescendants(tags, editingId) : [])
    return [
      { value: ROOT, label: t('development.github.tags.top_level') },
      ...tags.filter((tag) => !excluded.has(tag.id)).map((tag) => ({ value: tag.id, label: tag.name })),
    ]
  }, [tags, editingId])

  const addDuplicate = useMemo(() => {
    const trimmed = name.trim().toLowerCase()
    if (!trimmed) return false
    const targetParent = parentId === ROOT ? null : parentId
    return tags.some((tag) =>
      (tag.parentId ?? null) === targetParent && tag.name.trim().toLowerCase() === trimmed)
  }, [name, parentId, tags])

  const add = () => {
    const trimmed = name.trim()
    if (!trimmed || addDuplicate) return
    onAdd(trimmed, color, parentId === ROOT ? null : parentId)
    setName('')
    setParentId(ROOT)
  }

  const startEdit = (tag: GithubTag) => {
    setEditingId(tag.id)
    setEditName(tag.name)
    setEditColor(tag.color)
    setEditParentId(tag.parentId ?? ROOT)
  }

  const saveEdit = () => {
    if (!editingId) return
    const trimmed = editName.trim()
    if (!trimmed) return
    onUpdate(editingId, { name: trimmed, color: editColor, parentId: editParentId === ROOT ? null : editParentId })
    setEditingId(null)
  }

  const remove = async (tag: GithubTag) => {
    const descendants = collectTagDescendants(tags, tag.id).length - 1
    const ok = await confirm({
      title: t('development.github.tags.delete_title'),
      description: descendants > 0
        ? t('development.github.tags.delete_with_children', { name: tag.name, count: descendants })
        : t('development.github.tags.delete_confirm', { name: tag.name }),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (ok) onDelete(tag.id)
  }

  return (
    <Modal open={open} onClose={onClose} title={title} description={description} width={720}>
      <div className="space-y-4">
        <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3">
          <h3 className="mb-2 flex items-center gap-1.5 text-[length:var(--text-13)] font-medium">
            <TagIcon size={14} /> {t('development.github.tags.create_new')}
          </h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('development.github.tags.name_placeholder')} className="h-8" onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === 'Enter') add() }} />
            <SelectMenu value={parentId} options={parentOptions} onChange={setParentId} label={t('development.github.tags.top_level')} size="sm" searchable />
          </div>
          <div className="mt-2">
            <TagColorPicker value={color} onChange={setColor} />
          </div>
          <Button size="sm" className="mt-2" onClick={add} disabled={!name.trim() || addDuplicate}>
            <Plus size={14} /> {t('development.github.tags.add')}
          </Button>
          {addDuplicate && <p role="alert" className="mt-1 text-[length:var(--text-11)] text-[var(--danger)]">{t('development.github.tags.duplicate')}</p>}
        </div>

        <div>
          <h3 className="mb-2 text-[length:var(--text-13)] font-medium">
            {t('development.github.tags.existing', { count: tags.length })}
          </h3>
          {tags.length === 0 ? (
            <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('development.github.tags.empty')}
            </p>
          ) : (
            <div className="space-y-1">
              {tags.map((tag) => {
                const parent = tag.parentId ? tags.find((entry) => entry.id === tag.parentId) : null
                const editing = editingId === tag.id
                return (
                  <div key={tag.id} className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-3 py-2 text-[length:var(--text-12)]">
                    {editing ? (
                      <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <div className="flex items-center gap-2">
                          <Input autoFocus value={editName} onChange={(event) => setEditName(event.target.value)} className="h-7 flex-1" onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === 'Enter') saveEdit(); if (event.key === 'Escape') setEditingId(null) }} />
                          <IconButton label={t('common.save')} size="sm" onClick={saveEdit}><Check size={14} /></IconButton>
                          <IconButton label={t('common.cancel')} size="sm" onClick={() => setEditingId(null)}><X size={14} /></IconButton>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <SelectMenu value={editParentId} options={editParentOptions} onChange={setEditParentId} label={t('development.github.tags.top_level')} size="sm" searchable width={200} className="h-7 w-40" />
                          <TagColorPicker value={editColor} onChange={setEditColor} />
                        </div>
                      </div>
                    ) : (
                      <>
                        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
                        <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                        {parent && <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">/ {parent.name}</span>}
                        <IconButton label={t('common.edit')} size="sm" onClick={() => startEdit(tag)}><Pencil size={13} /></IconButton>
                        <IconButton label={t('common.delete')} size="sm" onClick={() => void remove(tag)}><Trash2 size={13} /></IconButton>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

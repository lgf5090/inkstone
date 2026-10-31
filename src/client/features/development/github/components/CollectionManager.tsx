import { useMemo, useState } from 'react'
import { Check, Layers, Pencil, Plus, Trash2, X } from 'lucide-react'
import type { GithubCollection } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { isImeComposing } from '../../../../lib/ime'
import { Button, IconButton } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { Modal, confirm } from '../../../../components/overlay'

export function CollectionManager({
  open,
  onClose,
  collections,
  onAdd,
  onUpdate,
  onDelete,
}: {
  open: boolean
  onClose: () => void
  collections: GithubCollection[]
  onAdd: (name: string, description: string) => void
  onUpdate: (id: string, patch: { name: string; description: string }) => void
  onDelete: (id: string) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')

  const normalizedName = name.trim().toLowerCase()
  const duplicate = useMemo(
    () => Boolean(normalizedName) && collections.some((collection) => collection.name.trim().toLowerCase() === normalizedName),
    [collections, normalizedName],
  )

  const add = () => {
    if (!name.trim() || duplicate) return
    onAdd(name.trim(), description.trim())
    setName('')
    setDescription('')
  }

  const startEdit = (collection: GithubCollection) => {
    setEditingId(collection.id)
    setEditName(collection.name)
    setEditDescription(collection.description)
  }

  const saveEdit = () => {
    if (!editingId) return
    const trimmed = editName.trim()
    if (!trimmed) return
    const clash = collections.some((collection) =>
      collection.id !== editingId && collection.name.trim().toLowerCase() === trimmed.toLowerCase())
    if (clash) return
    onUpdate(editingId, { name: trimmed, description: editDescription.trim() })
    setEditingId(null)
  }

  const remove = async (collection: GithubCollection) => {
    const ok = await confirm({
      title: t('development.github.collections.delete_title'),
      description: t('development.github.collections.delete_confirm', { name: collection.name }),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (ok) onDelete(collection.id)
  }

  return (
    <Modal open={open} onClose={onClose} title={t('development.github.collections.manage')} description={t('development.github.collections.manage_desc')} width={640}>
      <div className="space-y-4">
        <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3">
          <h3 className="mb-2 flex items-center gap-1.5 text-[length:var(--text-13)] font-medium"><Layers size={14} /> {t('development.github.collections.create_new')}</h3>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('development.github.collections.name_placeholder')} className="h-8" onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === 'Enter') add() }} />
          <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t('development.github.collections.description_placeholder')} className="mt-2 h-8" onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === 'Enter') add() }} />
          <Button size="sm" className="mt-2" onClick={add} disabled={!name.trim() || duplicate}><Plus size={14} /> {t('development.github.collections.add')}</Button>
          {duplicate && <p role="alert" className="mt-1 text-[length:var(--text-11)] text-[var(--danger)]">{t('development.github.collections.duplicate')}</p>}
        </div>

        <div>
          <h3 className="mb-2 text-[length:var(--text-13)] font-medium">{t('development.github.collections.existing', { count: collections.length })}</h3>
          {collections.length === 0 ? (
            <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('development.github.collections.empty')}</p>
          ) : (
            <div className="space-y-1">
              {collections.map((collection) => {
                const editing = editingId === collection.id
                return (
                  <div key={collection.id} className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-3 py-2 text-[length:var(--text-12)]">
                    {editing ? (
                      <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <div className="flex items-center gap-2">
                          <Input autoFocus value={editName} onChange={(event) => setEditName(event.target.value)} className="h-7 flex-1" onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === 'Enter') saveEdit(); if (event.key === 'Escape') setEditingId(null) }} />
                          <IconButton label={t('common.save')} size="sm" onClick={saveEdit}><Check size={14} /></IconButton>
                          <IconButton label={t('common.cancel')} size="sm" onClick={() => setEditingId(null)}><X size={14} /></IconButton>
                        </div>
                        <Input value={editDescription} onChange={(event) => setEditDescription(event.target.value)} placeholder={t('development.github.collections.description_placeholder')} className="h-7" />
                      </div>
                    ) : (
                      <>
                        <Layers size={13} className="shrink-0 text-[var(--text-tertiary)]" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{collection.name}</div>
                          {collection.description && <div className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{collection.description}</div>}
                        </div>
                        <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.github.collections.member_count', { count: collection.repoIds.length })}</span>
                        <IconButton label={t('common.edit')} size="sm" onClick={() => startEdit(collection)}><Pencil size={13} /></IconButton>
                        <IconButton label={t('common.delete')} size="sm" onClick={() => void remove(collection)}><Trash2 size={13} /></IconButton>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.github.collections.members_hint')}</p>
      </div>
    </Modal>
  )
}

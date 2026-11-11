import { useMemo, useState } from 'react'
import { Check, Layers, Pencil, Plus, Trash2, X } from 'lucide-react'
import type { GithubCollection } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { isImeComposing } from '../../../../lib/ime'
import { Button, IconButton } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { Modal, confirm } from '../../../../components/overlay'
import { SelectMenu } from '../../../../components/select-menu'

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
  onAdd: (name: string, description: string, parentId: string | null) => void
  onUpdate: (id: string, patch: { name: string; description: string; parentId: string | null }) => void
  onDelete: (id: string) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [parentId, setParentId] = useState('ROOT')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editParentId, setEditParentId] = useState('ROOT')
  const [editError, setEditError] = useState<string | null>(null)

  const normalizedName = name.trim().toLowerCase()
  const duplicate = useMemo(
    () => Boolean(normalizedName) && collections.some((collection) => collection.name.trim().toLowerCase() === normalizedName),
    [collections, normalizedName],
  )

  const descendantsOf = (id: string): Set<string> => {
    const result = new Set<string>()
    let grew = true
    while (grew) {
      grew = false
      for (const collection of collections) {
        if (collection.parentId && (collection.parentId === id || result.has(collection.parentId)) && !result.has(collection.id) && collection.id !== id) {
          result.add(collection.id)
          grew = true
        }
      }
    }
    return result
  }

  const parentOptionsFor = (excludeId?: string) => {
    const excluded = excludeId ? new Set([excludeId, ...descendantsOf(excludeId)]) : new Set<string>()
    const byParent = new Map<string | null, GithubCollection[]>()
    for (const collection of collections) {
      if (excluded.has(collection.id)) continue
      const key = collection.parentId
      byParent.set(key, [...(byParent.get(key) ?? []), collection])
    }
    const rows: { value: string; label: string }[] = [{ value: 'ROOT', label: t('development.github.collections.top_level') }]
    const walk = (key: string | null, depth: number) => {
      for (const collection of byParent.get(key) ?? []) {
        rows.push({ value: collection.id, label: `${'— '.repeat(depth)}${collection.name}` })
        walk(collection.id, depth + 1)
      }
    }
    walk(null, 0)
    return rows
  }

  const rootOptions = useMemo(() => parentOptionsFor(), [collections])

  const add = () => {
    if (!name.trim() || duplicate) return
    onAdd(name.trim(), description.trim(), parentId === 'ROOT' ? null : parentId)
    setName('')
    setDescription('')
    setParentId('ROOT')
  }

  const startEdit = (collection: GithubCollection) => {
    setEditingId(collection.id)
    setEditName(collection.name)
    setEditDescription(collection.description)
    setEditParentId(collection.parentId ?? 'ROOT')
    setEditError(null)
  }

  const saveEdit = () => {
    if (!editingId) return
    const trimmed = editName.trim()
    if (!trimmed) return
    const clash = collections.some((collection) =>
      collection.id !== editingId && collection.name.trim().toLowerCase() === trimmed.toLowerCase())
    if (clash) {
      setEditError(t('development.github.collections.duplicate'))
      return
    }
    onUpdate(editingId, { name: trimmed, description: editDescription.trim(), parentId: editParentId === 'ROOT' ? null : editParentId })
    setEditingId(null)
  }

  const remove = async (collection: GithubCollection) => {
    const children = descendantsOf(collection.id)
    const ok = await confirm({
      title: t('development.github.collections.delete_title'),
      description: children.size > 0
        ? t('development.github.collections.delete_confirm_children', { name: collection.name, count: children.size })
        : t('development.github.collections.delete_confirm', { name: collection.name }),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (ok) onDelete(collection.id)
  }

  const depthOf = (collection: GithubCollection): number => {
    let depth = 0
    let cursor = collection
    const seen = new Set<string>()
    while (cursor.parentId && !seen.has(cursor.id)) {
      const parent = collections.find((entry) => entry.id === cursor.parentId)
      if (!parent) break
      seen.add(cursor.id)
      cursor = parent
      depth += 1
    }
    return depth
  }

  return (
    <Modal open={open} onClose={onClose} title={t('development.github.collections.manage')} description={t('development.github.collections.manage_desc')} width={640}>
      <div className="space-y-4">
        <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3">
          <h3 className="mb-2 flex items-center gap-1.5 text-[length:var(--text-13)] font-medium"><Layers size={14} /> {t('development.github.collections.create_new')}</h3>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('development.github.collections.name_placeholder')} className="h-8" onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === 'Enter') add() }} />
          <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t('development.github.collections.description_placeholder')} className="mt-2 h-8" onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === 'Enter') add() }} />
          <SelectMenu
            label={t('development.github.collections.parent')}
            value={parentId}
            options={rootOptions}
            onChange={setParentId}
            size="sm"
            className="mt-2 w-full"
            searchable
          />
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
                          <Input autoFocus value={editName} onChange={(event) => { setEditName(event.target.value); setEditError(null) }} className="h-7 flex-1" onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === 'Enter') saveEdit(); if (event.key === 'Escape') setEditingId(null) }} />
                          <IconButton label={t('common.save')} size="sm" disabled={!editName.trim()} onClick={saveEdit}><Check size={14} /></IconButton>
                          <IconButton label={t('common.cancel')} size="sm" onClick={() => { setEditingId(null); setEditError(null) }}><X size={14} /></IconButton>
                        </div>
                        <Input value={editDescription} onChange={(event) => setEditDescription(event.target.value)} placeholder={t('development.github.collections.description_placeholder')} className="h-7" />
                        <SelectMenu
                          label={t('development.github.collections.parent')}
                          value={editParentId}
                          options={parentOptionsFor(editingId)}
                          onChange={setEditParentId}
                          size="sm"
                          className="w-full"
                          searchable
                        />
                        {editError && <p role="alert" className="text-[length:var(--text-11)] text-[var(--danger)]">{editError}</p>}
                      </div>
                    ) : (
                      <>
                        <span style={{ paddingLeft: `${depthOf(collection) * 14}px` }} />
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

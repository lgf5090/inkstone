import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Pencil, Plus, Trash2, X } from 'lucide-react'
import type { TagNode } from '@shared/development/api-tester/types'
import { DEFAULT_TAG_COLOR } from '@shared/development/api-tester/keywords'
import type { MenuItem } from '../../../../components/overlay'
import { Menu, Modal, confirm } from '../../../../components/overlay'
import { Button, IconButton } from '../../../../components/primitives'
import { Input, commitOnEnter } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { isImeComposing } from '../../../../lib/ime'
import { CHART_COLOR_NAMES, tagColorValue } from '../lib/tag-colors'

function tagPath(tags: readonly TagNode[], id: string): string {
  const byId = new Map(tags.map((tag) => [tag.id, tag]))
  const parts: string[] = []
  let current = byId.get(id)
  while (current) {
    parts.unshift(current.name)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return parts.join(' / ')
}

/** Descendant count from one children map, so a deep tag tree is walked once per delete. */
function descendantCount(tags: readonly TagNode[], id: string): number {
  const children = new Map<string, string[]>()
  for (const tag of tags) {
    if (!tag.parentId) continue
    const list = children.get(tag.parentId) ?? []
    list.push(tag.id)
    children.set(tag.parentId, list)
  }
  const seen = new Set<string>([id])
  const stack = [id]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const child of children.get(current) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      stack.push(child)
    }
  }
  return seen.size - 1
}

function flattenTags(tags: readonly TagNode[]): TagNode[] {
  const children = new Map<string, TagNode[]>()
  const byId = new Map<string, TagNode>()
  for (const tag of tags) {
    byId.set(tag.id, tag)
    if (!tag.parentId) continue
    const list = children.get(tag.parentId) ?? []
    list.push(tag)
    children.set(tag.parentId, list)
  }
  const sort = (list: TagNode[]) => list.sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt - right.createdAt)
  for (const list of children.values()) sort(list)
  const roots = tags.filter((tag) => !tag.parentId || !byId.has(tag.parentId))
  sort(roots)
  const out: TagNode[] = []
  const walk = (tag: TagNode) => {
    out.push(tag)
    for (const child of children.get(tag.id) ?? []) walk(child)
  }
  for (const root of roots) walk(root)
  return out
}

function ColorSwatches({
  value,
  onChange,
  compact,
}: {
  value: string
  onChange: (color: string) => void
  compact?: boolean
}) {
  return (
    <div className={cn('flex max-w-full flex-wrap items-center gap-1', compact && 'max-h-16 w-full overflow-y-auto')}>
      {CHART_COLOR_NAMES.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={color}
          aria-pressed={value === color}
          title={color}
          data-color={color}
          onClick={() => onChange(color)}
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-full',
            value === color && 'ring-2 ring-[var(--accent)] ring-offset-1 ring-offset-[var(--bg-base)]',
          )}
        >
          <span className="size-3.5 rounded-full" style={{ backgroundColor: tagColorValue(color) ?? undefined }} />
        </button>
      ))}
    </div>
  )
}

export function TagManagerDialog({
  open,
  onClose,
  tags,
  onAdd,
  onUpdate,
  onDelete,
}: {
  open: boolean
  onClose: () => void
  tags: TagNode[]
  onAdd: (name: string, color: string, parentId: string | null) => void
  onUpdate: (id: string, patch: Partial<Pick<TagNode, 'name' | 'color' | 'parentId'>>) => void
  onDelete: (id: string) => void
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(DEFAULT_TAG_COLOR)
  const [parentId, setParentId] = useState('')
  const [parentOpen, setParentOpen] = useState(false)
  const parentRef = useRef<HTMLButtonElement>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState<string>(DEFAULT_TAG_COLOR)

  useEffect(() => {
    if (!open) return
    setName('')
    setColor(DEFAULT_TAG_COLOR)
    setParentId('')
    setParentOpen(false)
    setEditingId(null)
  }, [open])

  const ordered = useMemo(() => flattenTags(tags), [tags])

  const parentItems: MenuItem[] = [
    {
      id: 'parent-root',
      label: t('development.apitester.top_level_tag'),
      checked: parentId === '',
      onSelect: () => setParentId(''),
    },
    ...ordered.map((tag) => ({
      id: `parent-${tag.id}`,
      label: tagPath(tags, tag.id),
      checked: parentId === tag.id,
      onSelect: () => setParentId(tag.id),
    })),
  ]

  const add = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    onAdd(trimmed, color, parentId || null)
    setName('')
    setColor(DEFAULT_TAG_COLOR)
    setParentId('')
  }

  const startEdit = (tag: TagNode) => {
    setEditingId(tag.id)
    setEditName(tag.name)
    setEditColor(tag.color)
  }

  const saveEdit = () => {
    if (!editingId) return
    const trimmed = editName.trim()
    if (!trimmed) return
    onUpdate(editingId, { name: trimmed, color: editColor })
    setEditingId(null)
  }

  const remove = async (tag: TagNode) => {
    const children = descendantCount(tags, tag.id)
    const path = tagPath(tags, tag.id)
    const ok = await confirm({
      title: t('development.apitester.delete_tag_title'),
      description:
        children > 0
          ? t('development.apitester.delete_tag_with_children', { name: path, count: children })
          : t('development.apitester.delete_tag_confirm', { name: path }),
      tone: 'danger',
      confirmLabel: t('development.apitester.delete'),
      cancelLabel: t('development.apitester.cancel'),
    })
    if (ok) onDelete(tag.id)
  }

  return (
    <Modal open={open} onClose={onClose} title={t('development.apitester.tag_manager_title')} width={640}>
      <div className="flex max-h-[70vh] min-h-[340px] flex-col gap-3">
        <div className="shrink-0 space-y-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2.5">
          <p className="text-[length:var(--text-11)] font-medium text-[var(--text-primary)]">{t('development.apitester.new_tag')}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => commitOnEnter(event, add)}
              placeholder={t('development.apitester.tag_name_placeholder')}
              aria-label={t('development.apitester.tag_name_placeholder')}
              className="h-8 min-w-[140px] flex-1 text-[length:var(--text-12)]"
            />
            <button
              ref={parentRef}
              type="button"
              aria-label={t('development.apitester.tags')}
              aria-haspopup="menu"
              aria-expanded={parentOpen}
              onClick={() => setParentOpen((value) => !value)}
              className="inline-flex h-8 max-w-[220px] shrink-0 items-center gap-1 rounded-[var(--r-md)] border border-[var(--border-default)] px-2 text-[length:var(--text-11)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            >
              <span className="min-w-0 truncate">{parentId ? tagPath(tags, parentId) : t('development.apitester.top_level_tag')}</span>
              <ChevronDown size={12} className="shrink-0 opacity-60" />
            </button>
            <Menu
              anchor={parentRef}
              open={parentOpen}
              onClose={() => setParentOpen(false)}
              items={parentItems}
              align="end"
              width={240}
              label={t('development.apitester.tags')}
            />
            <Button size="sm" className="shrink-0 gap-1" disabled={!name.trim()} onClick={add}>
              <Plus size={13} /> {t('development.apitester.add')}
            </Button>
          </div>
          <div className="flex items-start gap-2">
            <span className="shrink-0 pt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.apitester.color')}</span>
            <ColorSwatches value={color} onChange={setColor} />
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <p className="mb-1 shrink-0 text-[length:var(--text-11)] font-medium text-[var(--text-primary)]">
            {t('development.apitester.existing_tags', { count: tags.length })}
          </p>
          {tags.length === 0 ? (
            <p className="flex flex-1 items-center justify-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('development.apitester.no_custom_tags')}
            </p>
          ) : (
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain rounded-[var(--r-md)] border border-[var(--border-subtle)] p-1.5">
              {ordered.map((tag) => (
                <div
                  key={tag.id}
                  data-tag-id={tag.id}
                  className={cn(
                    'flex flex-wrap items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2 py-1.5 text-[length:var(--text-12)]',
                    editingId === tag.id && 'ring-1 ring-[var(--accent)]',
                  )}
                >
                  {editingId === tag.id ? (
                    <>
                      <Input
                        value={editName}
                        onChange={(event) => setEditName(event.target.value)}
                        onKeyDown={(event) => {
                          if (isImeComposing(event)) return
                          if (commitOnEnter(event, saveEdit)) return
                          if (event.key === 'Escape') setEditingId(null)
                        }}
                        aria-label={t('development.apitester.rename')}
                        className="h-7 min-w-[120px] flex-1 text-[length:var(--text-12)]"
                      />
                      <ColorSwatches value={editColor} onChange={setEditColor} compact />
                      <IconButton size="xs" label={t('development.apitester.rename')} onClick={saveEdit}>
                        <Check size={12} />
                      </IconButton>
                      <IconButton size="xs" label={t('development.apitester.cancel')} onClick={() => setEditingId(null)}>
                        <X size={12} />
                      </IconButton>
                    </>
                  ) : (
                    <>
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: tagColorValue(tag.color) ?? undefined }}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate font-medium">{tag.name}</span>
                      {tag.parentId && (
                        <span className="min-w-0 max-w-[45%] truncate text-[length:var(--text-10)] text-[var(--text-quaternary)]">
                          / {tagPath(tags, tag.parentId)}
                        </span>
                      )}
                      <IconButton size="xs" label={t('development.apitester.rename')} onClick={() => startEdit(tag)}>
                        <Pencil size={12} />
                      </IconButton>
                      <IconButton
                        size="xs"
                        label={t('development.apitester.delete')}
                        onClick={() => void remove(tag)}
                        className="text-[var(--text-tertiary)] hover:text-[var(--danger)]"
                      >
                        <Trash2 size={12} />
                      </IconButton>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

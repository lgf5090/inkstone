/**
 * The two editors a list and a tag need: a name, and the colour (a list also has an icon).
 *
 * The icon grid and the emoji list are the kanban block's own — the same thirteen icons and forty
 * emoji, offered through the same badge — because a second icon vocabulary would be a second thing
 * for a reader to learn. Colours come from the organiser palette folders and note tags already use.
 */

import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { ORGANIZER_COLORS, organizerColorLabel } from '@shared/organizer-colors'
import { KANBAN_ICONS, KanbanIconBadge } from '../../lib/markdown/kanban/ui/kanban-icon-badge'
import { listIconFor } from './todo-ui'
import { KANBAN_COMMON_EMOJIS } from '../../lib/markdown/kanban/ui/kanban-icon-picker'
import { Button, IconButton } from '../../components/primitives'
import { Input } from '../../components/form'
import { Modal, confirm } from '../../components/overlay'
import { useTodos } from './store'
import type { TaskList, TaskTag } from '@shared/todos/model'

function Swatches({ value, onChange }: { value: string | null; onChange: (color: string) => void }) {
  return (
    <div className="grid grid-cols-8 gap-1.5" role="group" aria-label={t('todo.list.color_label')}>
      {ORGANIZER_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          aria-label={organizerColorLabel(color, t)}
          aria-pressed={value === color}
          className={cn(
            'flex size-8 items-center justify-center rounded-full border-2 transition-transform',
            value === color ? 'border-[var(--text-primary)]' : 'border-transparent',
          )}
          style={{ backgroundColor: color }}
        >
          {value === color && <Check size={13} className="text-white" strokeWidth={3} />}
        </button>
      ))}
    </div>
  )
}

function IconPicker({ value, onChange }: { value: string | null; onChange: (icon: string) => void }) {
  const [tab, setTab] = useState<'icons' | 'emoji'>('icons')
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setTab('icons')}
          aria-pressed={tab === 'icons'}
          className={cn('rounded-[var(--r-sm)] px-2 py-1 text-[length:var(--text-11-5)]', tab === 'icons' ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-tertiary)]')}
        >
          {t('todo.icon.tab_icons')}
        </button>
        <button
          type="button"
          onClick={() => setTab('emoji')}
          aria-pressed={tab === 'emoji'}
          className={cn('rounded-[var(--r-sm)] px-2 py-1 text-[length:var(--text-11-5)]', tab === 'emoji' ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-tertiary)]')}
        >
          {t('todo.icon.tab_emoji')}
        </button>
      </div>
      {tab === 'icons' ? (
        <div className="grid grid-cols-7 gap-1" role="group" aria-label={t('todo.list.icon_label')}>
          {KANBAN_ICONS.map((option) => {
            const icon = `lucide:${option.name}`
            return (
              <button
                key={option.name}
                type="button"
                onClick={() => onChange(icon)}
                aria-label={t(option.labelKey)}
                aria-pressed={value === icon}
                className={cn(
                  'flex size-8 items-center justify-center rounded-[var(--r-sm)]',
                  value === icon ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-hover)]',
                )}
              >
                <KanbanIconBadge icon={icon} size={15} />
              </button>
            )
          })}
        </div>
      ) : (
        <div className="grid max-h-40 grid-cols-8 gap-1 overflow-y-auto" role="group" aria-label={t('todo.list.icon_label')}>
          {KANBAN_COMMON_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onChange(emoji)}
              aria-pressed={value === emoji}
              className={cn('flex size-8 items-center justify-center rounded-[var(--r-sm)] text-[length:var(--text-14)]', value === emoji ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-hover)]')}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function ListEditor({ open, list, onClose }: { open: boolean; list: TaskList | null; onClose: () => void }) {
  const createList = useTodos((state) => state.createList)
  const updateList = useTodos((state) => state.updateList)
  const removeList = useTodos((state) => state.removeList)
  const [name, setName] = useState('')
  const [icon, setIcon] = useState<string | null>(null)
  const [color, setColor] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(list?.name ?? '')
    setIcon(list?.icon ?? null)
    setColor(list?.color ?? ORGANIZER_COLORS[8]!)
  }, [open, list])

  const save = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) return
    if (list) await updateList(list.id, { name: trimmed, icon, color })
    else await createList({ name: trimmed, icon, color })
    onClose()
  }

  const remove = async (): Promise<void> => {
    if (!list) return
    const ok = await confirm({
      title: t('todo.action.delete'),
      description: t('todo.list.delete_hint'),
      confirmLabel: t('todo.action.delete'),
      tone: 'danger',
    })
    if (!ok) return
    await removeList(list.id)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={list ? t('todo.list.edit') : t('todo.list.new')}
      width={440}
      footer={(
        <div className="flex w-full items-center gap-2">
          {list && <Button variant="danger" size="sm" onClick={() => { void remove() }}>{t('todo.action.delete')}</Button>}
          <span className="ml-auto" />
          <Button variant="ghost" size="sm" onClick={onClose}>{t('todo.action.cancel')}</Button>
          <Button size="sm" disabled={!name.trim()} onClick={() => { void save() }}>{t('todo.action.save')}</Button>
        </div>
      )}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <span className="flex size-9 items-center justify-center rounded-[var(--r-md)] bg-[var(--bg-inset)]">
            {listIconFor(icon) ? <KanbanIconBadge icon={listIconFor(icon)} size={18} /> : <span className="size-2 rounded-full" style={{ backgroundColor: color ?? 'var(--accent)' }} />}
          </span>
          <Input
            autoFocus
            value={name}
            placeholder={t('todo.list.name_label')}
            aria-label={t('todo.list.name_label')}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void save() }}
            className="flex-1"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{t('todo.list.color_label')}</span>
          <Swatches value={color} onChange={setColor} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{t('todo.list.icon_label')}</span>
          <IconPicker value={icon} onChange={setIcon} />
          {icon && (
            <IconButton label={t('todo.action.delete')} size="sm" onClick={() => setIcon(null)}>
              <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">×</span>
            </IconButton>
          )}
        </div>
      </div>
    </Modal>
  )
}

export function TagEditor({ open, tag, onClose }: { open: boolean; tag: TaskTag | null; onClose: () => void }) {
  const createTag = useTodos((state) => state.createTag)
  const updateTag = useTodos((state) => state.updateTag)
  const removeTag = useTodos((state) => state.removeTag)
  const [name, setName] = useState('')
  const [color, setColor] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(tag?.name ?? '')
    setColor(tag?.color ?? ORGANIZER_COLORS[10]!)
  }, [open, tag])

  const save = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) return
    if (tag) await updateTag(tag.id, { name: trimmed, color })
    else await createTag({ name: trimmed, color })
    onClose()
  }

  const remove = async (): Promise<void> => {
    if (!tag) return
    const ok = await confirm({
      title: t('todo.action.delete'),
      description: t('todo.tag.delete_hint'),
      confirmLabel: t('todo.action.delete'),
      tone: 'danger',
    })
    if (!ok) return
    await removeTag(tag.id)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tag ? t('todo.tag.edit') : t('todo.tag.new')}
      width={400}
      footer={(
        <div className="flex w-full items-center gap-2">
          {tag && <Button variant="danger" size="sm" onClick={() => { void remove() }}>{t('todo.action.delete')}</Button>}
          <span className="ml-auto" />
          <Button variant="ghost" size="sm" onClick={onClose}>{t('todo.action.cancel')}</Button>
          <Button size="sm" disabled={!name.trim()} onClick={() => { void save() }}>{t('todo.action.save')}</Button>
        </div>
      )}
    >
      <div className="flex flex-col gap-4">
        <Input
          autoFocus
          value={name}
          placeholder={t('todo.tag.name_label')}
          aria-label={t('todo.tag.name_label')}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void save() }}
        />
        <div className="flex flex-col gap-1.5">
          <span className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{t('todo.tag.color_label')}</span>
          <Swatches value={color} onChange={setColor} />
        </div>
      </div>
    </Modal>
  )
}

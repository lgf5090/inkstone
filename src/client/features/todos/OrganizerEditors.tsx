/**
 * The two editors a list and a tag need: a name, a colour, and — for a list — an icon.
 *
 * The colour ramp is the app's own (`ORGANIZER_COLORS`), drawn with the shared `Swatch` the folder,
 * tag and QuickAdd panels already use, and the custom-colour wheel is the shared `ColorWheelTrigger`,
 * so a list does not invent a second way to pick a colour. The icon grid is the to-do app's own
 * registry (`list-icons.tsx`), with the notebook's emoji catalogue behind its second tab.
 *
 * The header is a live preview rather than a label: a list is recognised by its circle long before its
 * name is read, so the reader sees exactly what the sidebar and the board will draw.
 */
import { useEffect, useRef, useState } from 'react'
import { Ban, ListChecks, Palette, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import {
  ORGANIZER_COLORS,
  ORGANIZER_CLASSIC_COUNT,
  isCustomOrganizerColor,
  isOrganizerColorVisible,
  isResolvedOrganizerColor,
  organizerColorContrast,
  organizerColorLabel,
} from '@shared/organizer-colors'
import { Swatch } from '../../components/color-swatch'
import { ColorWheelTrigger } from '../../components/color-field'
import { paintedSurface } from '../../lib/format-colors'
import { Button, IconButton } from '../../components/primitives'
import { Input } from '../../components/form'
import { Modal, confirm } from '../../components/overlay'
import { useTodos } from './store'
import { ListIcon } from './list-icons'
import { ListIconPicker } from './ListIconPicker'
import { DEFAULT_LIST_COLOR, DEFAULT_TAG_COLOR } from './todo-ui'
import type { TaskList, TaskTag } from '@shared/todos/model'

/** The two halves of the ramp, drawn under their own labels. */
const CLASSIC_COLORS = ORGANIZER_COLORS.slice(0, ORGANIZER_CLASSIC_COUNT)
const BRIGHT_COLORS = ORGANIZER_COLORS.slice(ORGANIZER_CLASSIC_COUNT)

/**
 * The colour picker both editors share.
 *
 * A custom hex is offered only when it can be told apart from the surface it will sit on: a tag paints
 * its name in its own colour, so a near-white pick would be a tag nobody can read. The guard is the
 * folder panel's, pointed at this panel's own background.
 */
function ColorPicker({ value, onChange, allowNone }: {
  value: string | null
  onChange: (color: string | null) => void
  /** Tags may carry no colour at all; a list always has one. */
  allowNone: boolean
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState('')
  const [refused, setRefused] = useState(false)
  const surface = (): string => paintedSurface(panelRef.current, isResolvedOrganizerColor)

  const offer = (hex: string): void => {
    const next = hex.toLocaleLowerCase()
    if (!isCustomOrganizerColor(next)) return
    if (!isOrganizerColorVisible(next, surface())) {
      setDraft(next)
      setRefused(true)
      return
    }
    setRefused(false)
    onChange(next)
  }

  const custom = value && isCustomOrganizerColor(value) ? value : null
  const ratio = custom ? organizerColorContrast(custom, surface()) : null

  const group = (labelKey: 'todo.list.color_classic' | 'todo.list.color_bright', colors: readonly string[]) => (
    <div className="flex flex-col gap-1.5">
      <span className="text-[length:var(--text-10-5)] font-medium uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
        {t(labelKey)}
      </span>
      <div role="group" aria-label={t(labelKey)} className="grid grid-cols-8 gap-1.5">
        {colors.map((color) => (
          <Swatch
            key={color}
            color={color}
            background={color}
            label={organizerColorLabel(color, t)}
            active={value === color}
            onPick={() => { setRefused(false); onChange(color) }}
          />
        ))}
      </div>
    </div>
  )

  return (
    <div ref={panelRef} className="flex flex-col gap-3">
      {allowNone && (
        <div className="flex items-center gap-2">
          <Swatch
            color={null}
            icon={<Ban size={13} />}
            label={t('todo.list.no_color')}
            active={value === null}
            onPick={() => { setRefused(false); onChange(null) }}
          />
          <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('todo.list.no_color')}</span>
        </div>
      )}
      {group('todo.list.color_classic', CLASSIC_COLORS)}
      {group('todo.list.color_bright', BRIGHT_COLORS)}
      <div className="flex items-center gap-1.5">
        <ColorWheelTrigger
          shape="round"
          label={t('color.custom')}
          value={custom ?? (draft || null)}
          onChange={(next) => setDraft(next)}
          onCommit={offer}
        />
        <input
          type="text"
          value={draft || custom || ''}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => offer(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') { event.preventDefault(); offer(event.currentTarget.value) }
          }}
          placeholder="#rrggbb"
          spellCheck={false}
          autoComplete="off"
          aria-label={t('todo.list.color_custom')}
          className={cn(
            'h-9 min-w-0 flex-1 rounded-[var(--r-sm)] border bg-[var(--bg-inset)] px-2 font-mono text-[length:var(--text-11-5)] uppercase text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)] md:h-7',
            refused ? 'border-[var(--danger)]' : 'border-[var(--border-subtle)] focus:border-[var(--accent)]',
          )}
        />
        {custom && (
          <IconButton label={t('todo.list.color_clear')} size="sm" onClick={() => { setDraft(''); setRefused(false); onChange(null) }}>
            <X size={12} />
          </IconButton>
        )}
      </div>
      <p className={cn('text-[length:var(--text-11)] leading-snug', refused ? 'text-[var(--danger)]' : 'text-[var(--text-quaternary)]')}>
        {refused
          ? t('color.contrast_too_low')
          : ratio !== null
            ? t('color.contrast_ratio_value0', { value0: ratio.toFixed(1) })
            : t('todo.list.color_hint')}
      </p>
    </div>
  )
}

/** The circle a list wears in the sidebar and on the board, at the size the dialog can show it. */
function ListPreview({ name, icon, color }: { name: string; icon: string | null; color: string | null }) {
  const tint = color ?? 'var(--accent)'
  return (
    <div className="flex items-center gap-3">
      <span
        className="flex size-12 shrink-0 items-center justify-center rounded-full"
        style={{ backgroundColor: `color-mix(in oklab, ${tint} 14%, transparent)`, color: tint }}
        aria-hidden="true"
      >
        {icon ? <ListIcon icon={icon} size={22} className="shrink-0" /> : <ListChecks size={22} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[length:var(--text-14)] font-medium text-[var(--text-primary)]">
          {name.trim() || t('todo.list.name_label')}
        </p>
        <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('todo.list.preview_hint')}</p>
      </div>
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
    setColor(list?.color ?? DEFAULT_LIST_COLOR)
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
      width={480}
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
        <ListPreview name={name} icon={icon} color={color} />
        <Input
          autoFocus
          value={name}
          placeholder={t('todo.list.name_label')}
          aria-label={t('todo.list.name_label')}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void save() }}
        />
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{t('todo.list.color_label')}</span>
            <span className="flex items-center gap-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
              <Palette size={11} aria-hidden="true" />
              {color ? organizerColorLabel(color, t) : t('todo.list.no_color')}
            </span>
          </div>
          <ColorPicker value={color} onChange={setColor} allowNone />
        </section>
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{t('todo.list.icon_label')}</span>
            {icon && (
              <IconButton label={t('todo.list.icon_clear')} size="sm" onClick={() => setIcon(null)}>
                <X size={12} />
              </IconButton>
            )}
          </div>
          <ListIconPicker value={icon} onChange={setIcon} />
        </section>
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
    setColor(tag?.color ?? DEFAULT_TAG_COLOR)
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
      width={420}
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
        <div className="flex items-center gap-2">
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-[var(--r-md)] text-[length:var(--text-14)] font-medium"
            style={{
              color: color ?? 'var(--text-tertiary)',
              backgroundColor: `color-mix(in oklab, ${color ?? 'var(--text-tertiary)'} 12%, transparent)`,
            }}
            aria-hidden="true"
          >
            #
          </span>
          <Input
            autoFocus
            value={name}
            placeholder={t('todo.tag.name_label')}
            aria-label={t('todo.tag.name_label')}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void save() }}
            className="flex-1"
          />
        </div>
        <section className="flex flex-col gap-2">
          <span className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{t('todo.tag.color_label')}</span>
          <ColorPicker value={color} onChange={setColor} allowNone />
        </section>
      </div>
    </Modal>
  )
}

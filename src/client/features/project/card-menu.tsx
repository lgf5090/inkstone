/**
 * The card's right-click menu, built once so the board, the table, the list and the gallery all offer
 * the same actions.
 *
 * A menu that only opens and deletes is a menu the reader stops using. The edits they reach for most —
 * rename, status, priority, a date — belong here as one click each, with the destructive action last
 * and behind a separator.
 */
import { CalendarClock, CheckSquare, Copy, FileText, Link2, ListTodo, Pencil, Pin, Star, Trash2 } from 'lucide-react'
import type { ProjectCard, ProjectProperty } from '@shared/project/model'
import { isProjectCardDone } from '@shared/project/model'
import { projectDayToStamp } from '@shared/project/date'
import { projectPriorityProperty } from '@shared/project/stats'
import { projectOptionCssColor } from '@shared/project/option-color'
import { t } from '../../lib/i18n'
import { prompt, submenuFor, type MenuItem } from '../../components/overlay'
import { optionDot } from './CardBadges'

export interface CardMenuContext {
  card: ProjectCard
  properties: readonly ProjectProperty[]
  groupById?: string
  datePropertyId?: string
  canEdit: boolean
  publicView: boolean
  starred: boolean
  pinned: boolean
  onOpen: (id: string) => void
  onPatchCard: (id: string, patch: Record<string, unknown>) => Promise<void>
  onAddSubtask: (parentId: string) => Promise<void>
  onDuplicate: (id: string) => void
  onCopyLink: (id: string) => void
  onDelete: (id: string) => void
  onToggleDone: (card: ProjectCard, done: boolean) => Promise<void>
  onToggleStar: (id: string) => void
  onTogglePin: (id: string) => void
}

function nextMonday(): Date {
  const day = new Date()
  day.setDate(day.getDate() + ((8 - day.getDay()) % 7 || 7))
  return day
}

export function buildCardMenu(ctx: CardMenuContext): MenuItem[] {
  const { card, properties, canEdit } = ctx
  const done = isProjectCardDone(card, properties)
  const groupProperty = properties.find((property) => property.id === ctx.groupById) ?? properties.find((property) => property.type === 'select')
  const priorityProperty = projectPriorityProperty(properties)
  const dateProperty = properties.find((property) => property.id === ctx.datePropertyId) ?? properties.find((property) => property.type === 'date')

  const items: MenuItem[] = [
    { id: 'open', label: t('project.card.open'), icon: <FileText size={14} />, onSelect: () => ctx.onOpen(card.id) },
    {
      id: 'rename',
      label: t('project.card.rename'),
      icon: <Pencil size={14} />,
      disabled: !canEdit,
      onSelect: () => {
        void prompt({ title: t('project.card.rename'), defaultValue: card.title, confirmLabel: t('common.save') }).then((name) => {
          if (name !== null && name.trim() && name.trim() !== card.title) void ctx.onPatchCard(card.id, { title: name.trim() })
        })
      },
    },
    {
      id: 'toggle-done',
      label: done ? t('project.card.mark_undone') : t('project.card.mark_done'),
      icon: <CheckSquare size={14} />,
      disabled: !canEdit,
      onSelect: () => { void ctx.onToggleDone(card, !done) },
    },
    {
      id: 'star',
      label: ctx.starred ? t('project.card.unfavorite') : t('project.card.favorite'),
      icon: <Star size={14} className={ctx.starred ? 'fill-[var(--warning)] text-[var(--warning)]' : undefined} />,
      onSelect: () => ctx.onToggleStar(card.id),
    },
    {
      id: 'pin',
      label: ctx.pinned ? t('project.card.unpin') : t('project.card.pin'),
      icon: <Pin size={14} className={ctx.pinned ? 'text-[var(--accent)]' : undefined} />,
      onSelect: () => ctx.onTogglePin(card.id),
    },
  ]

  if (groupProperty && groupProperty.options.length > 0) {
    const options: MenuItem[] = groupProperty.options.map((option) => ({
      id: `group-${option.id}`,
      label: option.value,
      icon: optionDot(option.color),
      checked: card.values[groupProperty.id] === option.id,
      onSelect: () => { void ctx.onPatchCard(card.id, { values: { [groupProperty.id]: option.id } }) },
    }))
    options.push({ id: 'group-none', label: t('project.view.no_value'), separatorBefore: true, onSelect: () => { void ctx.onPatchCard(card.id, { values: { [groupProperty.id]: null } }) } })
    items.push({ id: 'set-group', label: t('project.card.set_status'), icon: <CheckSquare size={14} />, disabled: !canEdit, separatorBefore: true, subItems: options, submenu: submenuFor(options) })
  }

  if (priorityProperty && priorityProperty.id !== groupProperty?.id) {
    const options: MenuItem[] = priorityProperty.options.map((option) => ({
      id: `prio-${option.id}`,
      label: option.value,
      icon: optionDot(option.color),
      checked: card.values[priorityProperty.id] === option.id,
      onSelect: () => { void ctx.onPatchCard(card.id, { values: { [priorityProperty.id]: option.id } }) },
    }))
    options.push({ id: 'prio-none', label: t('project.view.no_value'), separatorBefore: true, onSelect: () => { void ctx.onPatchCard(card.id, { values: { [priorityProperty.id]: null } }) } })
    items.push({ id: 'set-priority', label: t('project.card.set_priority'), icon: <Star size={14} />, disabled: !canEdit, subItems: options, submenu: submenuFor(options) })
  }

  if (dateProperty) {
    const write = (day: Date | null): void => {
      void ctx.onPatchCard(card.id, { values: { [dateProperty.id]: day ? JSON.stringify({ from: projectDayToStamp(day) }) : null } })
    }
    const options: MenuItem[] = [
      { id: 'date-today', label: t('project.card.date_today'), onSelect: () => write(new Date()) },
      { id: 'date-tomorrow', label: t('project.card.date_tomorrow'), onSelect: () => { const day = new Date(); day.setDate(day.getDate() + 1); write(day) } },
      { id: 'date-monday', label: t('project.card.date_next_monday'), onSelect: () => write(nextMonday()) },
      { id: 'date-clear', label: t('project.card.date_clear'), separatorBefore: true, onSelect: () => write(null) },
    ]
    items.push({ id: 'set-date', label: t('project.card.set_date'), icon: <CalendarClock size={14} />, disabled: !canEdit, subItems: options, submenu: submenuFor(options) })
  }

  items.push({ id: 'add-subtask', label: t('project.card.add_subtask'), icon: <ListTodo size={14} />, disabled: !canEdit, separatorBefore: true, onSelect: () => { void ctx.onAddSubtask(card.id) } })
  items.push({ id: 'duplicate', label: t('project.card.duplicate'), icon: <Copy size={14} />, disabled: !canEdit, onSelect: () => ctx.onDuplicate(card.id) })
  items.push({ id: 'copy-link', label: t('project.card.copy_link'), icon: <Link2 size={14} />, disabled: ctx.publicView, onSelect: () => ctx.onCopyLink(card.id) })
  items.push({ id: 'delete', label: t('project.board.delete_card'), icon: <Trash2 size={14} />, separatorBefore: true, tone: 'danger', disabled: !canEdit, onSelect: () => ctx.onDelete(card.id) })
  return items
}

/** The colour swatches an option can wear, as a submenu the column and tag menus share. */
export function optionColorItems(colors: readonly string[], current: string, onPick: (color: string) => void): MenuItem[] {
  return colors.map((color) => ({
    id: `color-${color || 'none'}`,
    label: color ? color.replace('propColor', '') : t('project.view.no_value'),
    icon: <span aria-hidden="true" className="size-3 rounded-full" style={{ backgroundColor: projectOptionCssColor(color) ?? 'var(--text-quaternary)' }} />,
    checked: current === color,
    onSelect: () => onPick(color),
  }))
}
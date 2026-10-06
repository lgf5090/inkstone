import { memo, useRef, useState } from 'react'
import { Archive, CalendarDays, SlidersHorizontal, Tag, Trash2, UserRound, X } from 'lucide-react'
import { Select } from '../../../../components/form'
import { Menu, submenuFor, type MenuItem } from '../../../../components/overlay'
import { t, useLocaleRepaint } from '../../../i18n'
import { addDaysKey, dateKey } from '../../../time'
import { formatKanbanOptionLabel } from '../i18n-helpers'
import type { KanbanOption, KanbanProperty } from '../types'
import { PANEL_FIELD } from './kanban-panel'

/**
 * The fields a batch can be rewritten with, each optional: a board that has no member column offers
 * no assignee, and one the host has not wired offers nothing at all. `onSetDueDate` writes the same
 * `dueDate` the detail panel writes, and `undefined` is how a deadline is taken back off.
 */
export interface KanbanBatchEdits {
  assignees?: string[]
  tags?: KanbanOption[]
  onAssign?: (name: string) => void
  onAddTag?: (tagId: string) => void
  onSetDueDate?: (date: string | undefined) => void
}

interface KanbanBatchBarProps {
  selectedCount: number
  groupColumn?: KanbanProperty
  onBatchGroupChange: (groupId: string) => void
  onBatchArchive: () => void
  onBatchDelete: () => void
  onClearSelection: () => void
  edits?: KanbanBatchEdits
}

const DUE_PRESET_DAYS = [
  { id: 'due-today', label: 'preview.kanban_today', offset: 0 },
  { id: 'due-tomorrow', label: 'preview.kanban_tomorrow', offset: 1 },
  { id: 'due-next-week', label: 'preview.kanban_next_week', offset: 7 },
] as const

/**
 * The days a batch deadline can be set to. Days rather than a calendar: the shared date picker is a
 * popover of its own, and nesting one inside a menu panel would give two overlays competing for the
 * same Escape and the same click outside. A date nobody can name in one gesture is the detail panel's
 * business, where the whole card is being read anyway.
 */
function buildDueDateItems(onSetDueDate: (date: string | undefined) => void): MenuItem[] {
  const today = dateKey(new Date())
  return [
    ...DUE_PRESET_DAYS.map((preset) => ({
      id: preset.id,
      label: t(preset.label),
      onSelect: () => onSetDueDate(addDaysKey(today, preset.offset)),
    })),
    {
      id: 'due-clear',
      label: t('preview.kanban_clear_date'),
      separatorBefore: true,
      onSelect: () => onSetDueDate(undefined),
    },
  ]
}

/** The rows of the batch editor, one per field this board can actually write. */
function buildBatchEditsItems(edits: KanbanBatchEdits): MenuItem[] {
  const items: MenuItem[] = []
  if (edits.assignees?.length && edits.onAssign) {
    const onAssign = edits.onAssign
    items.push({
      id: 'batch-assignee',
      label: t('preview.kanban_batch_assignee'),
      icon: <UserRound size={14} aria-hidden />,
      submenu: submenuFor(
        edits.assignees.map((name) => ({ id: `assignee-${name}`, label: name, onSelect: () => onAssign(name) })),
      ),
    })
  }
  if (edits.tags?.length && edits.onAddTag) {
    const onAddTag = edits.onAddTag
    items.push({
      id: 'batch-tag',
      label: t('preview.kanban_batch_tag'),
      icon: <Tag size={14} aria-hidden />,
      submenu: submenuFor(
        edits.tags.map((option) => ({
          id: `tag-${option.id}`,
          label: formatKanbanOptionLabel(option, 'tags'),
          onSelect: () => onAddTag(option.id),
        })),
      ),
    })
  }
  if (edits.onSetDueDate) {
    items.push({
      id: 'batch-due-date',
      label: t('preview.kanban_batch_due_date'),
      icon: <CalendarDays size={14} aria-hidden />,
      submenu: submenuFor(buildDueDateItems(edits.onSetDueDate)),
    })
  }
  return items
}

/**
 * One entry for every field the batch can be rewritten with, as submenus of a single button: the bar
 * floats over the board, so a control per field would cover the cards it is about to edit.
 */
function BatchEditsMenu({ edits }: { edits: KanbanBatchEdits }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const items = buildBatchEditsItems(edits)
  if (items.length === 0) return null
  return (
    <>
      <button
        ref={triggerRef}
        type='button'
        data-kanban-batch-edits
        aria-haspopup='menu'
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className='flex items-center gap-[var(--sp-1)] rounded-[var(--r-md)] px-[var(--sp-2)] py-[var(--sp-1)] text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
      >
        <SlidersHorizontal size={13} aria-hidden />
        <span>{t('preview.kanban_batch_edits')}</span>
      </button>
      <Menu
        anchor={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        label={t('preview.kanban_batch_edits')}
      />
    </>
  )
}

interface BatchGroupSelectProps {
  groupColumn: KanbanProperty
  onBatchGroupChange: (groupId: string) => void
}

function BatchGroupSelect({ groupColumn, onBatchGroupChange }: BatchGroupSelectProps) {
  if (!groupColumn.options) return null
  return (
    <Select
      defaultValue=''
      aria-label={t('preview.kanban_batch_change_group')}
      onChange={(e) => {
        if (e.target.value) {
          onBatchGroupChange(e.target.value)
          e.target.value = ''
        }
      }}
      className={`${PANEL_FIELD} h-[var(--sp-8)] md:h-8 text-[length:var(--text-12)]`}
    >
      <option value='' disabled>
        {t('preview.kanban_batch_change_group')}
      </option>
      {groupColumn.options.map((opt) => (
        <option key={opt.id} value={opt.id}>
          {formatKanbanOptionLabel(opt, groupColumn.id)}
        </option>
      ))}
    </Select>
  )
}

export const KanbanBatchBar = memo(function KanbanBatchBar({
  selectedCount,
  groupColumn,
  onBatchGroupChange,
  onBatchArchive,
  onBatchDelete,
  onClearSelection,
  edits,
}: KanbanBatchBarProps) {
  useLocaleRepaint()
  if (selectedCount === 0) return null

  return (
    <div className='absolute bottom-[var(--sp-6)] left-1/2 z-[var(--z-float)] flex -translate-x-1/2 items-center gap-[var(--sp-3)] rounded-[var(--r-xl)] border border-[var(--border-strong)] bg-[var(--bg-overlay)] px-[var(--sp-4)] py-2.5 shadow-[var(--shadow-modal)]'>
      <span className='text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]'>
        {t('preview.kanban_batch_selected_count', { count: selectedCount })}
      </span>

      {groupColumn && (
        <BatchGroupSelect
          groupColumn={groupColumn}
          onBatchGroupChange={onBatchGroupChange}
        />
      )}

      {edits && <BatchEditsMenu edits={edits} />}

      <button
        type='button'
        data-kanban-batch-archive
        onClick={onBatchArchive}
        className='flex items-center gap-[var(--sp-1)] rounded-[var(--r-md)] px-[var(--sp-2)] py-[var(--sp-1)] text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
      >
        <Archive size={13} aria-hidden />
        <span>{t('preview.kanban_archive_item')}</span>
      </button>

      <button
        type='button'
        onClick={onBatchDelete}
        className='flex items-center gap-[var(--sp-1)] rounded-[var(--r-md)] px-[var(--sp-2)] py-[var(--sp-1)] text-[length:var(--text-12)] text-[var(--danger)] hover:bg-[var(--bg-hover)]'
      >
        <Trash2 size={13} />
        <span>{t('preview.kanban_batch_delete')}</span>
      </button>

      <button
        type='button'
        onClick={onClearSelection}
        className='text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
        aria-label={t('preview.kanban_clear_selection')}
      >
        <X size={15} />
      </button>
    </div>
  )
})

import { Flag, Link2, Trash2 } from 'lucide-react'
import { t } from '../../../i18n'
import { getKanbanDotColor, getKanbanTagStyle } from '../colors'
import { formatKanbanOptionLabel, formatKanbanPropertyName } from '../i18n-helpers'
import { safeKanbanUrl } from '../url'
import type { ReactNode } from 'react'
import type { KanbanItem, KanbanOption, KanbanProperty } from '../types'
import { KanbanDatePicker } from './kanban-date-picker'
import { KanbanFilesCell } from './kanban-files-cell'
import { KanbanPersonPicker } from './kanban-person-picker'
import { KanbanSubtaskList } from './kanban-subtask-list'
import { KanbanTagPicker } from './kanban-tag-picker'

export function StatusOptionItem({
  option,
  isSelected,
  onSelect,
}: {
  option: KanbanOption
  isSelected: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      type='button'
      role='option'
      aria-selected={isSelected}
      onClick={() => onSelect(option.id)}
      className={`flex w-full items-center gap-2 rounded-[var(--r-xs)] px-2.5 py-1.5 text-left text-[length:var(--text-12)] font-medium transition-colors hover:bg-[var(--bg-hover)] ${
        isSelected ? 'text-[var(--accent)] font-semibold' : 'text-[var(--text-primary)]'
      }`}
    >
      <span
        className='size-2 rounded-full shrink-0'
        style={{ backgroundColor: getKanbanDotColor(option.color) }}
      />
      <span>{formatKanbanOptionLabel(option, 'status')}</span>
    </button>
  )
}

/** The listbox the status trigger opens; `id` is the target of its `aria-controls`. */
export function StatusOptionList({
  id,
  label,
  options,
  current,
  onSelect,
}: {
  id: string
  label: string
  options: KanbanOption[]
  current?: unknown
  onSelect: (id: string) => void
}) {
  return (
    <div
      id={id}
      role='listbox'
      aria-label={label}
      className='absolute left-0 top-full z-[var(--z-popover)] mt-1 min-w-36 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 shadow-[var(--shadow-pop)]'
    >
      {options.map((o) => (
        <StatusOptionItem
          key={o.id}
          option={o}
          isSelected={o.id === current || o.label === current}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

export function PriorityChips({
  priorityCol,
  currentPriority,
  onChangePriority,
}: {
  priorityCol?: KanbanProperty
  currentPriority?: unknown
  onChangePriority: (val: string) => void
}) {
  const options: KanbanOption[] = priorityCol?.options ?? [
    { id: 'low', label: 'low', color: 'green' },
    { id: 'medium', label: 'medium', color: 'yellow' },
    { id: 'high', label: 'high', color: 'red' },
  ]

  return (
    <div className='flex flex-col gap-1.5'>
      <label className='text-[length:var(--text-11)] font-semibold text-[var(--text-tertiary)]'>
        {t('preview.kanban_prop_priority')}
      </label>
      <div className='flex flex-wrap items-center gap-1.5'>
        {options.map((opt) => {
          const isSelected = currentPriority === opt.id || currentPriority === opt.label
          return (
            <button
              key={opt.id}
              type='button'
              onClick={() => onChangePriority(isSelected ? '' : opt.id)}
              style={isSelected ? getKanbanTagStyle(opt.color) : undefined}
              className={`inline-flex items-center gap-1 rounded-[var(--r-xs)] px-2.5 py-1 text-[length:var(--text-12)] font-medium transition-colors ${
                isSelected
                  ? 'shadow-2xs ring-1 ring-[var(--accent-soft)]'
                  : 'border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Flag size={11} />
              <span>{formatKanbanOptionLabel(opt, 'priority')}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function DetailFooter({ onDelete, onClose }: { onDelete: () => void; onClose: () => void }) {
  return (
    <div className='flex w-full items-center justify-between'>
      <button
        type='button'
        onClick={onDelete}
        className='inline-flex items-center gap-1.5 rounded-[var(--r-md)] px-2.5 py-1.5 text-[length:var(--text-12)] text-[var(--danger)] hover:bg-[var(--bg-hover)]'
      >
        <Trash2 size={14} />
        <span>{t('preview.kanban_delete_card')}</span>
      </button>
      <button
        type='button'
        onClick={onClose}
        className='rounded-[var(--r-md)] bg-[var(--bg-raised)] border border-[var(--border-default)] px-3 py-1.5 text-[length:var(--text-12)] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
      >
        {t('preview.kanban_done')}
      </button>
    </div>
  )
}

/** A property whose control brings its own focus semantics: the label is not its `<label>`. */
function LabelledField({ column, children }: { column: KanbanProperty; children: ReactNode }) {
  return (
    <div className='flex flex-col gap-1'>
      <span className='text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]'>
        {formatKanbanPropertyName(column)}
      </span>
      {children}
    </div>
  )
}

/**
 * Edited as text like its sibling fields; the link it names opens from the affordance beside it,
 * through the same URL whitelist the fence was read under.
 */
function UrlDetailField({ value, onChange }: { value: string; onChange: (value: unknown) => void }) {
  const link = safeKanbanUrl(value)
  return (
    <div className='flex items-center gap-1'>
      <input
        type='text'
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className='h-8 min-w-0 flex-1 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 text-[length:var(--text-12)] text-[var(--text-primary)] outline-none'
      />
      {link && (
        <a
          href={link}
          target='_blank'
          rel='noopener noreferrer'
          aria-label={t('preview.open_in_new_tab')}
          className='shrink-0 p-1 text-[var(--text-tertiary)] transition-colors hover:text-[var(--accent)]'
        >
          <Link2 size={13} />
        </a>
      )}
    </div>
  )
}

/** The one date a detail field holds, through the same picker the table uses. */
function DateDetailField({ column, value, onChange }: { column: KanbanProperty; value: unknown; onChange: (value: unknown) => void }) {
  return (
    <KanbanDatePicker
      propertyName={formatKanbanPropertyName(column)}
      value={String(value ?? '')}
      onChange={onChange}
    />
  )
}

/** The plain fallback: text and number, both edited as the detail panel always has. */
function TextDetailField({ column, value, onChange }: { column: KanbanProperty; value: unknown; onChange: (value: unknown) => void }) {
  return (
    <input
      type={column.type === 'number' ? 'number' : 'text'}
      value={column.type === 'number' ? Number(value ?? 0) : String(value ?? '')}
      onChange={(e) => onChange(column.type === 'number' ? Number(e.target.value) : e.target.value)}
      className='h-8 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 text-[length:var(--text-12)] text-[var(--text-primary)] outline-none'
    />
  )
}

export function DetailPropertyField({
  column,
  value,
  people,
  onChange,
}: {
  column: KanbanProperty
  value: unknown
  /** Who this member picker may offer; only the cards that already name someone fill it in. */
  people?: string[]
  onChange: (value: unknown) => void
}) {
  if (column.type === 'date') {
    return (
      <LabelledField column={column}>
        <DateDetailField column={column} value={value} onChange={onChange} />
      </LabelledField>
    )
  }

  if (column.type === 'person') {
    return (
      <LabelledField column={column}>
        <KanbanPersonPicker
          propertyName={formatKanbanPropertyName(column)}
          value={value}
          candidates={people}
          onChange={onChange}
        />
      </LabelledField>
    )
  }

  if (column.type === 'url') {
    return (
      <LabelledField column={column}>
        <UrlDetailField value={String(value ?? '')} onChange={onChange} />
      </LabelledField>
    )
  }

  return (
    <label className='flex flex-col gap-1'>
      <span className='text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]'>
        {formatKanbanPropertyName(column)}
      </span>
      <TextDetailField column={column} value={value} onChange={onChange} />
    </label>
  )
}

export function DetailPropertiesGrid({
  columns,
  properties,
  people,
  onChangeProperty,
}: {
  columns: KanbanProperty[]
  properties: Record<string, unknown>
  /** Who each member column may offer, keyed by column id. */
  people?: Record<string, string[]>
  onChangeProperty: (id: string, val: unknown) => void
}) {
  const handledIds = new Set(['title', 'status', 'priority', 'tags', 'dueDate', 'startDate', 'endDate', 'files'])
  const remaining = columns.filter((c) => !handledIds.has(c.id) && c.type !== 'files')
  if (remaining.length === 0) return null

  return (
    <div className='grid grid-cols-2 gap-4 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-3.5'>
      {remaining.map((col) => (
        <DetailPropertyField
          key={col.id}
          column={col}
          value={properties[col.id]}
          people={people?.[col.id]}
          onChange={(val) => onChangeProperty(col.id, val)}
        />
      ))}
    </div>
  )
}

export function DetailAttachmentsAndSubtasks({
  item,
  onUpdate,
  onConvertSubtask,
}: {
  item: KanbanItem
  onUpdate: (updated: KanbanItem) => void
  onConvertSubtask: (subtaskId: string) => void
}) {
  return (
    <>
      <div className='flex flex-col gap-2'>
        {/* The type goes on this wrapper, not on the heading: prose owns a note's `h4` and wins any
            utility written on it (see the hand-back block in `styles/kanban.css`). */}
        <div className='text-[length:var(--text-13)] font-semibold'>
          <h4 className='text-[var(--text-secondary)]'>
            {t('preview.kanban_files')}
          </h4>
        </div>
        <KanbanFilesCell
          files={item.files}
          onChangeFiles={(files) => onUpdate({ ...item, files })}
          cover={item.cover}
          onChangeCover={(cover) => onUpdate({ ...item, cover })}
        />
      </div>
      <div className='flex flex-col gap-2'>
        <div className='text-[length:var(--text-13)] font-semibold'>
          <h4 className='text-[var(--text-secondary)]'>
            {t('preview.kanban_subtasks')}
          </h4>
        </div>
        <KanbanSubtaskList
          subtasks={item.subtasks ?? []}
          onUpdateSubtasks={(subtasks) => onUpdate({ ...item, subtasks })}
          onConvertToItem={(subtask) => onConvertSubtask(subtask.id)}
        />
      </div>
    </>
  )
}

export function DetailDatesGrid({
  startDateVal,
  dueDateVal,
  onPropertyChange,
}: {
  startDateVal: unknown
  dueDateVal: unknown
  onPropertyChange: (propertyId: string, value: unknown) => void
}) {
  return (
    <div className='grid grid-cols-2 gap-4'>
      <div className='flex flex-col gap-1.5'>
        <label className='text-[length:var(--text-11)] font-semibold text-[var(--text-tertiary)]'>
          {t('preview.kanban_prop_start_date')}
        </label>
        <KanbanDatePicker
          propertyName={t('preview.kanban_prop_start_date')}
          value={String(startDateVal ?? '')}
          onChange={(val) => onPropertyChange('startDate', val)}
        />
      </div>
      <div className='flex flex-col gap-1.5'>
        <label className='text-[length:var(--text-11)] font-semibold text-[var(--text-tertiary)]'>
          {t('preview.kanban_prop_end_date')}
        </label>
        <KanbanDatePicker
          propertyName={t('preview.kanban_prop_end_date')}
          value={String(dueDateVal ?? '')}
          onChange={(val) => onPropertyChange('dueDate', val)}
        />
      </div>
    </div>
  )
}

export function DetailTagsField({
  tagVals,
  options,
  onChangeTags,
}: {
  tagVals: string[]
  options: KanbanOption[]
  onChangeTags: (tags: string[], newOption?: KanbanOption) => void
}) {
  return (
    <div className='flex flex-col gap-1.5'>
      <label className='text-[length:var(--text-11)] font-semibold text-[var(--text-tertiary)]'>
        {t('preview.kanban_prop_tags')}
      </label>
      <KanbanTagPicker tags={tagVals} options={options} onChangeTags={onChangeTags} />
    </div>
  )
}

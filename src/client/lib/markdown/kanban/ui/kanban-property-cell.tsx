import { useState } from 'react'
import { ArrowDown, ArrowUp, Link2 } from 'lucide-react'
import { t } from '../../../i18n'
import { getKanbanTagStyle } from '../colors'
import { kanbanColumnWidthPx } from '../column-width'
import { formatKanbanOptionLabel, formatKanbanPropertyName } from '../i18n-helpers'
import { safeKanbanUrl } from '../url'
import type { CSSProperties } from 'react'
import type { KanbanFile, KanbanItem, KanbanOption, KanbanProperty, KanbanPropertyType, KanbanSort } from '../types'
import { ColumnResizeHandle } from './kanban-column-resize-handle'
import { KanbanDatePicker } from './kanban-date-picker'
import { KanbanFilesCell } from './kanban-files-cell'
import { KanbanPersonPicker } from './kanban-person-picker'
import { KanbanTagPicker } from './kanban-tag-picker'

export const KANBAN_TITLE_COLUMN: KanbanProperty = { id: 'title', name: 'Title', type: 'title' }

// Attachments live on the item, not in `properties`, so the table always has a
// column for them even when the document schema does not declare one.
export const KANBAN_FILES_COLUMN: KanbanProperty = { id: 'files', name: 'Files', type: 'files' }

export function kanbanTitleColumn(columns: KanbanProperty[]): KanbanProperty {
  return columns.find((col) => col.type === 'title' || col.id === 'title') ?? KANBAN_TITLE_COLUMN
}

// The view's hidden list only reaches property columns: the title column is not
// part of this list at all, so no document can hide it.
export function kanbanPropertyColumns(columns: KanbanProperty[], hidden?: string[]): KanbanProperty[] {
  const declared = columns.filter((col) => col.type !== 'title' && col.id !== 'title')
  const withFiles = declared.some((col) => col.type === 'files') ? declared : [...declared, KANBAN_FILES_COLUMN]
  return hidden ? withFiles.filter((col) => !hidden.includes(col.id)) : withFiles
}

// A spanning row has to say how wide it is; the leading selection column and the
// title column are rendered outside `kanbanPropertyColumns`, so they count too.
export function kanbanTableColumnCount(columns: KanbanProperty[], hidden?: string[]): number {
  return 2 + kanbanPropertyColumns(columns, hidden).length
}

const COLUMN_WIDTH: Record<KanbanPropertyType, string> = {
  title: 'flex-1 min-w-48',
  select: 'w-36 shrink-0',
  'multi-select': 'w-44 shrink-0',
  date: 'w-32 shrink-0',
  text: 'w-36 shrink-0',
  number: 'w-24 shrink-0',
  checkbox: 'w-16 shrink-0',
  person: 'w-36 shrink-0',
  files: 'w-40 shrink-0',
  url: 'w-36 shrink-0',
}

function kanbanColumnTypeWidth(column: KanbanProperty): string {
  return COLUMN_WIDTH[column.type] ?? COLUMN_WIDTH.text
}

/**
 * How wide a column is drawn: a width the reader stored wins, and only the column's own default
 * remains otherwise. A stored width replaces the type's classes rather than adding to them, because
 * the title column's `flex-1 min-w-48` would grow past or floor whatever was asked for.
 */
export function kanbanColumnSize(column: KanbanProperty): { className: string; style: CSSProperties } {
  const authored = kanbanColumnWidthPx(column)
  if (authored === undefined) return { className: kanbanColumnTypeWidth(column), style: {} }
  return { className: 'shrink-0', style: { width: `${authored}px` } }
}

// The two columns the table draws itself have no entry in the document to store a width on, so a
// handle on one of them would be a control that silently forgets what it was told.
export function isSizableColumn(column: KanbanProperty): boolean {
  return column !== KANBAN_TITLE_COLUMN && column !== KANBAN_FILES_COLUMN
}

function readValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v))
  if (value === undefined || value === null || value === '') return []
  return [String(value)]
}

function readPlainText(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ')
  return String(value)
}

function readNumber(text: string): number | '' {
  return text.trim() === '' ? '' : Number(text)
}

interface EditableValueProps {
  label: string
  text: string
  numberType?: boolean
  onSubmit: (next: string) => void
}

function EditableValue({ label, text, numberType = false, onSubmit }: EditableValueProps) {
  const [draft, setDraft] = useState(text)
  const [committed, setCommitted] = useState(text)
  if (text !== committed) {
    setCommitted(text)
    setDraft(text)
  }

  const submit = () => {
    if (draft === committed) return
    setCommitted(draft)
    onSubmit(draft)
  }

  return (
    <input
      type={numberType ? 'number' : 'text'}
      value={draft}
      data-owns-escape='true'
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={submit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') submit()
        if (e.key === 'Escape') setDraft(committed)
      }}
      className='h-7 w-full rounded-[var(--r-sm)] border border-transparent bg-transparent px-1.5 text-[length:var(--text-12)] text-[var(--text-primary)] outline-none hover:border-[var(--border-subtle)] focus:border-[var(--accent)]'
    />
  )
}

function SelectValue({
  column,
  value,
  onChange,
}: {
  column: KanbanProperty
  value: unknown
  onChange: (val: unknown) => void
}) {
  const options = column.options ?? []
  const current = options.find((opt) => opt.id === value || opt.label === value)
  return (
    // The one select the panels do not own: this is a chip, painted in the option's own colour, and the
    // project's `Select` would put a bordered field and a tertiary chevron on top of that colour. It is
    // made non-native instead — no OS arrow — which is also how every other cell of this table already
    // reads (the date, member, tag and attachment cells are colour or icon affordances, none of them an
    // arrow). The chip still answers to the keyboard and still carries the column's name.
    <select
      value={current?.id ?? String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
      aria-label={formatKanbanPropertyName(column)}
      style={getKanbanTagStyle(current?.color)}
      className='h-7 w-full cursor-pointer appearance-none rounded-[var(--r-sm)] border-none px-2 text-[length:var(--text-11)] font-bold outline-none'
    >
      {options.map((opt) => (
        <option key={opt.id} value={opt.id} className='bg-[var(--bg-surface)] text-[var(--text-primary)]'>
          {formatKanbanOptionLabel(opt, column.id)}
        </option>
      ))}
    </select>
  )
}

function CheckboxValue({
  column,
  checked,
  onChange,
}: {
  column: KanbanProperty
  checked: boolean
  onChange: (val: unknown) => void
}) {
  return (
    <input
      type='checkbox'
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={formatKanbanPropertyName(column)}
      className='size-3.5 rounded-[var(--r-xs)] accent-[var(--accent)]'
    />
  )
}

interface KanbanPropertyCellProps {
  column: KanbanProperty
  item: KanbanItem
  onUpdateProperty: (itemId: string, propertyId: string, value: unknown) => void
  onUpdateMultiSelect: (itemId: string, columnId: string, values: string[], newOption?: KanbanOption) => void
  onUpdateFiles: (itemId: string, files: KanbanFile[]) => void
  /** Who the member picker may offer, per member column. Absent means only typed names are offered. */
  people?: Record<string, string[]>
}

/**
 * A url cell stays an editable field like its text sibling; the link it names opens from the
 * affordance beside it, so the reader never has to leave edit mode to follow it.
 */
function UrlCellValue({
  column,
  value,
  write,
}: {
  column: KanbanProperty
  value: unknown
  write: (next: unknown) => void
}) {
  const link = safeKanbanUrl(readPlainText(value))
  return (
    <div className='flex items-center gap-1'>
      <EditableValue
        label={formatKanbanPropertyName(column)}
        text={readPlainText(value)}
        onSubmit={(next) => write(next.trim())}
      />
      {link && (
        <a
          href={link}
          target='_blank'
          rel='noopener noreferrer'
          aria-label={t('preview.open_in_new_tab')}
          className='shrink-0 text-[var(--text-tertiary)] transition-colors hover:text-[var(--accent)]'
        >
          <Link2 size={12} />
        </a>
      )}
    </div>
  )
}

/** The one date a cell holds, through the same picker the detail panel uses. */
function DateCellValue({ column, value, write }: { column: KanbanProperty; value: unknown; write: (next: unknown) => void }) {
  return (
    <KanbanDatePicker
      propertyName={formatKanbanPropertyName(column)}
      value={readPlainText(value)}
      onChange={write}
    />
  )
}

/** The plain fallback: text and number, both edited in place. */
function TextCellValue({ column, value, write }: { column: KanbanProperty; value: unknown; write: (next: unknown) => void }) {
  return (
    <EditableValue
      label={formatKanbanPropertyName(column)}
      text={readPlainText(value)}
      numberType={column.type === 'number'}
      onSubmit={(next) => write(column.type === 'number' ? readNumber(next) : next)}
    />
  )
}

function CellContent({
  column,
  item,
  onUpdateProperty,
  onUpdateMultiSelect,
  onUpdateFiles,
  people,
}: KanbanPropertyCellProps) {
  const value = item.properties[column.id]
  const write = (next: unknown) => onUpdateProperty(item.id, column.id, next)

  if (column.type === 'select') {
    return <SelectValue column={column} value={value} onChange={write} />
  }
  if (column.type === 'person') {
    return (
      <KanbanPersonPicker
        propertyName={formatKanbanPropertyName(column)}
        value={value}
        candidates={people?.[column.id]}
        onChange={write}
      />
    )
  }
  if (column.type === 'multi-select') {
    return (
      <KanbanTagPicker
        tags={readValues(value)}
        options={column.options}
        onChangeTags={(next, newOption) => onUpdateMultiSelect(item.id, column.id, next, newOption)}
      />
    )
  }
  if (column.type === 'checkbox') {
    return <CheckboxValue column={column} checked={Boolean(value)} onChange={write} />
  }
  if (column.type === 'files') {
    return <KanbanFilesCell files={item.files} onChangeFiles={(files) => onUpdateFiles(item.id, files)} />
  }
  if (column.type === 'date') {
    return <DateCellValue column={column} value={value} write={write} />
  }
  if (column.type === 'url') {
    return <UrlCellValue column={column} value={value} write={write} />
  }
  return <TextCellValue column={column} value={value} write={write} />
}

export function KanbanPropertyCell(props: KanbanPropertyCellProps) {
  const size = kanbanColumnSize(props.column)
  return (
    <div
      role='cell'
      data-kanban-column={props.column.id}
      style={size.style}
      className={`border-l border-[var(--border-subtle)] px-2.5 py-1.5 text-[length:var(--text-12)] text-[var(--text-secondary)] ${size.className}`}
    >
      <CellContent {...props} />
    </div>
  )
}

export function KanbanTableHeaderCell({
  column,
  sort,
  onSort,
  onResize,
}: {
  column: KanbanProperty
  sort?: KanbanSort
  onSort?: (propertyId: string) => void
  onResize?: (propertyId: string, width: number | undefined) => void
}) {
  const label = formatKanbanPropertyName(column)
  // Sorts read `properties[columnId]`, which attachments are not stored in, so the files column stays
  // a plain label.
  const sortable = column.type !== 'files' && onSort !== undefined
  const size = kanbanColumnSize(column)
  const ariaLabel = !sort
    ? t('preview.kanban_sort_by_column', { column: label })
    : t(sort.direction === 'asc' ? 'preview.kanban_sorted_ascending' : 'preview.kanban_sorted_descending', { column: label })
  return (
    <div
      role='columnheader'
      data-kanban-column={column.id}
      style={size.style}
      className={`relative border-l border-[var(--border-subtle)] px-3 py-2 ${column.type === 'checkbox' || column.type === 'files' ? 'text-center' : ''} ${size.className}`}
    >
      {sortable ? (
        <button
          type='button'
          onClick={() => onSort(column.id)}
          aria-label={ariaLabel}
          className='flex w-full items-center gap-1 rounded-[var(--r-sm)] text-left text-inherit outline-none hover:text-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]'
        >
          <span>{label}</span>
          {sort && (sort.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
        </button>
      ) : (
        <span>{label}</span>
      )}
      {onResize && isSizableColumn(column) ? <ColumnResizeHandle column={column} onResize={(width) => onResize(column.id, width)} /> : null}
    </div>
  )
}

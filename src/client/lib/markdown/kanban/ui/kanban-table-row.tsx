import { useState } from 'react'
import { ChevronDown, ChevronRight, MessageSquare, Plus, Trash2 } from 'lucide-react'
import { t } from '../../../i18n'
import { createKanbanId } from '../id'
import type { KanbanFile, KanbanItem, KanbanOption, KanbanProperty, KanbanSubtask } from '../types'
import { KanbanIconBadge } from './kanban-icon-badge'
import type { TableReorderProps } from './kanban-table-dnd'
import {
  KanbanPropertyCell,
  kanbanColumnSize,
  kanbanPropertyColumns,
  kanbanTableColumnCount,
  kanbanTitleColumn,
} from './kanban-property-cell'

interface KanbanTableRowProps {
  item: KanbanItem
  columns: KanbanProperty[]
  hiddenColumns?: string[]
  isSelected: boolean
  onToggleSelect: () => void
  onOpenDetail: () => void
  onUpdateProperty: (itemId: string, propertyId: string, value: unknown) => void
  onUpdateMultiSelect: (itemId: string, columnId: string, values: string[], newOption?: KanbanOption) => void
  onUpdateSubtasks?: (itemId: string, subtasks: KanbanSubtask[]) => void
  onUpdateFiles: (itemId: string, files: KanbanFile[]) => void
  /** Who the member picker may offer, per member column. */
  people?: Record<string, string[]>
  /** KU-21c: the row's own drag and its keyboard walk. Absent where the table cannot write. */
  reorder?: TableReorderProps
}

function SubitemItemRow({
  subtask,
  onToggle,
  onDelete,
}: {
  subtask: KanbanSubtask
  onToggle: () => void
  onDelete: () => void
}) {
  return (
    <div className='flex flex-col gap-[var(--sp-0-5)] rounded-[var(--r-xs)] bg-[var(--bg-surface)] px-[var(--sp-2)] py-[var(--sp-1)] text-[length:var(--text-12)] shadow-2xs'>
      <div className='flex items-center gap-[var(--sp-2)]'>
        <input
          type='checkbox'
          checked={subtask.completed}
          onChange={onToggle}
          aria-label={subtask.title}
          className='size-3 rounded-[var(--r-xs)] accent-[var(--accent)]'
        />
        {subtask.icon && <KanbanIconBadge icon={subtask.icon} size={13} />}
        <span className={`flex-1 ${subtask.completed ? 'text-[var(--text-tertiary)] line-through' : 'text-[var(--text-primary)]'}`}>
          {subtask.title}
        </span>
        <button
          type='button'
          onClick={onDelete}
          aria-label={t('preview.kanban_delete_named', { name: subtask.title })}
          className='text-[var(--text-tertiary)] hover:text-[var(--danger)]'
        >
          <Trash2 size={11} />
        </button>
      </div>
      {subtask.description && (
        <p className='pl-[var(--sp-5)] text-[length:var(--text-11)] text-[var(--text-tertiary)] line-clamp-1'>
          {subtask.description}
        </p>
      )}
    </div>
  )
}

function SubitemsNestedTable({
  subtasks = [],
  onUpdateSubtasks,
  columnCount,
}: {
  subtasks: KanbanSubtask[]
  onUpdateSubtasks: (next: KanbanSubtask[]) => void
  columnCount: number
}) {
  const [newTitle, setNewTitle] = useState('')

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTitle.trim()) return
    onUpdateSubtasks([
      ...subtasks,
      { id: `sub_${createKanbanId()}`, title: newTitle.trim(), completed: false },
    ])
    setNewTitle('')
  }

  return (
    <div role='row' className='border-t border-[var(--border-subtle)] bg-[var(--bg-inset)]'>
      <div role='cell' aria-colspan={columnCount} className='py-[var(--sp-2)] pl-[var(--sp-12)] pr-[var(--sp-4)]'>
        <div className='mb-[var(--sp-1-5)] text-[length:var(--text-11)] font-semibold text-[var(--text-tertiary)]'>
          {t('preview.kanban_subtasks_count', { count: subtasks.length })}
        </div>
        <div className='flex flex-col gap-[var(--sp-1)]'>
          {subtasks.map((st) => (
            <SubitemItemRow
              key={st.id}
              subtask={st}
              onToggle={() =>
                onUpdateSubtasks(
                  subtasks.map((s) => (s.id === st.id ? { ...s, completed: !s.completed } : s)),
                )
              }
              onDelete={() => onUpdateSubtasks(subtasks.filter((s) => s.id !== st.id))}
            />
          ))}
          <form onSubmit={handleAdd} className='mt-[var(--sp-1)] flex items-center gap-[var(--sp-1-5)]'>
            <Plus size={12} className='text-[var(--text-tertiary)]' />
            <input
              type='text'
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder={t('preview.kanban_add_subtask')}
              className='w-full rounded-[var(--r-xs)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-[var(--sp-2)] py-[var(--sp-0-5)] text-[length:var(--text-11)] outline-none focus:border-[var(--accent)]'
            />
          </form>
        </div>
      </div>
    </div>
  )
}

function ItemTitleCell({
  item,
  column,
  subtasksCount,
  expanded,
  onToggleExpand,
  onOpenDetail,
}: {
  item: KanbanItem
  column: KanbanProperty
  subtasksCount: number
  expanded: boolean
  onToggleExpand: () => void
  onOpenDetail: () => void
}) {
  const titleSize = kanbanColumnSize(column)
  return (
    <div
      role='rowheader'
      data-kanban-column={column.id}
      style={titleSize.style}
      className={`flex items-center gap-[var(--sp-2)] border-l border-[var(--border-subtle)] px-[var(--sp-3)] py-[var(--sp-2)] ${titleSize.className}`}
    >
      {subtasksCount > 0 && (
        <button
          type='button'
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-label={t(expanded ? 'preview.kanban_collapse_subtasks' : 'preview.kanban_expand_subtasks')}
          className='text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      )}
      <KanbanIconBadge icon={item.icon} size={15} />
      <button
        type='button'
        onClick={onOpenDetail}
        className='truncate text-left font-medium text-[var(--text-primary)] hover:text-[var(--accent)]'
      >
        {item.title}
      </button>
      {subtasksCount > 0 && (
        <span className='rounded-[var(--r-full)] bg-[var(--bg-hover)] px-[var(--sp-1-5)] py-[var(--sp-0-5)] text-[length:var(--text-10)] text-[var(--text-tertiary)]'>
          {subtasksCount}
        </span>
      )}
      <button
        type='button'
        onClick={onOpenDetail}
        aria-label={t('preview.kanban_card_details')}
        className='ml-auto text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
      >
        <MessageSquare size={13} />
      </button>
    </div>
  )
}

/** The row's own checkbox: selecting a card is the one thing a row does outside its columns. */
function RowSelectionCell({ isSelected, onToggleSelect }: { isSelected: boolean; onToggleSelect: () => void }) {
  return (
    <div role='cell' className='w-[var(--sp-10)] shrink-0 p-[var(--sp-2-5)] text-center'>
      <input
        type='checkbox'
        checked={isSelected}
        onChange={onToggleSelect}
        aria-label={t('preview.kanban_select_card')}
        className='size-3.5 rounded-[var(--r-xs)] border-[var(--border-default)] accent-[var(--accent)]'
      />
    </div>
  )
}

/**
 * The columns a row draws, without their wrapper — split out of `KanbanTableRow` so the row itself
 * stays a gesture wrapper over one strip of cells and one optional expansion.
 */
function RowCells({
  item,
  columns,
  hiddenColumns,
  isSelected,
  onToggleSelect,
  onOpenDetail,
  onUpdateProperty,
  onUpdateMultiSelect,
  onUpdateFiles,
  people,
  subtasksCount,
  expanded,
  onToggleExpand,
}: Omit<KanbanTableRowProps, 'onUpdateSubtasks' | 'reorder'> & {
  subtasksCount: number
  expanded: boolean
  onToggleExpand: () => void
}) {
  const titleColumn = kanbanTitleColumn(columns)
  const propertyColumns = kanbanPropertyColumns(columns, hiddenColumns)
  return (
    <div role='row' className='flex min-h-[var(--sp-10)] items-center text-[length:var(--text-12)]'>
      <RowSelectionCell isSelected={isSelected} onToggleSelect={onToggleSelect} />
      <ItemTitleCell
        item={item}
        column={titleColumn}
        subtasksCount={subtasksCount}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
        onOpenDetail={onOpenDetail}
      />
      {propertyColumns.map((column) => (
        <KanbanPropertyCell
          key={column.id}
          column={column}
          item={item}
          onUpdateProperty={onUpdateProperty}
          onUpdateMultiSelect={onUpdateMultiSelect}
          onUpdateFiles={onUpdateFiles}
          people={people}
        />
      ))}
    </div>
  )
}

export function KanbanTableRow({
  item,
  columns,
  hiddenColumns,
  isSelected,
  onToggleSelect,
  onOpenDetail,
  onUpdateProperty,
  onUpdateMultiSelect,
  onUpdateSubtasks,
  onUpdateFiles,
  people,
  reorder,
}: KanbanTableRowProps) {
  const [expanded, setExpanded] = useState(false)
  const subtasks = item.subtasks || []
  const rowGesture = reorder?.rowProps(item) ?? {}

  return (
    <div
      role='presentation'
      data-item-id={item.id}
      {...rowGesture}
      onKeyDown={reorder ? (e) => reorder.rowKeyDown(item, e) : undefined}
      className={`flex flex-col border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] transition-colors hover:bg-[var(--bg-hover)] ${
        reorder?.isDragging ? 'cursor-grabbing' : reorder ? 'cursor-grab' : ''
      }`}
    >
      <RowCells
        item={item}
        columns={columns}
        hiddenColumns={hiddenColumns}
        isSelected={isSelected}
        onToggleSelect={onToggleSelect}
        onOpenDetail={onOpenDetail}
        onUpdateProperty={onUpdateProperty}
        onUpdateMultiSelect={onUpdateMultiSelect}
        onUpdateFiles={onUpdateFiles}
        people={people}
        subtasksCount={subtasks.length}
        expanded={expanded}
        onToggleExpand={() => setExpanded((e) => !e)}
      />

      {expanded && onUpdateSubtasks && (
        <SubitemsNestedTable
          subtasks={subtasks}
          columnCount={kanbanTableColumnCount(columns, hiddenColumns)}
          onUpdateSubtasks={(next) => onUpdateSubtasks(item.id, next)}
        />
      )}
    </div>
  )
}

import { memo } from 'react'
import { Plus } from 'lucide-react'
import { t, useLocaleRepaint } from '../../../i18n'
import { groupKanbanItems, type KanbanGroup } from '../filter-sort'
import type { KanbanRowMove } from '../dnd'
import type { KanbanData, KanbanFile, KanbanItem, KanbanOption, KanbanProperty, KanbanSort, KanbanSubtask, KanbanView } from '../types'
import { KanbanTableHeaderCell, kanbanPropertyColumns, kanbanTableColumnCount, kanbanTitleColumn } from './kanban-property-cell'
import { KanbanTableGroup } from './kanban-table-group'
import { useKanbanTableReorder, type TableReorderProps } from './kanban-table-dnd'
import { useKanbanViewMemory } from './kanban-view-memory'

interface KanbanTableViewProps {
  data: KanbanData
  view?: KanbanView
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  onToggleAll: (ids: string[]) => void
  onOpenDetail: (item: KanbanItem) => void
  onUpdateProperty: (itemId: string, propertyId: string, value: unknown) => void
  onUpdateMultiSelect: (itemId: string, columnId: string, values: string[], newOption?: KanbanOption) => void
  onUpdateSubtasks?: (itemId: string, subtasks: KanbanSubtask[]) => void
  onUpdateFiles: (itemId: string, files: KanbanFile[]) => void
  onAddItem: (propertyDefaults?: Record<string, unknown>) => void
  onAddColumn: () => void
  onSortColumn: (propertyId: string) => void
  /** Absent when nothing can store a width, which is also what removes the resize handles. */
  onResizeColumn?: (propertyId: string, width: number | undefined) => void
  /** Who the member picker may offer, per member column. Derived from every card on the board, so
   *  a filter cannot make a teammate unassignable. */
  people: Record<string, string[]>
  /** KU-21c: the row move a drag or an arrow key makes, resolved by the board's writer. */
  onReorderRows?: (move: KanbanRowMove) => void
}

interface TableHeaderRowProps {
  columns: KanbanProperty[]
  hiddenColumns?: string[]
  sorts: KanbanSort[]
  isAllSelected: boolean
  onToggleAll: () => void
  onSortColumn: (propertyId: string) => void
  onResizeColumn?: (propertyId: string, width: number | undefined) => void
}

function TableHeaderRow({ columns, hiddenColumns, sorts, isAllSelected, onToggleAll, onSortColumn, onResizeColumn }: TableHeaderRowProps) {
  const titleColumn = kanbanTitleColumn(columns)
  const sortFor = (columnId: string) => sorts.find((sort) => sort.propertyId === columnId)
  return (
    <div role='row' className='flex items-center border-b border-[var(--border-subtle)] bg-[var(--bg-raised)] text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]'>
      <div role='columnheader' className='w-[var(--sp-10)] shrink-0 p-[var(--sp-2-5)] text-center'>
        <input
          type='checkbox'
          checked={isAllSelected}
          onChange={onToggleAll}
          className='size-3.5 rounded-[var(--r-xs)] border-[var(--border-default)] accent-[var(--accent)]'
          aria-label={t('preview.kanban_select_all')}
        />
      </div>
      <KanbanTableHeaderCell
        column={titleColumn}
        sort={sortFor(titleColumn.id)}
        onSort={onSortColumn}
        onResize={onResizeColumn}
      />
      {kanbanPropertyColumns(columns, hiddenColumns).map((column) => (
        <KanbanTableHeaderCell
          key={column.id}
          column={column}
          sort={sortFor(column.id)}
          onSort={onSortColumn}
          onResize={onResizeColumn}
        />
      ))}
    </div>
  )
}

function useTableToggleAll(
  items: KanbanItem[],
  selectedIds: Set<string>,
  onToggleAll: (ids: string[]) => void,
) {
  const isAllSelected = items.length > 0 && selectedIds.size === items.length
  // One batch commit: per-row toggles would queue one state update per item.
  const handleToggleAll = () => onToggleAll(items.map((item) => item.id))
  return { isAllSelected, handleToggleAll }
}

interface TableGroupListProps {
  groups: KanbanGroup[]
  /** Which groups the reader folded away, and the one writer that folds them (see `kanban-view-memory.ts`). */
  collapsedGroups: ReadonlySet<string>
  onToggleGroup: (groupKey: string) => void
  groupByProp: string
  columns: KanbanProperty[]
  hiddenColumns?: string[]
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  onOpenDetail: (item: KanbanItem) => void
  onUpdateProperty: (itemId: string, propertyId: string, value: unknown) => void
  onUpdateMultiSelect: (itemId: string, columnId: string, values: string[], newOption?: KanbanOption) => void
  onUpdateSubtasks?: (itemId: string, subtasks: KanbanSubtask[]) => void
  onUpdateFiles: (itemId: string, files: KanbanFile[]) => void
  onAddItem: (propertyDefaults?: Record<string, unknown>) => void
  onAddColumn: () => void
  /** Who the member picker may offer, per member column. */
  people: Record<string, string[]>
  /** KU-21c: the rows' shared gesture, measured against the whole board's item order. */
  reorder?: TableReorderProps
}

function TableGroupList({
  groups,
  collapsedGroups,
  onToggleGroup,
  groupByProp,
  columns,
  hiddenColumns,
  selectedIds,
  onToggleSelect,
  onOpenDetail,
  onUpdateProperty,
  onUpdateMultiSelect,
  onUpdateSubtasks,
  onUpdateFiles,
  onAddItem,
  onAddColumn,
  people,
  reorder,
}: TableGroupListProps) {
  const columnCount = kanbanTableColumnCount(columns, hiddenColumns)
  return (
    <div role='presentation' className='p-[var(--sp-3)]'>
      {groups.map((group) => (
        <KanbanTableGroup
          key={group.groupKey}
          groupKey={group.groupKey}
          collapsed={collapsedGroups.has(group.groupKey)}
          onToggleCollapse={() => onToggleGroup(group.groupKey)}
          label={group.label}
          color={group.color}
          wipLimit={group.wipLimit}
          items={group.items}
          columns={columns}
          hiddenColumns={hiddenColumns}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          onOpenDetail={onOpenDetail}
          onUpdateProperty={onUpdateProperty}
          onUpdateMultiSelect={onUpdateMultiSelect}
          onUpdateSubtasks={onUpdateSubtasks}
          onUpdateFiles={onUpdateFiles}
          people={people}
          onAddItemInGroup={() => {
            const defaults = group.groupKey !== '__none__' ? { [groupByProp]: group.groupKey } : {}
            onAddItem(defaults)
          }}
          reorder={reorder}
        />
      ))}

      <div role='row'>
        <div role='cell' aria-colspan={columnCount}>
          <button
            type='button'
            onClick={onAddColumn}
            className='flex items-center gap-[var(--sp-1-5)] rounded-[var(--r-md)] border border-dashed border-[var(--border-default)] px-[var(--sp-3)] py-[var(--sp-1-5)] text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]'
          >
            <Plus size={14} />
            <span>+ {t('preview.kanban_add_new_group')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

export const KanbanTableView = memo(function KanbanTableView({
  data,
  view,
  selectedIds,
  onToggleSelect,
  onToggleAll,
  onOpenDetail,
  onUpdateProperty,
  onUpdateMultiSelect,
  onUpdateSubtasks,
  onUpdateFiles,
  onAddItem,
  onAddColumn,
  onSortColumn,
  onResizeColumn,
  people,
  onReorderRows,
}: KanbanTableViewProps) {
  useLocaleRepaint()
  const memory = useKanbanViewMemory(view?.id)
  const groupByProp = view?.groupBy || 'status'
  const groupCol = data.columns.find((c) => c.id === groupByProp)
  const groups = groupKanbanItems(data.items, groupByProp, groupCol)
  const { isAllSelected, handleToggleAll } = useTableToggleAll(data.items, selectedIds, onToggleAll)
  // KU-21c: the rows' own drag and keyboard walk. The gesture reports moves; the writer resolves
  // them against the whole board's item order, which is what the rows are drawn in.
  const reorder = useKanbanTableReorder({ groupPropertyId: groupByProp, onMove: onReorderRows ?? (() => {}) })

  return (
    <div className='h-full w-full overflow-auto p-[var(--sp-4)]'>
      <div role='table' aria-label={t('preview.kanban_view_table')} className='w-full min-w-max rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]'>
        <TableHeaderRow
          columns={data.columns}
          hiddenColumns={view?.hiddenColumns}
          sorts={view?.sorts ?? []}
          isAllSelected={isAllSelected}
          onToggleAll={handleToggleAll}
          onSortColumn={onSortColumn}
          onResizeColumn={onResizeColumn}
        />
        <TableGroupList
          groups={groups}
          collapsedGroups={memory.folds}
          onToggleGroup={memory.toggleFold}
          groupByProp={groupByProp}
          reorder={onReorderRows ? reorder : undefined}
          columns={data.columns}
          hiddenColumns={view?.hiddenColumns}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          onOpenDetail={onOpenDetail}
          onUpdateProperty={onUpdateProperty}
          onUpdateMultiSelect={onUpdateMultiSelect}
          onUpdateSubtasks={onUpdateSubtasks}
          onUpdateFiles={onUpdateFiles}
          onAddItem={onAddItem}
          onAddColumn={onAddColumn}
          people={people}
        />
      </div>
    </div>
  )
})

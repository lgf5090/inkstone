import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { t } from '../../../i18n'
import { formatKanbanGroupLabel } from '../i18n-helpers'
import { kanbanStatusColumn } from '../view-ops'
import type { KanbanColorName, KanbanFile, KanbanItem, KanbanOption, KanbanProperty, KanbanSubtask } from '../types'
import { KanbanColumnCount } from './kanban-column-count'
import { KanbanProgressBar } from './kanban-progress-bar'
import { kanbanTableColumnCount } from './kanban-property-cell'
import { KanbanRenderTail, useKanbanRenderWindow } from './kanban-render-window'
import type { TableReorderProps } from './kanban-table-dnd'
import { KanbanTableRow } from './kanban-table-row'

interface KanbanTableGroupProps {
  groupKey: string
  /** Whether the reader folded this group away. The board's memory holds it, not this group. */
  collapsed: boolean
  onToggleCollapse: () => void
  label: string
  color?: KanbanColorName
  wipLimit?: number
  items: KanbanItem[]
  columns: KanbanProperty[]
  hiddenColumns?: string[]
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  onOpenDetail: (item: KanbanItem) => void
  onUpdateProperty: (itemId: string, propertyId: string, value: unknown) => void
  onUpdateMultiSelect: (itemId: string, columnId: string, values: string[], newOption?: KanbanOption) => void
  onUpdateSubtasks?: (itemId: string, subtasks: KanbanSubtask[]) => void
  onUpdateFiles: (itemId: string, files: KanbanFile[]) => void
  /** Who the member picker may offer, per member column. */
  people?: Record<string, string[]>
  onAddItemInGroup: () => void
  /** KU-21c: the rows' shared drag and keyboard walk, owned by the table that draws them. */
  reorder?: TableReorderProps
}

function GroupHeader({
  collapsed,
  localizedLabel,
  color,
  count,
  wipLimit,
  columnCount,
  onToggleCollapse,
  onAddItem,
}: {
  collapsed: boolean
  localizedLabel: string
  color?: KanbanColorName
  count: number
  wipLimit?: number
  columnCount: number
  onToggleCollapse: () => void
  onAddItem: () => void
}) {
  const colorVar = color ? `var(--kanban-tag-${color}-fg)` : 'var(--accent)'
  return (
    <div role='row' className='border-y border-[var(--border-subtle)] bg-[var(--bg-raised)] px-3 py-2 text-[length:var(--text-13)] font-semibold'>
      <div role='cell' aria-colspan={columnCount} className='flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <button
            type='button'
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-label={t(collapsed ? 'preview.kanban_expand_group_named' : 'preview.kanban_collapse_group_named', { name: localizedLabel })}
            className='text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
          >
            {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
          </button>
          <span style={{ color: colorVar }}>{localizedLabel}</span>
          <KanbanColumnCount
            count={count}
            limit={wipLimit}
            className='rounded-[var(--r-full)] bg-[var(--bg-hover)] px-2 py-0.5 text-[length:var(--text-10)]'
          />
        </div>

        <button
          type='button'
          onClick={onAddItem}
          className='flex items-center gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]'
        >
          <Plus size={13} />
          <span>{t('preview.kanban_new_item')}</span>
        </button>
      </div>
    </div>
  )
}

const GROUP_PROGRESS_HEIGHT = 6

function GroupFooter({
  items,
  columns,
  columnCount,
  onAddItem,
}: {
  items: KanbanItem[]
  columns: KanbanProperty[]
  columnCount: number
  onAddItem: () => void
}) {
  const statusCol = kanbanStatusColumn(columns)
  return (
    <div role='row' className='border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-2 text-[length:var(--text-11)]'>
      <div role='cell' aria-colspan={columnCount} className='flex items-center justify-between'>
        <button
          type='button'
          onClick={onAddItem}
          className='flex items-center gap-1.5 text-[var(--text-tertiary)] hover:text-[var(--accent)]'
        >
          <Plus size={13} />
          <span>+ {t('preview.kanban_new_item')}</span>
        </button>

        <div className='w-48'>
          <KanbanProgressBar items={items} statusColumn={statusCol} height={GROUP_PROGRESS_HEIGHT} />
        </div>
      </div>
    </div>
  )
}

export function KanbanTableGroup({
  groupKey,
  collapsed,
  onToggleCollapse,
  label,
  color,
  wipLimit,
  items,
  columns,
  hiddenColumns,
  selectedIds,
  onToggleSelect,
  onOpenDetail,
  onUpdateProperty,
  onUpdateMultiSelect,
  onUpdateSubtasks,
  onUpdateFiles,
  people,
  onAddItemInGroup,
  reorder,
}: KanbanTableGroupProps) {
  const { visible, hiddenCount, setTailElement, revealMore } = useKanbanRenderWindow(items)
  const localizedLabel = formatKanbanGroupLabel(groupKey, label)
  const columnCount = kanbanTableColumnCount(columns, hiddenColumns)

  return (
    <div data-kanban-group={groupKey} role='rowgroup' className='mb-6 overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] shadow-2xs'>
      <GroupHeader
        collapsed={collapsed}
        localizedLabel={localizedLabel}
        color={color}
        count={items.length}
        wipLimit={wipLimit}
        columnCount={columnCount}
        onToggleCollapse={onToggleCollapse}
        onAddItem={onAddItemInGroup}
      />

      {!collapsed && (
        <>
          <div role='presentation' className='flex flex-col'>
            {visible.map((item) => (
              <KanbanTableRow
                key={item.id}
                item={item}
                columns={columns}
                hiddenColumns={hiddenColumns}
                isSelected={selectedIds.has(item.id)}
                onToggleSelect={() => onToggleSelect(item.id)}
                onOpenDetail={() => onOpenDetail(item)}
                onUpdateProperty={onUpdateProperty}
                onUpdateMultiSelect={onUpdateMultiSelect}
                onUpdateSubtasks={onUpdateSubtasks}
                onUpdateFiles={onUpdateFiles}
                people={people}
                reorder={reorder}
              />
            ))}
            <KanbanRenderTail hiddenCount={hiddenCount} setTailElement={setTailElement} onReveal={revealMore} columnCount={columnCount} />
          </div>
          <GroupFooter items={items} columns={columns} columnCount={columnCount} onAddItem={onAddItemInGroup} />
        </>
      )}
    </div>
  )
}

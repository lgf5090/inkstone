import { useMemo } from 'react'
import type {
  KanbanColumnPatch,
  KanbanData,
  KanbanFile,
  KanbanItem,
  KanbanOption,
  KanbanSubtask,
} from '../types'
import type { KanbanMovePivot, KanbanRowMove } from '../dnd'
import type { KanbanBoardCell } from '../swimlane'
import { KanbanBoardView } from './kanban-board-view'
import { KanbanCalendarView } from './kanban-calendar-view'
import { KanbanChartView } from './kanban-chart-view'
import { KanbanGalleryView } from './kanban-gallery-view'
import { KanbanGanttView } from './kanban-gantt-view'
import { KanbanListView } from './kanban-list-view'
import { KanbanTableView } from './kanban-table-view'
import { KanbanTimelineView } from './kanban-timeline-view'
import type { CardSize } from './kanban-view-options'

interface KanbanViewRendererProps {
  activeView: KanbanData['views'][number]
  viewData: KanbanData
  data: KanbanData
  selectedIds: Set<string>
  cardSize?: CardSize
  selectedTags?: string[]
  onToggleTag?: (tag: string) => void
  /** One item's own fields, handed down with an identity that outlives a render (see K-19). */
  handleUpdateSubtasks: (itemId: string, subtasks: KanbanSubtask[]) => void
  handleUpdateProperty: (itemId: string, propertyId: string, value: unknown) => void
  /** A bar dragged on a time view: the days it spans, as one patch and one commit. */
  handleRescheduleItem: (itemId: string, patch: Record<string, string>) => void
  /** KU-21c: the table's row move, resolved against the document's item order, in one commit. */
  handleReorderRows: (move: KanbanRowMove) => void
  handleToggleSelect: (id: string) => void
  handleToggleAll: (ids: string[]) => void
  setDetailItem: (item: KanbanItem | null) => void
  handleUpdateTitle: (id: string, title: string) => void
  handleUpdateFiles: (id: string, files: KanbanFile[]) => void
  handleUpdateMultiSelect: (itemId: string, columnId: string, values: string[], newOption?: KanbanOption) => void
  handleMoveItem: (itemId: string, cell: KanbanBoardCell, pivot?: KanbanMovePivot) => void
  /** The same drop with the picked cards behind it; absent where the board cannot batch. */
  handleMoveSelection?: (itemId: string, cell: KanbanBoardCell, pivot?: KanbanMovePivot) => void
  handleAddItem: (defaults?: Record<string, unknown>) => void
  handleAddItemInGroup: (cell?: KanbanBoardCell) => void
  handleAddColumn: () => void
  handleUpdateView: (patch: Partial<KanbanData['views'][number]>) => void
  handleToggleSortColumn: (propertyId: string) => void
  handleReorderColumns: (sourceGroupKey: string, targetGroupKey: string) => void
  handleUpdateColumn: (groupKey: string, patch: KanbanColumnPatch) => void
  handleDeleteColumn: (groupKey: string) => void
  handleResizeColumn: (propertyId: string, width: number | undefined) => void
  people: Record<string, string[]>
  handleUpdateTags?: (id: string, tags: string[], newOption?: KanbanOption) => void
  handleAddColumnOption?: (columnId: string, option: KanbanOption) => void
}

function KanbanTimelineViews(props: KanbanViewRendererProps) {
  const { activeView, viewData, setDetailItem, handleAddItem, handleUpdateProperty, handleRescheduleItem } = props
  // The band's own slider writes one property; the writer is the board's, so a drag through the
  // chart does not hand the view a new prop on every frame.
  const progressKey = activeView.progressField || 'progress'
  const onUpdateProgress = useMemo(
    () => (id: string, progress: number) => handleUpdateProperty(id, progressKey, progress),
    [handleUpdateProperty, progressKey],
  )
  if (activeView.type === 'calendar') {
    return (
      <KanbanCalendarView
        data={viewData}
        view={activeView}
        onOpenDetail={setDetailItem}
        onAddItem={handleAddItem}
        onMoveItem={handleRescheduleItem}
      />
    )
  }
  if (activeView.type === 'timeline') {
    return (
      <KanbanTimelineView
        data={viewData}
        view={activeView}
        onOpenDetail={setDetailItem}
        onAddItem={handleAddItem}
        onReschedule={handleRescheduleItem}
      />
    )
  }
  return (
    <KanbanGanttView
      data={viewData}
      view={activeView}
      onOpenDetail={setDetailItem}
      onAddItem={handleAddItem}
      onUpdateProgress={onUpdateProgress}
      onReschedule={handleRescheduleItem}
    />
  )
}

function BoardTableView(props: KanbanViewRendererProps) {
  if (props.activeView.type === 'board') {
    return (
      <KanbanBoardView
        data={props.viewData}
        view={props.activeView}
        selectedIds={props.selectedIds}
        cardSize={props.cardSize}
        selectedTags={props.selectedTags}
        onToggleTag={props.onToggleTag}
        onToggleSelect={props.handleToggleSelect}
        onToggleAll={props.handleToggleAll}
        onOpenDetail={props.setDetailItem}
        onUpdateTitle={props.handleUpdateTitle}
        onUpdateSubtasks={props.handleUpdateSubtasks}
        onMoveItem={props.handleMoveItem}
        onMoveSelection={props.handleMoveSelection}
        onAddItem={props.handleAddItemInGroup}
        onAddColumn={props.handleAddColumn}
        onReorderColumns={props.handleReorderColumns}
        onUpdateColumn={props.handleUpdateColumn}
        onDeleteColumn={props.handleDeleteColumn}
        onUpdateTags={props.handleUpdateTags}
        onAddColumnOption={props.handleAddColumnOption}
      />
    )
  }
  return (
    <KanbanTableView
      data={props.viewData}
      view={props.activeView}
      selectedIds={props.selectedIds}
      onToggleSelect={props.handleToggleSelect}
      onToggleAll={props.handleToggleAll}
      onOpenDetail={props.setDetailItem}
      onUpdateProperty={props.handleUpdateProperty}
      onUpdateSubtasks={props.handleUpdateSubtasks}
      onUpdateFiles={props.handleUpdateFiles}
      onUpdateMultiSelect={props.handleUpdateMultiSelect}
      onAddItem={props.handleAddItem}
      onAddColumn={props.handleAddColumn}
      onSortColumn={props.handleToggleSortColumn}
      onResizeColumn={props.handleResizeColumn}
      people={props.people}
      onReorderRows={props.handleReorderRows}
    />
  )
}

function ListGalleryView(props: KanbanViewRendererProps) {
  if (props.activeView.type === 'list') {
    return (
      <KanbanListView
        data={props.viewData}
        selectedIds={props.selectedIds}
        selectedTags={props.selectedTags}
        onToggleTag={props.onToggleTag}
        onToggleSelect={props.handleToggleSelect}
        onOpenDetail={props.setDetailItem}
        onAddItem={props.handleAddItem}
      />
    )
  }
  return (
    <KanbanGalleryView
      data={props.viewData}
      selectedIds={props.selectedIds}
      onToggleSelect={props.handleToggleSelect}
      onOpenDetail={props.setDetailItem}
      onAddItem={props.handleAddItem}        onUpdateSubtasks={props.handleUpdateSubtasks}
    />
  )
}

/**
 * The view half of the root: which of the eight views is on screen and what each one is handed.
 * Moved here from the root file as a pure cut (G-19) — the root's composition, wiring and state
 * stay where they were, and this file holds only the per-view switch and the props they share.
 */
export function KanbanViewRenderer(props: KanbanViewRendererProps) {
  const type = props.activeView.type
  if (type === 'chart') {
    return (
      <KanbanChartView
        data={props.viewData}
        view={props.activeView}
        onUpdateView={props.handleUpdateView}
      />
    )
  }
  if (type === 'calendar' || type === 'timeline' || type === 'gantt') {
    return <KanbanTimelineViews {...props} />
  }
  if (type === 'board' || type === 'table') {
    return <BoardTableView {...props} />
  }
  return <ListGalleryView {...props} />
}

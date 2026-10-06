import { memo, useId, useMemo, useRef, type RefObject } from 'react'
import { useLocaleRepaint } from '../../../i18n'
import type { KanbanData } from '../types'
import { KanbanBatchBar } from './kanban-batch-bar'
import type { KanbanBatchEdits } from './kanban-batch-bar'
import { KanbanRootOverlays } from './kanban-overlays'
import { useKanbanCsvEntry } from './kanban-csv'
import { KanbanDueNotice } from './kanban-due-notice'
import { KanbanEmptyBoard } from './kanban-empty-board'
import { useKanbanExportEntry } from './kanban-export'
import { applyKanbanTemplate } from '../templates'
import { KanbanFilesScope } from './kanban-files-cell'
import { KanbanHeader } from './kanban-header'
import { kanbanViewTabId } from './kanban-view-tabs'
import { KanbanViewRenderer } from './kanban-view-renderer'
import { useKanbanRegionLabel } from './kanban-region'
import { KanbanViewMemoryScope, useKanbanViewMemoryStore } from './kanban-view-memory'
import { kanbanTagsColumn } from '../view-ops'
import { useKanbanContextMenuState, useKanbanRootState } from './kanban-root-hooks'
import { useKanbanBoardKeys } from './kanban-board-keys'
import { useKanbanSurface } from './kanban-surface'

interface KanbanRootProps {
  initialData: KanbanData
  isFullscreen?: boolean
  kanbanName?: string
  unsaved?: boolean
  sourceData?: KanbanData
  onRetryWrite?: () => void
  onDiscardWrite?: () => void
  onUpdateData: (data: KanbanData) => void
  onToggleFullscreen?: () => void
  /** Passed down from the mount options: how the host renders description markdown. */
  renderDescription?: (source: string) => string
}

function KanbanTopBar({
  state,
  isFullscreen,
  unsaved,
  sourceData,
  viewPanelId,
  viewPanelRef,
  onRetryWrite,
  onDiscardWrite,
  onToggleFullscreen,
}: {
  state: ReturnType<typeof useKanbanRootState>
  isFullscreen?: boolean
  unsaved?: boolean
  sourceData?: KanbanData
  viewPanelId: string
  viewPanelRef: RefObject<HTMLDivElement | null>
  onRetryWrite?: () => void
  onDiscardWrite?: () => void
  onToggleFullscreen?: () => void
}) {
  const csv = useKanbanCsvEntry(state.data, state.commitData)
  const exportEntry = useKanbanExportEntry(state.data, state.filterSort.activeView.type, viewPanelRef)
  return (
    <KanbanHeader
      data={state.data}
      visibleItems={state.filterSort.viewData.items}
      activeView={state.filterSort.activeView}
      searchQuery={state.filterSort.searchQuery}
      filters={state.filterSort.filters}
      sorts={state.filterSort.sorts}
      selectedTags={state.filterSort.selectedTags}
      cardSize={state.filterSort.cardSize}
      isFullscreen={isFullscreen}
      canUndo={state.history.canUndo}
      canRedo={state.history.canRedo}
      onUndo={state.history.undo}
      onRedo={state.history.redo}
      onUpdateBoardTitle={state.handleUpdateBoardTitle}
      onSelectView={state.setActiveViewId}
      viewOps={state.viewOps}
      schemaOps={state.schemaOps}
      onSearchChange={state.filterSort.setSearchQuery}
      onChangeFilters={state.filterSort.setFilters}
      onChangeSorts={state.filterSort.setSorts}
      onToggleTag={state.filterSort.onToggleTag}
      onClearTags={state.filterSort.onClearTags}
      onChangeCardSize={state.filterSort.setCardSize}
      onChangeGroupBy={state.columnOps.handleChangeGroupBy}
      onChangeSwimlaneBy={(propId) => state.filterSort.updateActiveView({ swimlaneBy: propId })}
      onChangeSumBy={(propId) => state.filterSort.updateActiveView({ sumBy: propId })}
      onToggleHiddenColumn={state.filterSort.toggleHiddenColumn}
      onToggleCardField={state.filterSort.toggleCardField}
      onAddItem={() => state.adds.handleAddItem()}
      onToggleFullscreen={onToggleFullscreen}
      archive={state.archive}
      csv={csv}
      exportEntry={exportEntry}
      viewPanelId={viewPanelId}
      unsaved={unsaved}
      onRetryWrite={onRetryWrite}
      onDiscardWrite={sourceData && onDiscardWrite ? () => {
        state.commitData(sourceData)
        onDiscardWrite()
      } : undefined}
    />
  )
}

// What fills the panel turns on one question: does this board hold a card anywhere? A board that holds
// none has nothing for any view to lay out, so the guide stands in for the view; a board that merely
// looks empty — filtered down, or with its cards archived — keeps showing what it has.
function KanbanViewArea({ state }: { state: ReturnType<typeof useKanbanRootState> }) {
  if (state.data.items.length === 0) {
    return (
      <KanbanEmptyBoard
        onAddItem={state.adds.handleAddItem}
        // Resolving against the newest document keeps this one commit, so one undo step takes the
        // whole structure back off rather than leaving half of a blueprint behind.
        onApplyTemplate={(kind) => state.commitData((prev) => applyKanbanTemplate(prev, kind))}
      />
    )
  }
  return (
    <KanbanViewRenderer
      activeView={state.filterSort.activeView}
      viewData={state.filterSort.viewData}
      data={state.data}
      selectedIds={state.selection.selectedIds}
      cardSize={state.filterSort.cardSize}
      selectedTags={state.filterSort.selectedTags}
      onToggleTag={state.filterSort.onToggleTag}
      handleUpdateSubtasks={state.items.handleUpdateSubtasks}
      handleUpdateProperty={state.items.handleUpdateProperty}
      handleRescheduleItem={state.items.handleRescheduleItem}
      handleReorderRows={state.items.handleReorderRows}
      handleToggleSelect={state.selection.handleToggleSelect}
      handleToggleAll={state.selection.handleToggleAll}
      setDetailItem={state.setDetailItem}
      handleUpdateTitle={state.items.handleUpdateTitle}
      handleUpdateFiles={state.items.handleUpdateFiles}
      handleUpdateMultiSelect={state.items.handleUpdateMultiSelect}
      handleMoveItem={state.items.handleMoveItem}
      handleMoveSelection={state.selection.handleBatchMove}
      handleAddItem={state.adds.handleAddItem}
      handleAddItemInGroup={state.adds.handleAddItemInGroup}
      handleAddColumn={state.adds.handleAddColumn}
      handleUpdateView={state.filterSort.updateActiveView}
      handleToggleSortColumn={state.filterSort.toggleSortColumn}
      handleReorderColumns={state.columnOps.handleReorderColumns}
      handleUpdateColumn={state.columnOps.handleUpdateColumn}
      handleDeleteColumn={state.columnOps.handleDeleteColumn}
      handleResizeColumn={state.schemaOps.resizeColumn}
      people={state.people}
      handleUpdateTags={state.items.handleUpdateTags}
      handleAddColumnOption={state.columnOps.handleAddColumnOption}
    />
  )
}

/**
 * Which fields a batch can be rewritten with, read off this board: the member column decides who may
 * be assigned, the tag column which tags may be added. A field the board does not have is left out
 * rather than offered and then ignored.
 */
function useKanbanBatchEditFields(state: ReturnType<typeof useKanbanRootState>): KanbanBatchEdits {
  const { data, people, selection } = state
  return useMemo(() => {
    const personColumn = data.columns.find((column) => column.type === 'person')
    const assigns = personColumn ? people[personColumn.id] : undefined
    const tagsColumn = kanbanTagsColumn(data.columns)
    return {
      assignees: assigns ?? [],
      tags: tagsColumn?.options ?? [],
      onAssign: (name) => selection.handleBatchSetProperty(personColumn!.id, name),
      onAddTag: (tagId) => tagsColumn && selection.handleBatchAddTag(tagsColumn.id, tagId),
      onSetDueDate: (date) => selection.handleBatchSetProperty('dueDate', date),
    }
  }, [data.columns, people, selection])
}

function KanbanMain({
  state,
  viewPanelId,
  viewPanelRef,
}: {
  state: ReturnType<typeof useKanbanRootState>
  viewPanelId: string
  viewPanelRef: RefObject<HTMLDivElement | null>
}) {
  const batchEdits = useKanbanBatchEditFields(state)
  return (
    // The selected view is what its tab controls, so this box is the panel; hanging the role here
    // rather than on a wrapper keeps the geometry untouched and avoids a second landmark in the shell.
    <div
      ref={viewPanelRef}
      id={viewPanelId}
      role='tabpanel'
      // Which view is on screen, as an attribute rather than only through the tab that controls it:
      // the visual gate opens each view in turn and has to know it is reading that view's own tree.
      data-kanban-view-type={state.filterSort.activeView.type}
      aria-labelledby={kanbanViewTabId(viewPanelId, state.filterSort.activeView.id)}
      className='relative flex-1 overflow-hidden'
    >
      <KanbanViewArea state={state} />
      <KanbanBatchBar
        selectedCount={state.selection.selectedIds.size}
        groupColumn={state.groupColumn}
        onBatchGroupChange={state.selection.handleBatchGroupChange}
        onBatchArchive={() => state.handleArchiveItems(state.selection.selectedIds)}
        onBatchDelete={state.selection.handleBatchDelete}
        onClearSelection={state.selection.handleClearSelection}
        edits={batchEdits}
      />
    </div>
  )
}

/**
 * What this board owes the DOM node it was mounted into: the palette's handle on it, the landmark name the
 * host's canvas carries, and the keyboard the reader drives the board with. One call rather than three
 * because they are one concern — and the root's own body is at its line budget (`size:check`).
 */
function useKanbanContainerWiring(
  containerRef: RefObject<HTMLDivElement | null>,
  state: ReturnType<typeof useKanbanRootState>,
): void {
  useKanbanSurface(containerRef, state)
  useKanbanRegionLabel(containerRef)
  useKanbanBoardKeys(containerRef, state.items.handleDeleteItem)
}

/**
 * The root's own state before anything renders: the container the host hands over, the panel id the
 * header's tabs and the view's panel share, the panel element both export doors rasterize or print
 * (KU-24 — the header holds the doors, the view is drawn by the other branch, so the element travels
 * by ref), and the board state and context menu the two branches read.
 */
function useKanbanRootSetup(
  initialData: KanbanData,
  onUpdateData: (next: KanbanData) => void,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewPanelId = useId()
  const viewPanelRef = useRef<HTMLDivElement>(null)
  const state = useKanbanRootState(initialData, onUpdateData, containerRef)
  const menu = useKanbanContextMenuState(state.data, state.commitData)
  // How each view was last left, shared because the views take turns being on screen (see the module).
  const viewMemory = useKanbanViewMemoryStore()
  useKanbanContainerWiring(containerRef, state)
  return { containerRef, viewPanelId, viewPanelRef, state, menu, viewMemory }
}

export const KanbanRoot = memo(function KanbanRoot({
  initialData,
  isFullscreen,
  kanbanName,
  unsaved,
  sourceData,
  onRetryWrite,
  onDiscardWrite,
  onUpdateData,
  onToggleFullscreen,
  renderDescription,
}: KanbanRootProps) {
  // A host tree React did not make never re-renders this root, so the board listens
  // for language changes itself rather than trusting a mount option to carry them.
  // (In the memo body directly: the locale-repaint policy test reads it here.)
  useLocaleRepaint()
  const { containerRef, viewPanelId, viewPanelRef, state, menu, viewMemory } = useKanbanRootSetup(initialData, onUpdateData)

  return (
    <div
      ref={containerRef}
      // Clicking board whitespace focuses this container, so board-scoped
      // shortcuts (undo/redo) keep working when no card holds focus.
      tabIndex={-1}
      onContextMenu={menu.handleContextMenu}
      // The plane the columns stand on, and the board's own root is where it belongs: it is the same
      // board inline and in the overlay, so the surface has to have one owner rather than one per
      // host (the note's block and the overlay's stage are both `--bg-inset` for it to sit on).
      className='flex h-full w-full flex-col overflow-hidden bg-[var(--bg-inset)] text-[var(--text-primary)]'
    >
      <KanbanViewMemoryScope.Provider value={viewMemory}>
      <KanbanFilesScope.Provider value={kanbanName || 'default'}>
        <KanbanTopBar
          state={state}
          isFullscreen={isFullscreen}
          unsaved={unsaved}
          sourceData={sourceData}
          viewPanelId={viewPanelId}
          viewPanelRef={viewPanelRef}
          onRetryWrite={onRetryWrite}
          onDiscardWrite={onDiscardWrite}
          onToggleFullscreen={onToggleFullscreen}
        />
        <KanbanDueNotice
          items={state.data.items}
          columns={state.data.columns}
          dateField={state.filterSort.activeView.dateField}
          onApplyFilters={(filters) => state.filterSort.updateActiveView({ filters })}
        />
        <KanbanMain state={state} viewPanelId={viewPanelId} viewPanelRef={viewPanelRef} />
        <KanbanRootOverlays
          state={state}
          menu={menu}
          isFullscreen={isFullscreen}
          renderDescription={renderDescription}
          onToggleFullscreen={onToggleFullscreen}
        />        </KanbanFilesScope.Provider>
      </KanbanViewMemoryScope.Provider>
      </div>
  )
})


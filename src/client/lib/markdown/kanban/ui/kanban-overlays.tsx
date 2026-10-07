import { useMemo } from 'react'
import { KanbanContextMenu } from './kanban-context-menu'
import { KanbanItemDetail } from './kanban-item-detail'
import type { useKanbanContextMenuState, useKanbanRootState } from './kanban-root-hooks'

interface KanbanOverlayProps {
  state: ReturnType<typeof useKanbanRootState>
  menu: ReturnType<typeof useKanbanContextMenuState>
  isFullscreen?: boolean
  onToggleFullscreen?: () => void
  renderDescription?: (source: string) => string
}

export function KanbanRootOverlays({
  state,
  menu,
  isFullscreen,
  onToggleFullscreen,
  renderDescription,
}: KanbanOverlayProps) {
  return (
    <>
      <KanbanItemDetail
        item={state.detailItem}
        columns={state.data.columns}
        people={state.people}
        // The board and the card are read together in the overlay, which has the room for both.
        variant={isFullscreen ? 'peek' : 'dialog'}
        onClose={() => state.setDetailItem(null)}
        onUpdate={state.items.handleUpdateItem}
        onDelete={state.items.handleDeleteItem}
        boardItems={state.data.items}
        onChangeDependencies={state.items.handleChangeDependencies}
        onConvertSubtask={(subtaskId) => {
          if (state.detailItem) state.items.handleConvertSubtaskToItem(state.detailItem.id, subtaskId)
        }}
        onAddColumnOption={state.columnOps.handleAddColumnOption}
        renderDescription={renderDescription}
      />
      <KanbanMenuOverlay
        state={state}
        menu={menu}
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
      />
    </>
  )
}

/**
 * The menu a right click or a long press opens, wired to this board's document. Every card the active
 * view draws is gathered here — that is what "all" means to a reader looking at this view, once the
 * search and the filters have had their say — so the row that picks them needs no document of its own.
 */
function KanbanMenuOverlay({
  state,
  menu,
  isFullscreen,
  onToggleFullscreen,
}: Omit<KanbanOverlayProps, 'renderDescription'>) {
  const visibleIds = useMemo(
    () => state.filterSort.viewData.items.map((item) => item.id),
    [state.filterSort.viewData],
  )
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => state.selection.selectedIds.has(id))

  return (
    <KanbanContextMenu
      point={menu.point}
      targetItem={menu.targetItem}
      selectedCount={state.selection.selectedIds.size}
      activeView={state.filterSort.activeView}
      views={state.data.views}
      cardSize={state.filterSort.cardSize}
      canUndo={state.history.canUndo}
      canRedo={state.history.canRedo}
      isFullscreen={isFullscreen}
      onClose={menu.handleClose}
      onOpenDetail={state.setDetailItem}
      onDuplicateItem={menu.handleDuplicateItem}
      onArchiveItem={(item) => state.handleArchiveItems([item.id])}
      onDeleteItem={state.items.handleDeleteItem}
      onSelectAllVisible={() => state.selection.handleToggleAll(visibleIds)}
      allVisibleSelected={allVisibleSelected}
      groupOptions={state.moveToAxes.groupOptions}
      laneOptions={state.moveToAxes.laneOptions}
      onMoveItemToGroup={state.moveToAxes.handleMoveItemToGroup}
      onMoveItemToLane={state.moveToAxes.handleMoveItemToLane}
      onAddItem={() => state.adds.handleAddItem()}
      onAddColumn={state.adds.handleAddColumn}
      onSelectView={state.setActiveViewId}
      onChangeCardSize={state.filterSort.setCardSize}
      onBatchArchive={() => state.handleArchiveItems(state.selection.selectedIds)}
      onBatchDelete={state.selection.handleBatchDelete}
      onClearSelection={state.selection.handleClearSelection}
      onUndo={state.history.undo}
      onRedo={state.history.redo}
      onToggleFullscreen={onToggleFullscreen}
    />
  )
}

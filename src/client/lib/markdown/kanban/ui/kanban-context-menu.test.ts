import { beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { buildKanbanContextMenuItems, buildMoveToSubmenuItems, type KanbanContextMenuProps } from './kanban-context-menu'
import type { KanbanItem, KanbanOption, KanbanView } from '../types'

beforeAll(async () => {
  await initI18n()
})

const dummyItem: KanbanItem = {
  id: 'item-1',
  title: 'Test Task',
  properties: { status: 'todo' },
}

const dummyViews: KanbanView[] = [
  { id: 'view-board', name: 'Board', type: 'board', groupBy: 'status' },
  { id: 'view-table', name: 'Table', type: 'table' },
]

function createDummyProps(overrides: Partial<KanbanContextMenuProps> = {}): KanbanContextMenuProps {
  return {
    point: { x: 100, y: 100 },
    targetItem: null,
    selectedCount: 0,
    activeView: dummyViews[0]!,
    views: dummyViews,
    canUndo: false,
    canRedo: false,
    isFullscreen: false,
    onClose: vi.fn(),
    onAddItem: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    ...overrides,
  }
}

const statusOptions: KanbanOption[] = [
  { id: 'todo', label: 'To Do', color: 'gray' },
  { id: 'doing', label: 'Doing', color: 'blue' },
  { id: 'done', label: 'Done', color: 'green' },
]

describe('the destinations a card menu offers', () => {
  it('lists the groups the view draws, marks the one the card is in, and moves it', () => {
    const onMoveItemToGroup = vi.fn()
    const items = buildMoveToSubmenuItems(
      createDummyProps({ targetItem: dummyItem, groupOptions: statusOptions, onMoveItemToGroup }),
      dummyItem,
      'group',
    )
    expect(items.map((item) => item.id)).toEqual(['move-group-todo', 'move-group-doing', 'move-group-done'])
    expect(items.find((item) => item.id === 'move-group-todo')?.checked).toBe(true)
    expect(items.find((item) => item.id === 'move-group-doing')?.checked).toBe(false)
    items.find((item) => item.id === 'move-group-done')?.onSelect?.()
    expect(onMoveItemToGroup).toHaveBeenCalledWith('item-1', 'done')
  })

  it('offers nothing when the host cannot move cards, or the view groups by no options', () => {
    expect(buildMoveToSubmenuItems(createDummyProps({ targetItem: dummyItem }), dummyItem, 'group')).toEqual([])
    expect(
      buildMoveToSubmenuItems(
        createDummyProps({ targetItem: dummyItem, groupOptions: [], onMoveItemToGroup: vi.fn() }),
        dummyItem,
        'group',
      ),
    ).toEqual([])
  })
})

describe('the move-to rows a card menu grows', () => {
  it('reaches the card menu as a submenu row the reader can open', () => {
    const items = buildKanbanContextMenuItems(
      createDummyProps({ targetItem: dummyItem, groupOptions: statusOptions, onMoveItemToGroup: vi.fn() }),
    )
    const row = items.find((item) => item.id === 'kanban-item-move-group')
    expect(row, 'a card offered no way to change its group without dragging').toBeDefined()
    expect(row!.label).toBe(t('preview.kanban_move_to_column'))
    expect(row!.submenu).toBeDefined()
  })

  it('lists the rows of the board as destinations, one per option', () => {
    const onMoveItemToLane = vi.fn()
    const items = buildMoveToSubmenuItems(
      createDummyProps({
        targetItem: dummyItem,
        activeView: { ...dummyViews[0]!, groupBy: 'status', swimlaneBy: 'assignee' },
        laneOptions: [{ id: 'bob', label: 'Bob', color: 'blue' }],
        onMoveItemToLane,
      }),
      { ...dummyItem, properties: { status: 'todo', assignee: 'bob' } },
      'lane',
    )
    expect(items.map((item) => item.id)).toEqual(['move-lane-bob'])
    expect(items[0]!.checked).toBe(true)
    items[0]!.onSelect?.()
    expect(onMoveItemToLane).toHaveBeenCalledWith('item-1', 'bob')
  })
})

describe('the row that picks everything the view draws', () => {
  it('is offered whether the menu was opened on a card or on the board itself', () => {
    const onCard = buildKanbanContextMenuItems(
      createDummyProps({ targetItem: dummyItem, onSelectAllVisible: vi.fn() }),
    )
    const onCanvas = buildKanbanContextMenuItems(createDummyProps({ onSelectAllVisible: vi.fn() }))
    for (const items of [onCard, onCanvas]) {
      const row = items.find((item) => item.id === 'kanban-select-all-visible')
      expect(row?.label).toBe(t('preview.kanban_select_all_visible'))
      expect(row?.submenu).toBeUndefined()
    }
  })

  it('reads as a checkbox over the view, and reports the gesture', () => {
    const onSelectAllVisible = vi.fn()
    const row = buildKanbanContextMenuItems(
      createDummyProps({ onSelectAllVisible, allVisibleSelected: true }),
    ).find((item) => item.id === 'kanban-select-all-visible')
    expect(row?.checked).toBe(true)
    row?.onSelect?.()
    expect(onSelectAllVisible).toHaveBeenCalledOnce()
  })

  it('sits with the batch steps and before the way out of the selection', () => {
    const items = buildKanbanContextMenuItems(
      createDummyProps({
        selectedCount: 3,
        onBatchArchive: vi.fn(),
        onBatchDelete: vi.fn(),
        onClearSelection: vi.fn(),
        onSelectAllVisible: vi.fn(),
      }),
    )
    const ids = items.map((item) => item.id)
    expect(ids.indexOf('kanban-select-all-visible')).toBeGreaterThan(ids.indexOf('kanban-batch-delete'))
    expect(ids.indexOf('kanban-select-all-visible')).toBeLessThan(ids.indexOf('kanban-clear-selection'))
  })

  it('stays away where the host cannot pick cards at all', () => {
    const items = buildKanbanContextMenuItems(createDummyProps())
    expect(items.find((item) => item.id === 'kanban-select-all-visible')).toBeUndefined()
  })
})

describe('card context menu items', () => {
  it('triggers item-specific actions', () => {
    const onOpenDetail = vi.fn()
    const onDuplicateItem = vi.fn()
    const onDeleteItem = vi.fn()

    const items = buildKanbanContextMenuItems(
      createDummyProps({
        targetItem: dummyItem,
        onOpenDetail,
        onDuplicateItem,
        onDeleteItem,
      }),
    )

    items.find((i) => i.id === 'kanban-item-detail')?.onSelect?.()
    expect(onOpenDetail).toHaveBeenCalledWith(dummyItem)

    items.find((i) => i.id === 'kanban-item-duplicate')?.onSelect?.()
    expect(onDuplicateItem).toHaveBeenCalledWith(dummyItem)

    items.find((i) => i.id === 'kanban-item-delete')?.onSelect?.()
    expect(onDeleteItem).toHaveBeenCalledWith('item-1')
  })

  it('configures undo, redo and fullscreen for card menu', () => {
    const items = buildKanbanContextMenuItems(
      createDummyProps({
        targetItem: dummyItem,
        canUndo: true,
        canRedo: false,
        isFullscreen: true,
        onToggleFullscreen: vi.fn(),
      }),
    )

    expect(items.find((i) => i.id === 'kanban-undo')?.disabled).toBe(false)
    expect(items.find((i) => i.id === 'kanban-redo')?.disabled).toBe(true)
    expect(items.find((i) => i.id === 'kanban-toggle-fullscreen')?.combo).toBe('Esc')
  })


  // A literal 'Ctrl+Y' would be a dead promise on macOS, where `kanban-history.ts` binds
  // mod+Shift+Z; the canonical token is what lets the shared row render the real glyph.
  it('names the history chords in the canonical form the menu renders per platform', () => {
    const items = buildKanbanContextMenuItems(createDummyProps({ canUndo: true, canRedo: true }))
    expect(items.find((i) => i.id === 'kanban-undo')?.combo).toBe('mod+z')
    expect(items.find((i) => i.id === 'kanban-redo')?.combo).toBe('mod+shift+z')
  })
})

describe('board context menu items', () => {
  it('builds board actions when clicking on canvas', () => {
    const items = buildKanbanContextMenuItems(
      createDummyProps({
        onAddColumn: vi.fn(),
        onSelectView: vi.fn(),
        onChangeCardSize: vi.fn(),
        cardSize: 'medium',
      }),
    )

    expect(items.find((i) => i.id === 'kanban-new-item')).toBeDefined()
    expect(items.find((i) => i.id === 'kanban-new-group')).toBeDefined()
    expect(items.find((i) => i.id === 'kanban-switch-view')?.submenu).toBeDefined()
    expect(items.find((i) => i.id === 'kanban-card-size')?.submenu).toBeDefined()
  })

  it('includes batch delete and clear selection when items selected', () => {
    const items = buildKanbanContextMenuItems(
      createDummyProps({
        selectedCount: 3,
        onBatchDelete: vi.fn(),
        onClearSelection: vi.fn(),
      }),
    )

    expect(items.find((i) => i.id === 'kanban-batch-delete')?.label).toContain('3')
    expect(items.find((i) => i.id === 'kanban-clear-selection')).toBeDefined()
  })

})
describe('archive steps in the context menu', () => {  it('files the card away on the way to the trash, before it', () => {
    const onArchiveItem = vi.fn()
    const onDeleteItem = vi.fn()
    const items = buildKanbanContextMenuItems(
      createDummyProps({ targetItem: dummyItem, onArchiveItem, onDeleteItem }),
    )
    const order = items.map((i) => i.id)
    expect(order.indexOf('kanban-item-archive')).toBeLessThan(order.indexOf('kanban-item-delete'))
    items.find((i) => i.id === 'kanban-item-archive')?.onSelect?.()
    expect(onArchiveItem).toHaveBeenCalledWith(dummyItem)
  })

  it('offers no archive step where nothing can file a card away', () => {
    const items = buildKanbanContextMenuItems(createDummyProps({ targetItem: dummyItem, onDeleteItem: vi.fn() }))
    expect(items.find((i) => i.id === 'kanban-item-archive')).toBeUndefined()
  })
  it('files the whole selection away as one batch step', () => {
    const onBatchArchive = vi.fn()
    const items = buildKanbanContextMenuItems(
      createDummyProps({ selectedCount: 3, onBatchArchive, onBatchDelete: vi.fn(), onClearSelection: vi.fn() }),
    )
    const archive = items.find((i) => i.id === 'kanban-batch-archive')
    expect(archive?.label).toContain('3')
    archive?.onSelect?.()
    expect(onBatchArchive).toHaveBeenCalledOnce()
  })

  it('opens the batch group with one divider whichever of the two steps is present', () => {
    const dividers = (batch: Partial<KanbanContextMenuProps>) =>
      buildKanbanContextMenuItems(
        createDummyProps({
          selectedCount: 2,
          onClearSelection: vi.fn(),
          onUndo: undefined,
          onRedo: undefined,
          ...batch,
        }),
      )
        .filter((i) => i.separatorBefore)
        .map((i) => i.id)

    expect(dividers({ onBatchArchive: vi.fn() })).toEqual(['kanban-batch-archive'])
    expect(dividers({ onBatchDelete: vi.fn() })).toEqual(['kanban-batch-delete'])
    expect(dividers({ onBatchArchive: vi.fn(), onBatchDelete: vi.fn() })).toEqual(['kanban-batch-archive'])
  })
})

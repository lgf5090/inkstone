import {
  Archive,
  ArrowDownUp,
  ArrowRightLeft,
  CheckSquare,
  Copy,
  FileText,
  LayoutGrid,
  Maximize2,
  Minimize2,
  Plus,
  PlusSquare,
  Redo2,
  SlidersHorizontal,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { Menu, submenuFor, type MenuItem } from '../../../../components/overlay'
import { Z_INDEX } from '../../../../lib/z-index'
import { t, type MessageKey } from '../../../i18n'
import { formatKanbanViewName } from '../i18n-helpers'
import type { KanbanItem, KanbanOption, KanbanView } from '../types'
import type { CardSize } from './kanban-view-options'

export interface KanbanContextMenuProps {
  point: { x: number; y: number } | null
  targetItem: KanbanItem | null
  selectedCount: number
  activeView: KanbanView
  views: KanbanView[]
  cardSize?: CardSize
  canUndo?: boolean
  canRedo?: boolean
  isFullscreen?: boolean
  onClose: () => void
  onOpenDetail?: (item: KanbanItem) => void
  onDuplicateItem?: (item: KanbanItem) => void
  onArchiveItem?: (item: KanbanItem) => void
  onDeleteItem?: (id: string) => void
  onAddItem: () => void
  onAddColumn?: () => void
  onSelectView?: (viewId: string) => void
  onChangeCardSize?: (size: CardSize) => void
  onBatchArchive?: () => void
  onBatchDelete?: () => void
  onClearSelection?: () => void
  onUndo?: () => void
  onRedo?: () => void
  onToggleFullscreen?: () => void
  /** The destinations the active view draws, so a card can be sent to one without a drag. */
  groupOptions?: KanbanOption[]
  laneOptions?: KanbanOption[]
  onMoveItemToGroup?: (itemId: string, groupKey: string) => void
  onMoveItemToLane?: (itemId: string, laneKey: string) => void
  /** Picks every card the view currently draws, which is however many the filter leaves standing. */
  onSelectAllVisible?: () => void
  allVisibleSelected?: boolean
}

/**
 * The two coordinates a board cell has. Both are written by a drag, and a drag is the one gesture a
 * touch reader cannot perform — long-pressing a card opens this very menu, so each axis gets a
 * submenu of the destinations the board draws.
 */
type KanbanMoveAxis = 'group' | 'lane'

const MOVE_AXIS_KEYS: Record<KanbanMoveAxis, { label: MessageKey; rowId: string }> = {
  group: { label: 'preview.kanban_move_to_column', rowId: 'kanban-item-move-group' },
  lane: { label: 'preview.kanban_move_to_band', rowId: 'kanban-item-move-lane' },
}

/** One axis' property id, options and writer, or nothing when the host wired no such axis up. */
function moveAxisTarget(props: KanbanContextMenuProps, axis: KanbanMoveAxis) {
  if (axis === 'group') {
    return {
      propertyId: props.activeView.groupBy || 'status',
      options: props.groupOptions,
      onMove: props.onMoveItemToGroup,
    }
  }
  return {
    propertyId: props.activeView.swimlaneBy,
    options: props.laneOptions,
    onMove: props.onMoveItemToLane,
  }
}

export function buildMoveToSubmenuItems(
  props: KanbanContextMenuProps,
  item: KanbanItem,
  axis: KanbanMoveAxis,
): MenuItem[] {
  const { propertyId, options, onMove } = moveAxisTarget(props, axis)
  if (!propertyId || !onMove || !options?.length) return []
  const current = item.properties[propertyId]
  // A multi-select group holds arrays, so "which one is this card in" is a membership question.
  const values = Array.isArray(current) ? current : [current]
  return options.map((option) => ({
    id: `move-${axis}-${option.id}`,
    label: option.label,
    checked: values.includes(option.id),
    onSelect: () => onMove(item.id, option.id),
  }))
}

/**
 * The move-to rows, one per axis that has somewhere to go. Kept out of the card's own act list so a
 * board with a single group (or without swimlanes) grows no row at all.
 */
function buildMoveItems(props: KanbanContextMenuProps, item: KanbanItem): MenuItem[] {
  const rows: MenuItem[] = []
  for (const axis of ['group', 'lane'] as const) {
    const destinations = buildMoveToSubmenuItems(props, item, axis)
    if (destinations.length === 0) continue
    rows.push({
      id: MOVE_AXIS_KEYS[axis].rowId,
      label: t(MOVE_AXIS_KEYS[axis].label),
      icon: axis === 'group' ? <ArrowRightLeft size={14} /> : <ArrowDownUp size={14} />,
      submenu: submenuFor(destinations),
    })
  }
  return rows
}

function buildItemSpecificItems(props: KanbanContextMenuProps, item: KanbanItem): MenuItem[] {
  const items: MenuItem[] = [
    {
      id: 'kanban-item-detail',
      label: t('preview.kanban_card_details'),
      icon: <FileText size={14} />,
      onSelect: () => props.onOpenDetail?.(item),
    },
    ...buildMoveItems(props, item),
  ]
  if (props.onDuplicateItem) {
    items.push({
      id: 'kanban-item-duplicate',
      label: t('preview.kanban_duplicate_subitem'),
      icon: <Copy size={14} />,
      onSelect: () => props.onDuplicateItem?.(item),
    })
  }
  if (props.onArchiveItem) {
    items.push({
      id: 'kanban-item-archive',
      label: t('preview.kanban_archive_item'),
      icon: <Archive size={14} />,
      onSelect: () => props.onArchiveItem?.(item),
    })
  }
  if (props.onDeleteItem) {
    items.push({
      id: 'kanban-item-delete',
      label: t('common.delete'),
      icon: <Trash2 size={14} />,
      tone: 'danger',
      onSelect: () => props.onDeleteItem?.(item.id),
    })
  }
  return items
}

function buildSelectionItems(props: KanbanContextMenuProps): MenuItem[] {
  const items = buildBatchItems(props)
  // The row that makes a selection is offered whether or not one exists yet, so "clear" stays the
  // last row of the group rather than the only way in.
  if (props.onSelectAllVisible) {
    items.push({
      id: 'kanban-select-all-visible',
      label: t('preview.kanban_select_all_visible'),
      icon: <CheckSquare size={14} />,
      checked: Boolean(props.allVisibleSelected),
      ...(items.length === 0 ? { separatorBefore: true } : {}),
      onSelect: props.onSelectAllVisible,
    })
  }
  if (props.selectedCount > 0 && items.length > 0) {
    items.push({
      id: 'kanban-clear-selection',
      label: t('preview.kanban_clear_selection'),
      icon: <X size={14} />,
      onSelect: props.onClearSelection,
    })
  }
  return items
}

function buildBatchItems(props: KanbanContextMenuProps): MenuItem[] {
  if (props.selectedCount <= 0 || (!props.onBatchDelete && !props.onBatchArchive)) return []
  const items: MenuItem[] = []
  if (props.onBatchArchive) {
    items.push({
      id: 'kanban-batch-archive',
      label: t('preview.kanban_batch_archive_count', { count: props.selectedCount }),
      icon: <Archive size={14} />,
      separatorBefore: true,
      onSelect: props.onBatchArchive,
    })
  }
  if (props.onBatchDelete) {
    items.push({
      id: 'kanban-batch-delete',
      label: t('preview.kanban_batch_delete_count', { count: props.selectedCount }),
      icon: <Trash2 size={14} />,
      tone: 'danger',
      ...(items.length === 0 ? { separatorBefore: true } : {}),
      onSelect: props.onBatchDelete,
    })
  }
  return items
}

function buildHistoryItems(props: KanbanContextMenuProps): MenuItem[] {
  const items: MenuItem[] = []
  if (props.onUndo) {
    items.push({
      id: 'kanban-undo',
      label: t('common.undo'),
      icon: <Undo2 size={14} />,
      combo: 'mod+z',
      disabled: !props.canUndo,
      separatorBefore: true,
      onSelect: props.onUndo,
    })
  }
  if (props.onRedo) {
    items.push({
      id: 'kanban-redo',
      label: t('command.redo'),
      icon: <Redo2 size={14} />,
      combo: 'mod+shift+z',
      disabled: !props.canRedo,
      onSelect: props.onRedo,
    })
  }
  return items
}

function buildViewOptionsSubmenu(props: KanbanContextMenuProps): MenuItem[] {
  const items: MenuItem[] = []
  if (props.views.length > 1 && props.onSelectView) {
    items.push({
      id: 'kanban-switch-view',
      label: t('preview.kanban_views'),
      icon: <LayoutGrid size={14} />,
      separatorBefore: true,
      submenu: submenuFor(
        props.views.map((v) => ({
          id: `view-${v.id}`,
          label: formatKanbanViewName(v),
          checked: v.id === props.activeView.id,
          onSelect: () => props.onSelectView?.(v.id),
        })),
      ),
    })
  }
  if (props.activeView.type === 'board' && props.cardSize && props.onChangeCardSize) {
    items.push({
      id: 'kanban-card-size',
      label: t('preview.kanban_card_size'),
      icon: <SlidersHorizontal size={14} />,
      submenu: submenuFor([
        {
          id: 'size-small',
          label: t('preview.kanban_card_size_small'),
          checked: props.cardSize === 'small',
          onSelect: () => props.onChangeCardSize?.('small'),
        },
        {
          id: 'size-medium',
          label: t('preview.kanban_card_size_medium'),
          checked: props.cardSize === 'medium',
          onSelect: () => props.onChangeCardSize?.('medium'),
        },
        {
          id: 'size-large',
          label: t('preview.kanban_card_size_large'),
          checked: props.cardSize === 'large',
          onSelect: () => props.onChangeCardSize?.('large'),
        },
      ]),
    })
  }
  return items
}

function buildFullscreenItem(props: KanbanContextMenuProps): MenuItem[] {
  if (!props.onToggleFullscreen) return []
  return [
    {
      id: 'kanban-toggle-fullscreen',
      label: props.isFullscreen ? t('preview.kanban_exit_fullscreen') : t('preview.kanban_fullscreen'),
      icon: props.isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />,
      combo: props.isFullscreen ? 'Esc' : undefined,
      separatorBefore: true,
      onSelect: props.onToggleFullscreen,
    },
  ]
}

export function buildKanbanContextMenuItems(props: KanbanContextMenuProps): MenuItem[] {
  const { targetItem } = props
  if (targetItem) {
    return [
      ...buildItemSpecificItems(props, targetItem),
      ...buildSelectionItems(props),
      {
        id: 'kanban-new-item',
        label: t('preview.kanban_new_item'),
        icon: <Plus size={14} />,
        separatorBefore: true,
        onSelect: props.onAddItem,
      },
      ...buildHistoryItems(props),
      ...buildFullscreenItem(props),
    ]
  }

  const baseItems: MenuItem[] = [
    {
      id: 'kanban-new-item',
      label: t('preview.kanban_new_item'),
      icon: <Plus size={14} />,
      onSelect: props.onAddItem,
    },
  ]
  if (props.onAddColumn) {
    baseItems.push({
      id: 'kanban-new-group',
      label: t('preview.kanban_new_group'),
      icon: <PlusSquare size={14} />,
      onSelect: props.onAddColumn,
    })
  }

  return [
    ...baseItems,
    ...buildSelectionItems(props),
    ...buildViewOptionsSubmenu(props),
    ...buildHistoryItems(props),
    ...buildFullscreenItem(props),
  ]
}

const MENU_WIDTH = 208

export function KanbanContextMenu(props: KanbanContextMenuProps) {
  const { point, onClose } = props
  const items = buildKanbanContextMenuItems(props)

  if (!point || items.length === 0) return null

  return (
    <Menu
      anchor={point}
      open={Boolean(point)}
      onClose={onClose}
      items={items}
      width={MENU_WIDTH}
      zIndex={Z_INDEX.hoverPinned}
    />
  )
}

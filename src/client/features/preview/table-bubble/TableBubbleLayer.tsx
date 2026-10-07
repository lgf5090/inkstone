import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Copy,
  CopyPlus,
  Eraser,
  Grip,
  Minus,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import { Menu, type MenuItem } from '../../../components/overlay'
import { placePanel } from '../../../components/popover-placement'
import { getVisibleViewport } from '../../../lib/viewport'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { tableMenuItems } from '../../workspace/context-menu/items-table'
import {
  clearTableColumn,
  clearTableRow,
  deleteTableColumn,
  deleteTableRow,
  duplicateTableRow,
  insertTableColumn,
  insertTableRow,
  moveTableColumn,
  moveTableRow,
  setColumnAlignment,
  sortTableRowByColumn,
  type ColumnAlignment,
  type ParsedTable,
} from '../../../lib/markdown/table-editor'
import { HANDLE_GUTTER, type PanelState, type TableBubbleView } from './use-table-bubble'
import { nearestEdge, type TableShape } from './geometry'

/** A handle's own side, and the strip's. Both are fixed so the panel can be placed before it paints. */
const HANDLE = 18
const STRIP_BUTTON = 26
const STRIP_GAP = 2
const STRIP_PADDING = 8
const MENU_WIDTH = 244
/** How far a handle has to travel before a press becomes a reorder instead of a menu opening. */
const DRAG_THRESHOLD = 5
/** How close to an edge a dragged handle has to come for that edge to be offered as the destination. */
const DROP_THRESHOLD = 14

interface LayerProps {
  view: TableBubbleView
  onJumpToLine: (line: number) => void
  onCopyText: (text: string) => void
  /** The table exactly as the note holds it, which is what a copy should give back. */
  tableSource: (table: ParsedTable) => string
  onDeleteTable: (table: ParsedTable) => void
}

interface StripAction {
  key: string
  label: string
  icon: React.ReactNode
  active?: boolean
  disabled?: boolean
  danger?: boolean
  run: () => void
}

function stripWidth(count: number): number {
  return count * STRIP_BUTTON + Math.max(0, count - 1) * STRIP_GAP + STRIP_PADDING
}

/** The row or column edge a dragged handle is currently over, in the table's own coordinates. */
function nearestDropEdge(shape: TableShape, kind: 'column' | 'row', clientX: number, clientY: number): number | null {
  return kind === 'column'
    ? nearestEdge(shape.columnEdges, clientX - shape.table.left, DROP_THRESHOLD)
    : nearestEdge(shape.rowEdges, clientY - shape.table.top, DROP_THRESHOLD)
}

/**
 * Whether a handle is close enough to be reached. A column scrolled out of a wide table's own
 * horizontal scroll still has a centre — it is just off screen, and a button parked there is
 * unreachable, so it is better not drawn at all.
 */
function reachable(x: number, y: number): boolean {
  const viewport = getVisibleViewport()
  const margin = HANDLE_GUTTER + HANDLE
  return x > viewport.left - margin && x < viewport.right + margin && y > viewport.top - margin && y < viewport.bottom + margin
}

function HandleButton({ x, y, label, active, onOpen, onDrag, onDrop, dragging }: {
  x: number
  y: number
  label: string
  active: boolean
  onOpen: (anchor: HTMLElement) => void
  /** Set for the handles that can also be dragged to reorder; the header row's cannot. */
  onDrag?: (clientX: number, clientY: number) => void
  onDrop?: () => void
  dragging?: boolean
}) {
  const ref = useRef<HTMLButtonElement | null>(null)
  const gesture = useRef({ x: 0, y: 0, moved: false, live: false })
  const finish = () => {
    if (!gesture.current.live) return
    gesture.current.live = false
    if (gesture.current.moved) onDrop?.()
  }
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      data-dragging={dragging ? 'true' : undefined}
      onPointerDown={(event) => {
        if (!onDrag || event.button !== 0) return
        gesture.current = { x: event.clientX, y: event.clientY, moved: false, live: true }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const current = gesture.current
        if (!current.live || !onDrag) return
        if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < DRAG_THRESHOLD) return
        current.moved = true
        onDrag(event.clientX, event.clientY)
      }}
      onPointerUp={() => finish()}
      onPointerCancel={() => {
        gesture.current.live = false
        gesture.current.moved = false
      }}
      onClick={() => {
        // The gesture that ended a drag is the same one the browser then reports as a click; letting
        // it through would open the menu of the row the reader just moved.
        if (gesture.current.moved) {
          gesture.current.moved = false
          return
        }
        if (ref.current) onOpen(ref.current)
      }}
      className={cn(
        'pointer-events-auto absolute flex items-center justify-center rounded-[var(--r-sm)] border',
        'border-[var(--border-default)] bg-[var(--bg-overlay)] text-[var(--text-tertiary)]',
        'transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]',
        active && 'border-[var(--accent)] text-[var(--accent)]',
      )}
      style={{ left: x - HANDLE / 2, top: y - HANDLE / 2, width: HANDLE, height: HANDLE }}
    >
      <Grip size={11}/>
    </button>
  )
}

function StripButton({ action }: { action: StripAction }) {
  return (
    <button
      type="button"
      aria-label={action.label}
      title={action.label}
      aria-pressed={action.active || undefined}
      disabled={action.disabled}
      onClick={action.run}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-secondary)] transition-colors',
        'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]',
        action.active && 'bg-[var(--accent-softer)] text-[var(--accent)]',
        action.danger && 'hover:text-[var(--danger)]',
        action.disabled && 'pointer-events-none opacity-40',
      )}
      style={{ width: STRIP_BUTTON, height: STRIP_BUTTON }}
    >
      {action.icon}
    </button>
  )
}

/** Built per call: a label read at import time would not follow a change of language. */
function alignments(): Array<{ value: Exclude<ColumnAlignment, 'default'>, label: string, icon: React.ReactNode }> {
  return [
    { value: 'left', label: t('contextmenu.table_align_left'), icon: <AlignLeft size={14}/> },
    { value: 'center', label: t('contextmenu.table_align_center'), icon: <AlignCenter size={14}/> },
    { value: 'right', label: t('contextmenu.table_align_right'), icon: <AlignRight size={14}/> },
  ]
}

function columnStrip(table: ParsedTable, commit: (next: ParsedTable) => void): StripAction[] {
  const column = table.cursorColIndex
  const current = table.alignments[column] ?? 'default'
  return [
    { key: 'delete', label: t('contextmenu.table_delete_col'), icon: <Trash2 size={14}/>, danger: true, disabled: table.columnCount <= 1, run: () => commit(deleteTableColumn(table, column)) },
    ...alignments().map((entry) => ({
      key: `align-${entry.value}`,
      label: entry.label,
      icon: entry.icon,
      active: current === entry.value,
      run: () => commit(setColumnAlignment(table, column, entry.value)),
    })),
    { key: 'default', label: t('contextmenu.table_align_default'), icon: <Minus size={14}/>, active: current === 'default', run: () => commit(setColumnAlignment(table, column, 'default')) },
  ]
}

function rowStrip(table: ParsedTable, commit: (next: ParsedTable) => void): StripAction[] {
  const row = table.cursorRowIndex
  const header = row < 0
  return [
    { key: 'delete', label: t('contextmenu.table_delete_row'), icon: <Trash2 size={14}/>, danger: true, run: () => commit(deleteTableRow(table, row)) },
    { key: 'above', label: t('contextmenu.table_insert_row_above'), icon: <Plus size={14}/>, run: () => commit(insertTableRow(table, row, 'above')) },
    { key: 'below', label: t('contextmenu.table_insert_row_below'), icon: <Plus size={14}/>, run: () => commit(insertTableRow(table, row, 'below')) },
    { key: 'duplicate', label: t('contextmenu.table_duplicate_row'), icon: <CopyPlus size={14}/>, disabled: header, run: () => commit(duplicateTableRow(table, row)) },
    { key: 'clear', label: t('contextmenu.table_clear_row'), icon: <Eraser size={14}/>, run: () => commit(clearTableRow(table, row)) },
  ]
}

function columnMenu(table: ParsedTable, commit: (next: ParsedTable) => void, onCopyText: (text: string) => void): MenuItem[] {
  const column = table.cursorColIndex
  const values = [table.headerRow[column] ?? '', ...table.rows.map((row) => row[column] ?? '')]
  return [
    { id: 'insert-left', label: t('contextmenu.table_insert_col_left'), icon: <Plus size={14}/>, onSelect: () => commit(insertTableColumn(table, column, 'left')) },
    { id: 'insert-right', label: t('contextmenu.table_insert_col_right'), icon: <Plus size={14}/>, onSelect: () => commit(insertTableColumn(table, column, 'right')) },
    { id: 'move-left', label: t('contextmenu.table_move_col_left'), icon: <ArrowLeft size={14}/>, disabled: column === 0, onSelect: () => commit(moveTableColumn(table, column, column - 1)) },
    { id: 'move-right', label: t('contextmenu.table_move_col_right'), icon: <ArrowRight size={14}/>, disabled: column >= table.columnCount - 1, onSelect: () => commit(moveTableColumn(table, column, column + 1)) },
    { id: 'clear', label: t('contextmenu.table_clear_col'), icon: <Eraser size={14}/>, separatorBefore: true, onSelect: () => commit(clearTableColumn(table, column)) },
    { id: 'sort-asc', label: t('contextmenu.table_sort_asc'), icon: <ArrowUpDown size={14}/>, separatorBefore: true, onSelect: () => commit(sortTableRowByColumn(table, column, 'asc')) },
    { id: 'sort-desc', label: t('contextmenu.table_sort_desc'), icon: <ArrowUpDown size={14}/>, onSelect: () => commit(sortTableRowByColumn(table, column, 'desc')) },
    { id: 'copy', label: t('contextmenu.table_copy_col'), icon: <Copy size={14}/>, onSelect: () => onCopyText(values.join('\n')) },
  ]
}

function rowMenu(table: ParsedTable, commit: (next: ParsedTable) => void, onCopyText: (text: string) => void): MenuItem[] {
  const row = table.cursorRowIndex
  return [
    { id: 'move-up', label: t('contextmenu.table_move_row_up'), icon: <ArrowUp size={14}/>, disabled: row <= 0, onSelect: () => commit(moveTableRow(table, row, row - 1)) },
    { id: 'move-down', label: t('contextmenu.table_move_row_down'), icon: <ArrowDown size={14}/>, disabled: row < 0 || row >= table.rows.length - 1, onSelect: () => commit(moveTableRow(table, row, row + 1)) },
    { id: 'copy-row', label: t('contextmenu.table_copy_row'), icon: <Copy size={14}/>, separatorBefore: true, onSelect: () => onCopyText((table.rows[row] ?? table.headerRow).join('\t')) },
  ]
}

function InsertMarker({ x, y, label, onInsert }: { x: number, y: number, label: string, onInsert: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onInsert}
      className="pointer-events-auto absolute flex items-center justify-center rounded-full border border-[var(--accent)] bg-[var(--bg-overlay)] text-[var(--accent)] shadow-[var(--shadow-sm)] transition-transform hover:scale-110"
      style={{ left: x - 9, top: y - 9, width: 18, height: 18 }}
    >
      <Plus size={11}/>
    </button>
  )
}

function MarkerLine({ left, top, width, height, strong }: { left: number, top: number, width: number, height: number, strong?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn('absolute rounded-full bg-[var(--accent)]', strong ? 'opacity-90' : 'opacity-60')}
      style={{ left, top, width, height }}
    />
  )
}

function CellEditor({ view }: { view: TableBubbleView }) {
  const editor = view.editor
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const [value, setValue] = useState('')
  const open = editor !== null
  useEffect(() => {
    if (!open || !editor) return
    setValue(editor.value)
    const node = ref.current
    if (!node) return
    node.focus()
    node.setSelectionRange(node.value.length, node.value.length)
  }, [open, editor])
  if (!editor) return null
  const width = Math.max(88, editor.box.right - editor.box.left)
  const height = Math.max(28, editor.box.bottom - editor.box.top)
  return (
    <textarea
      ref={ref}
      value={value}
      aria-label={t('preview.table_bubble_edit_cell')}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          view.cancelCellEdit()
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault()
          view.commitCellEdit(value)
        }
      }}
      onBlur={() => view.commitCellEdit(value)}
      className="pointer-events-auto absolute resize-none overflow-auto rounded-[var(--r-sm)] border-2 border-[var(--accent)] bg-[var(--bg-overlay)] px-1.5 py-1 text-[length:var(--text-13)] leading-snug text-[var(--text-primary)] shadow-[var(--shadow-pop)] outline-none"
      style={{ left: editor.box.left, top: editor.box.top, width, minHeight: height, textAlign: editor.align as 'left' | 'center' | 'right' | 'start' }}
    />
  )
}

/**
 * The layer the table's handles, markers and panels are drawn in.
 *
 * It is portalled to `document.body` and placed in viewport coordinates rather than appended to the
 * prose, because the preview re-diffs its own DOM on every typing pause and drops any attribute the
 * renderer did not write — a button inside a `<td>` would be gone before anyone could click it.
 *
 * Nothing opens on its own either: the handles appear while the pointer is on a table, and every
 * action goes through a button, so a reader who never touches one sees exactly the note they wrote.
 */
export function TableBubbleLayer({ view, onJumpToLine, onCopyText, tableSource, onDeleteTable }: LayerProps) {
  const { shape, panel, marker, hover, parsed } = view
  const [overflow, setOverflow] = useState(false)
  const [stripRef, setStripRef] = useState<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState<{ kind: 'column' | 'row', from: number, edge: number } | null>(null)
  const dragRef = useRef(drag)
  dragRef.current = drag
  const anchorRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!panel) {
      setOverflow(false)
      return
    }
    if (panel.kind === 'table') return
    stripRef?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
  }, [panel, stripRef])

  // A layer torn away mid-drag would otherwise leave the hook pinned, and a pinned layer never hides
  // itself again. Held through a ref so this is an unmount cleanup and not a per-render one.
  const setPinnedRef = useRef(view.setPinned)
  setPinnedRef.current = view.setPinned
  useEffect(() => () => setPinnedRef.current(false), [])

  if (!shape || !parsed) return null

  const open = (next: PanelState, anchor: HTMLElement) => {
    anchorRef.current = anchor
    setOverflow(false)
    view.openPanel(next, anchor)
  }

  /**
   * Follow a dragged handle to the edge it is nearest. The edge last found stays offered while the
   * pointer travels between two, so a slow drag across a wide table does not blink the indicator off
   * and on — and the drop lands where the reader last saw the line.
   */
  const dragTo = (kind: 'column' | 'row', from: number) => (clientX: number, clientY: number) => {
    view.setPinned(true)
    const edge = nearestDropEdge(shape, kind, clientX, clientY)
    setDrag((current) => {
      if (!current || current.kind !== kind || current.from !== from) return { kind, from, edge: edge ?? from }
      if (edge === null || edge === current.edge) return current
      return { ...current, edge }
    })
  }

  const drop = (kind: 'column' | 'row', from: number) => () => {
    view.setPinned(false)
    const current = dragRef.current
    setDrag(null)
    if (current && current.kind === kind && current.from === from) view.dropOnEdge(kind, from, current.edge)
  }
  const commit = (next: ParsedTable) => view.commit(next)
  const aimed = panel && panel.kind !== 'table' ? view.parseAimed(panel) : null
  const actions = !panel || !aimed
    ? []
    : panel.kind === 'column' ? columnStrip(aimed, commit) : rowStrip(aimed, commit)
  const overflowItems = !aimed || !panel
    ? []
    : panel.kind === 'column' ? columnMenu(aimed, commit, onCopyText) : rowMenu(aimed, commit, onCopyText)
  const handleBox = panel && panel.kind !== 'table'
    ? {
        left: panel.kind === 'column' ? shape.table.left + (shape.columnCenters[panel.index] ?? 0) - HANDLE / 2 : shape.table.left - HANDLE_GUTTER - 2,
        top: panel.kind === 'column' ? shape.table.top - HANDLE_GUTTER - 2 : shape.table.top + (shape.rowCenters[panel.index] ?? 0) - HANDLE / 2,
      }
    : null
  const placement = handleBox
    ? placePanel({
        anchor: { top: handleBox.top, left: handleBox.left, right: handleBox.left + HANDLE, bottom: handleBox.top + HANDLE },
        size: { width: stripWidth(actions.length + 1), height: STRIP_BUTTON + STRIP_PADDING },
        viewport: getVisibleViewport(),
        align: 'start',
        gap: 4,
      })
    : null
  const menuAnchor = anchorRef.current ? { current: anchorRef.current } : { x: shape.table.left, y: shape.table.top }
  const tableItems = panel?.kind === 'table'
    ? tableMenuItems(parsed, commit, tableExtras(parsed, view, onJumpToLine, onCopyText, tableSource, onDeleteTable), onCopyText)
    : []

  return createPortal(
    <div
      ref={view.layerRef}
      data-table-bubble
      className="pointer-events-none fixed inset-0 z-[var(--z-popover)]"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !panel) return
        event.preventDefault()
        event.stopPropagation()
        view.closePanel()
      }}
    >
      {hover.column !== null && shape.columns[hover.column] && (
        <div
          aria-hidden
          className="absolute bg-[var(--accent-softer)]"
          style={{
            left: shape.columns[hover.column]!.left,
            top: shape.table.top,
            width: shape.columns[hover.column]!.right - shape.columns[hover.column]!.left,
            height: shape.table.bottom - shape.table.top,
          }}
        />
      )}

      {drag && (
        <MarkerLine
          {...(drag.kind === 'column'
            ? {
                left: shape.table.left + (shape.columnEdges[drag.edge] ?? 0) - 1,
                top: shape.table.top,
                width: 2,
                height: shape.table.bottom - shape.table.top,
              }
            : {
                left: shape.table.left,
                top: shape.table.top + (shape.rowEdges[drag.edge] ?? 0) - 1,
                width: shape.table.right - shape.table.left,
                height: 2,
              })}
          strong
        />
      )}

      {shape.columnCenters.map((_, index) => {
        const x = shape.table.left + (shape.columnCenters[index] ?? 0)
        const y = shape.table.top - HANDLE_GUTTER / 2 - 2
        if (!reachable(x, y)) return null
        return (
          <HandleButton
            key={`column-${index}`}
            x={x}
            y={y}
            label={t('preview.table_bubble_column_handle')}
            active={panel?.kind === 'column' && panel.index === index}
            onOpen={(node) => open({ kind: 'column', index }, node)}
            onDrag={dragTo('column', index)}
            onDrop={drop('column', index)}
            dragging={drag?.kind === 'column' && drag.from === index}
          />
        )
      })}

      {shape.rowCenters.map((_, index) => {
        const x = shape.table.left - HANDLE_GUTTER / 2 - 2
        const y = shape.table.top + (shape.rowCenters[index] ?? 0)
        if (!reachable(x, y)) return null
        return (
          <HandleButton
            key={`row-${index}`}
            x={x}
            y={y}
            label={index === 0 ? t('preview.table_bubble_header_handle') : t('preview.table_bubble_row_handle')}
            active={panel?.kind === 'row' && panel.index === index}
            onOpen={(node) => open({ kind: 'row', index }, node)}
            onDrag={index === 0 ? undefined : dragTo('row', index)}
            onDrop={index === 0 ? undefined : drop('row', index)}
            dragging={drag?.kind === 'row' && drag.from === index}
          />
        )
      })}

      <HandleButton
        x={shape.table.left - HANDLE_GUTTER / 2 - 2}
        y={shape.table.top - HANDLE_GUTTER / 2 - 2}
        label={t('preview.table_bubble_table_handle')}
        active={panel?.kind === 'table'}
        onOpen={(node) => open({ kind: 'table', index: 0 }, node)}
      />

      {marker.column !== null && (
        <>
          <MarkerLine
            left={shape.table.left + (shape.columnEdges[marker.column] ?? 0) - 1}
            top={shape.table.top}
            width={2}
            height={shape.table.bottom - shape.table.top}
          />
          <InsertMarker
            x={shape.table.left + (shape.columnEdges[marker.column] ?? 0)}
            y={shape.table.bottom + HANDLE_GUTTER / 2 + 2}
            label={t('preview.table_bubble_insert_column')}
            onInsert={() => view.insertAt('column', marker.column!)}
          />
        </>
      )}
      {marker.row !== null && (
        <>
          <MarkerLine
            left={shape.table.left}
            top={shape.table.top + (shape.rowEdges[marker.row] ?? 0) - 1}
            width={shape.table.right - shape.table.left}
            height={2}
          />
          <InsertMarker
            x={shape.table.right + HANDLE_GUTTER / 2 + 2}
            y={shape.table.top + (shape.rowEdges[marker.row] ?? 0)}
            label={t('preview.table_bubble_insert_row')}
            onInsert={() => view.insertAt('row', marker.row!)}
          />
        </>
      )}

      {panel?.kind === 'table' && (
        <Menu
          anchor={menuAnchor}
          open
          onClose={() => view.closePanel()}
          items={tableItems}
          width={MENU_WIDTH}
          label={t('preview.table_bubble_table_handle')}
        />
      )}

      {panel && panel.kind !== 'table' && placement && (
        <div
          ref={setStripRef}
          role="toolbar"
          aria-label={t('preview.table_bubble_actions')}
          aria-orientation="horizontal"
          className="anim-pop pointer-events-auto absolute flex items-center rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 shadow-[var(--shadow-pop)]"
          style={{ top: placement.top, left: placement.left, transformOrigin: placement.origin }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]
            const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
            if (at < 0) return
            event.preventDefault()
            buttons[(at + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
          }}
        >
          {actions.map((action, index) => (
            <span key={action.key} className="flex items-center" style={{ marginLeft: index === 0 ? 0 : STRIP_GAP }}>
              <StripButton action={action}/>
            </span>
          ))}
          <span className="flex items-center" style={{ marginLeft: STRIP_GAP }}>
            <StripButton
              action={{ key: 'more', label: t('preview.table_bubble_more'), icon: <MoreHorizontal size={14}/>, active: overflow, run: () => setOverflow((current) => !current) }}
            />
          </span>
        </div>
      )}

      {panel && overflow && overflowItems.length > 0 && (
        <Menu
          anchor={{ current: stripRef }}
          open
          onClose={() => setOverflow(false)}
          items={overflowItems}
          width={MENU_WIDTH}
          label={t('preview.table_bubble_more')}
        />
      )}

      <CellEditor view={view}/>
    </div>,
    document.body,
  )
}

/**
 * The rows that belong to the table as a whole rather than to one row or column.
 *
 * `copy-csv` is deliberately absent: the shared list already offers it, and a second row with the
 * same id would be a second React key in the same list.
 */
function tableExtras(table: ParsedTable, view: TableBubbleView, onJumpToLine: (line: number) => void, onCopyText: (text: string) => void, tableSource: (table: ParsedTable) => string, onDeleteTable: (table: ParsedTable) => void): MenuItem[] {
  return [
    { id: 'jump', label: t('contextmenu.jump_to_editor'), icon: <Pencil size={14}/>, separatorBefore: true, onSelect: () => onJumpToLine(table.startLine) },
    { id: 'copy-md', label: t('contextmenu.copy_source'), icon: <Copy size={14}/>, onSelect: () => onCopyText(tableSource(table)) },
    { id: 'delete-table', label: t('contextmenu.delete_block'), icon: <Trash2 size={14}/>, tone: 'danger', onSelect: () => { view.closePanel(); onDeleteTable(table) } },
  ]
}

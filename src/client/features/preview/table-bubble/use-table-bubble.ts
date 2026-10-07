import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { t } from '../../../lib/i18n'
import { joinLines, splitLines } from '../../../lib/markdown/fence-edit'
import {
  cellDisplayText,
  formatMarkdownTable,
  parseMarkdownTable,
  updateTableCell,
  type ParsedTable,
} from '../../../lib/markdown/table-editor'
import { FOREIGN_TABLE_HOSTS, addressOfCell, domAgreesWithParser, domShapeOf, findEditableTable, readShape, readTableBox, sourceLineOf } from './dom'
import { geometryIsStale, slotAt, trackedEdge, type Box, type TableShape } from './geometry'
import { dropAtEdge, insertAtEdge } from './edits'
import type { BlockToast } from '../block-overlay'

/** How close to a row or column edge the pointer has to come before an insert marker appears. */
const EDGE_THRESHOLD = 7
/** How far it has to get before one that is already offered goes away — the marker sits outside the table. */
const EDGE_RELEASE = 26
/** How far outside the table the handles reach, and therefore how far the hover zone extends. */
export const HANDLE_GUTTER = 22

type PanelKind = 'column' | 'row' | 'table'

export interface PanelState {
  kind: PanelKind
  /** The column index, or the table's row index where `0` is the header row. */
  index: number
}

export interface CellEditorState {
  rowIndex: number
  colIndex: number
  box: Box
  value: string
  align: string
}

export interface TableBubbleOptions {
  hostRef: RefObject<HTMLElement | null>
  scrollerRef: RefObject<HTMLElement | null>
  enabled: boolean
  /**
   * The note and text to write against, or null when the preview is behind the editor.
   *
   * Read during render to decide whether the table on screen is addressable, so it must not report
   * anything: a call that raised the "preview is updating" toast here would be a `setState` inside
   * another component's render, which React warns about and which fires on every pointer move.
   */
  getTarget: () => { noteId: string, source: string } | null
  onEditContent: (noteId: string, next: string) => void
  onToast: BlockToast
}

export interface TableBubbleView {
  layerRef: RefObject<HTMLDivElement | null>
  shape: TableShape | null
  panel: PanelState | null
  marker: { column: number | null, row: number | null }
  hover: { column: number | null }
  editor: CellEditorState | null
  /** The tracked table as the note holds it, or null when the parser and the renderer disagree. */
  parsed: ParsedTable | null
  /** The line the tracked table's header sits on. */
  line: number
  openPanel: (panel: PanelState, anchor: HTMLElement) => void
  closePanel: () => void
  setPinned: (value: boolean) => void
  insertAt: (axis: 'column' | 'row', edge: number) => void
  dropOnEdge: (kind: 'column' | 'row', from: number, edge: number) => void
  commitCellEdit: (value: string) => void
  cancelCellEdit: () => void
  /** Parse the tracked table with its cursor aimed at one row or column, for building a menu. */
  parseAimed: (panel: PanelState) => ParsedTable | null
  commit: (next: ParsedTable) => void
}

/**
 * Aim a parsed table at the row or column a handle belongs to.
 *
 * The layer counts rows the way the DOM does — `0` is the header, and the body starts at `1` — while
 * `ParsedTable` counts them from the body and uses `-1` for the header. This is the one place that
 * translation happens, because an off-by-one here is a wrong write to the note rather than a wrong
 * pixel.
 */
export function aimTable(parsed: ParsedTable, panel: PanelState): ParsedTable {
  if (panel.kind === 'table') return parsed
  const column = Math.max(0, Math.min(panel.index, parsed.columnCount - 1))
  if (panel.kind === 'column') return { ...parsed, cursorColIndex: column }
  return { ...parsed, cursorRowIndex: Math.max(-1, Math.min(panel.index - 1, parsed.rows.length - 1)), cursorColIndex: column }
}

function toBox(rect: { top: number, left: number, right: number, bottom: number }): Box {
  return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom }
}

function sameBox(a: Box, b: Box): boolean {
  return a.top === b.top && a.left === b.left && a.right === b.right && a.bottom === b.bottom
}

function inflate(box: Box, gutter: number): Box {
  return { top: box.top - gutter, left: box.left - gutter, right: box.right + gutter, bottom: box.bottom + gutter }
}

function contains(box: Box, x: number, y: number): boolean {
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
}

/** The pointer being nowhere near the table, which is what `pointerleave` reports. */
const OUTSIDE = { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY }

/**
 * The preview's table as an object you can point at.
 *
 * Nothing here is written into the prose: the preview diffs its own DOM and strips any attribute the
 * renderer did not put there, so a class or a button added to a `<td>` would vanish on the next
 * keystroke. Every pixel of this feature lives in a layer above the prose, and the only thing taken
 * from the table is its geometry.
 *
 * That geometry is read once per table and then carried across scrolls, because a handle's position
 * is the table's own box plus an offset measured inside it — re-reading every cell on each scroll
 * frame would cost a layout flush per row on the heaviest block in the note.
 */
export function useTableBubble({ hostRef, scrollerRef, enabled, getTarget, onEditContent, onToast }: TableBubbleOptions): TableBubbleView {
  const [shape, setShape] = useState<TableShape | null>(null)
  const [panel, setPanel] = useState<PanelState | null>(null)
  const [marker, setMarker] = useState<{ column: number | null, row: number | null }>({ column: null, row: null })
  const [hover, setHover] = useState<{ column: number | null }>({ column: null })
  const [editor, setEditor] = useState<CellEditorState | null>(null)

  const layerRef = useRef<HTMLDivElement | null>(null)
  const wrapRef = useRef<HTMLElement | null>(null)
  const shapeRef = useRef<TableShape | null>(null)
  const pointerRef = useRef(OUTSIDE)
  const frameRef = useRef(0)
  const panelRef = useRef<PanelState | null>(null)
  const anchorRef = useRef<HTMLElement | null>(null)
  const editorRef = useRef<CellEditorState | null>(null)
  const editorCellRef = useRef<HTMLElement | null>(null)
  const pinnedRef = useRef(false)
  panelRef.current = panel
  editorRef.current = editor

  /**
   * Re-read the table's geometry, keeping the cached offsets while the table is the same size.
   * `force` is what an edit uses: the DOM has been patched to a new shape, and the old one would be
   * judged against the box it was built from.
   */
  const refresh = useCallback((force = false): TableShape | null => {
    const wrap = wrapRef.current
    if (!wrap || !wrap.isConnected) return null
    const box = readTableBox(wrap)
    const counts = domShapeOf(wrap)
    if (!box || !counts) return null
    const cached = shapeRef.current
    if (cached && !force && !geometryIsStale(cached, box, counts.rows, counts.columns)) {
      if (sameBox(cached.table, box)) return cached
      const moved = { ...cached, table: box }
      shapeRef.current = moved
      setShape(moved)
      return moved
    }
    const next = readShape(wrap)
    if (!next) return cached
    shapeRef.current = next
    setShape(next)
    return next
  }, [])

  const stopTracking = useCallback(() => {
    wrapRef.current = null
    shapeRef.current = null
    setShape(null)
    setMarker({ column: null, row: null })
    setHover({ column: null })
  }, [])

  /** Closing the cell box always means forgetting the element it was opened from. */
  const closeCellEditor = useCallback(() => {
    editorCellRef.current = null
    setEditor(null)
  }, [])

  const track = useCallback(() => {
    const cell = editorCellRef.current
    if (cell && editorRef.current) {
      if (!cell.isConnected) closeCellEditor()
      else {
        const rect = toBox(cell.getBoundingClientRect())
        setEditor((current) => (!current || sameBox(current.box, rect) ? current : { ...current, box: rect }))
      }
    }
    const next = refresh()
    if (!next) {
      if (!panelRef.current) stopTracking()
      return
    }
    const { x, y } = pointerRef.current
    const box = next.table
    if (!contains(inflate(box, HANDLE_GUTTER), x, y)) {
      // A panel or a drag in flight keeps the layer standing: both put the pointer outside the table,
      // which is the point of having them, and dropping the layer mid-drag would lose the move.
      if (panelRef.current || pinnedRef.current) setMarker({ column: null, row: null })
      else stopTracking()
      return
    }
    const inside = contains(box, x, y)
    const px = x - box.left
    const py = y - box.top
    setMarker((current) => {
      const column = trackedEdge(next.columnEdges, px, EDGE_THRESHOLD, EDGE_RELEASE, current.column)
      const row = trackedEdge(next.rowEdges, py, EDGE_THRESHOLD, EDGE_RELEASE, current.row)
      return current.column === column && current.row === row ? current : { column, row }
    })
    setHover((current) => {
      const columnSlot = inside ? slotAt(next.columnEdges, px) : null
      return current.column === columnSlot ? current : { column: columnSlot }
    })
  }, [closeCellEditor, refresh, stopTracking])

  const schedule = useCallback(() => {
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      track()
    })
  }, [track])

  const beginTracking = useCallback((wrap: HTMLElement) => {
    if (wrapRef.current !== wrap) {
      wrapRef.current = wrap
      shapeRef.current = null
      setMarker({ column: null, row: null })
      if (panelRef.current) {
        panelRef.current = null
        setPanel(null)
      }
      refresh()
    }
    // Scheduled even when the table is the one already being tracked: the pointer moving *within* a
    // table is the normal case, and returning early here would leave the markers frozen where the
    // pointer first arrived.
    schedule()
  }, [refresh, schedule])

  /** Whether the parser and the renderer still describe the same block. */
  const parseCache = useRef<{ source: string, line: number, table: ParsedTable | null }>({ source: '', line: -1, table: null })
  const parseAt = useCallback((line: number): ParsedTable | null => {
    const target = getTarget()
    const wrap = wrapRef.current
    if (!target || !wrap) return null
    const cached = parseCache.current
    if (cached.source === target.source && cached.line === line) return cached.table
    const { lines } = splitLines(target.source)
    const parsed = parseMarkdownTable(lines, line)
    const counts = domShapeOf(wrap)
    let result: ParsedTable | null = null
    if (parsed && counts && domAgreesWithParser(parsed, counts) && parsed.columnCount === counts.columns) result = parsed
    parseCache.current = { source: target.source, line, table: result }
    return result
  }, [getTarget])

  const warnStale = useCallback(() => {
    onToast({ title: t('preview.the_preview_is_updating_try_again_in_a_moment'), tone: 'warning' })
  }, [onToast])

  const commit = useCallback((next: ParsedTable) => {
    const wrap = wrapRef.current
    if (!wrap) return
    const target = getTarget()
    if (!target) {
      warnStale()
      return
    }
    const previous = parseAt(sourceLineOf(wrap))
    if (!previous) return
    const before = target.source
    const { lines, eol, trailingNewline } = splitLines(before)
    lines.splice(previous.startLine, previous.endLine - previous.startLine + 1, ...formatMarkdownTable(next))
    onEditContent(target.noteId, joinLines(lines, eol, trailingNewline))
    onToast({
      title: t('preview.table_bubble_done'),
      tone: 'success',
      duration: 5000,
      action: { label: t('common.undo'), run: () => onEditContent(target.noteId, before) },
    })
  }, [getTarget, onEditContent, onToast, parseAt, warnStale])

  const parseAimed = useCallback((aim: PanelState): ParsedTable | null => {
    const wrap = wrapRef.current
    if (!wrap) return null
    const parsed = parseAt(sourceLineOf(wrap))
    return parsed ? aimTable(parsed, aim) : null
  }, [parseAt])

  const beginCellEdit = useCallback((cell: Element) => {
    const wrap = wrapRef.current
    const address = addressOfCell(cell)
    if (!wrap || !address) return
    if (!getTarget()) {
      warnStale()
      return
    }
    const parsed = parseAt(sourceLineOf(wrap))
    const source = address.rowIndex < 0
      ? parsed?.headerRow[address.colIndex]
      : parsed?.rows[address.rowIndex]?.[address.colIndex]
    if (!parsed || source === undefined) return
    editorCellRef.current = cell instanceof HTMLElement ? cell : null
    setEditor({
      rowIndex: address.rowIndex,
      colIndex: address.colIndex,
      box: toBox(cell.getBoundingClientRect()),
      value: cellDisplayText(source),
      align: getComputedStyle(cell).textAlign || 'start',
    })
  }, [getTarget, parseAt, warnStale])

  const commitCellEdit = useCallback((value: string) => {
    const current = editorRef.current
    const wrap = wrapRef.current
    closeCellEditor()
    if (!current || !wrap) return
    const parsed = parseAt(sourceLineOf(wrap))
    if (!parsed) return
    commit(updateTableCell(parsed, current.rowIndex, current.colIndex, value))
  }, [closeCellEditor, commit, parseAt])

  const cancelCellEdit = useCallback(() => closeCellEditor(), [closeCellEditor])

  /**
   * Insert at a boundary the pointer chose, rather than beside the row or column it is on.
   *
   * The arithmetic lives in `edits.ts` with the rest of the edge-to-index translations, because a
   * column is not just three more cells: `columnCount` is what the formatter writes, and a splice
   * that forgot it would drop the last column on the floor.
   */
  const insertAt = useCallback((axis: 'column' | 'row', edge: number) => {
    const parsed = parseAimed({ kind: 'table', index: 0 })
    if (parsed) commit(insertAtEdge(parsed, axis, edge))
  }, [commit, parseAimed])

  const dropOnEdge = useCallback((kind: 'column' | 'row', from: number, edge: number) => {
    const parsed = parseAimed({ kind, index: from })
    if (parsed) commit(dropAtEdge(parsed, kind, from, edge))
  }, [commit, parseAimed])

  const openPanel = useCallback((next: PanelState, anchor: HTMLElement) => {
    anchorRef.current = anchor
    setPanel((current) => (current && current.kind === next.kind && current.index === next.index ? null : next))
  }, [])

  /** Hold the layer in place while a handle is being dragged, which takes the pointer off the table. */
  const setPinned = useCallback((value: boolean) => {
    pinnedRef.current = value
  }, [])

  const closePanel = useCallback(() => {
    setPanel(null)
    const anchor = anchorRef.current
    anchorRef.current = null
    if (anchor?.isConnected) anchor.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!enabled || !host) {
      stopTracking()
      closeCellEditor()
      setPanel(null)
      return
    }
    const onMove = (event: PointerEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY }
      const wrap = findEditableTable(event.target)
      if (wrap) beginTracking(wrap)
    }
    const onDoubleClick = (event: MouseEvent) => {
      const cell = (event.target as Element).closest?.('td, th')
      if (!cell || !findEditableTable(cell)) return
      event.preventDefault()
      beginCellEdit(cell)
    }
    host.addEventListener('pointermove', onMove)
    host.addEventListener('dblclick', onDoubleClick, { capture: true })
    return () => {
      host.removeEventListener('pointermove', onMove)
      host.removeEventListener('dblclick', onDoubleClick, { capture: true })
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
    }
  }, [enabled, hostRef, beginCellEdit, beginTracking, stopTracking])

  // Once a table is being tracked the pointer is followed across the whole document, because the
  // handles live outside the prose: a listener on the host alone would drop them out from under the
  // pointer the moment it reached for one, which is the difference between a menu and a toy.
  const tracking = shape !== null
  useEffect(() => {
    if (!enabled || !tracking) return
    const onMove = (event: PointerEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY }
      const wrap = findEditableTable(event.target)
      if (wrap) wrapRef.current = wrap
      schedule()
    }
    const onLeaveWindow = () => {
      pointerRef.current = OUTSIDE
      schedule()
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerleave', onLeaveWindow)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerleave', onLeaveWindow)
    }
  }, [enabled, tracking, schedule])

  // The prose is re-diffed on every typing pause and a table can be replaced wholesale by that diff, so
  // the element being tracked may no longer be in the document. Re-finding it by source line is what
  // keeps an open panel anchored through the edit that opened it.
  useEffect(() => {
    const host = hostRef.current
    if (!enabled || !host) return
    const observer = new MutationObserver(() => {
      const wrap = wrapRef.current
      if (!wrap) return
      if (!wrap.isConnected) {
        const line = wrap.dataset.line
        const replacement = line === undefined
          ? null
          : host.querySelector<HTMLElement>(`.table-wrap[data-line="${CSS.escape(line)}"]`)
        if (!replacement || replacement.closest(FOREIGN_TABLE_HOSTS)) {
          stopTracking()
          setPanel(null)
          closeCellEditor()
          return
        }
        wrapRef.current = replacement
        shapeRef.current = null
      }
      refresh(true)
      schedule()
    })
    observer.observe(host, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [enabled, hostRef, refresh, schedule, stopTracking])

  useEffect(() => {
    if (!enabled) return
    const scroller = scrollerRef.current
    const onScrollOrResize = () => {
      if (wrapRef.current) schedule()
    }
    scroller?.addEventListener('scroll', onScrollOrResize, { capture: true, passive: true })
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      scroller?.removeEventListener('scroll', onScrollOrResize, { capture: true })
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [enabled, schedule, scrollerRef])

  useEffect(() => {
    if (!panel) return
    const onPointerDown = (event: PointerEvent) => {
      if (layerRef.current?.contains(event.target as Node)) return
      setPanel(null)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [panel])

  // A successful edit can take the panel's own slot away — deleting the last row, say — and a menu
  // pointing at a row that is gone would act on whatever slid into its place.
  useEffect(() => {
    if (!panel || !shape) return
    const count = panel.kind === 'column' ? shape.columns.length : panel.kind === 'row' ? shape.rows.length : 1
    if (panel.index >= count) setPanel(null)
  }, [panel, shape])

  const trackedLine = wrapRef.current ? sourceLineOf(wrapRef.current) : -1
  const parsed = shape && trackedLine >= 0 ? parseAt(trackedLine) : null

  return useMemo(() => ({
    layerRef,
    shape,
    panel,
    marker,
    hover,
    editor,
    parsed,
    line: trackedLine,
    openPanel,
    closePanel,
    setPinned,
    insertAt,
    dropOnEdge,
    commitCellEdit,
    cancelCellEdit,
    parseAimed,
    commit,
  }), [
    shape, panel, marker, hover, editor, parsed, trackedLine, openPanel, closePanel, setPinned, insertAt, dropOnEdge,
    commitCellEdit, cancelCellEdit, parseAimed, commit,
  ])
}

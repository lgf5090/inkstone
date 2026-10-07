import { MEDIA_MAX_ROW_HEIGHT, MEDIA_MIN_ROW_HEIGHT, clampRowHeight, clampWidth } from '../../lib/markdown/media-layout'
import { mediaRowFromDOM } from '../../lib/markdown/media-layout-view'
import { editBlockGeometry, editMoveCell, editRowOptions } from '../../lib/markdown/media-layout-source'
import type { MediaEdit } from '../../lib/markdown/media-layout-source'
import { executeMediaAction, headerLineOf } from './media-layout'
import { t } from '../../lib/i18n'

/**
 * The pointer half of a layout block: drag a gap, an edge, a picture.
 *
 * Nothing is written to the note while the pointer moves. The page is resized with custom properties on the
 * elements being dragged, which is what lets a drag run at frame rate on a note that would otherwise render
 * the whole document per mouse event; the *number* the reader ended up with is written once, on release, as
 * one line edit — one undo, and nothing in the note that the gesture did not touch.
 *
 * Because a preview must be unwindable — Escape, a refused write, a surface that lost the note mid-drag —
 * every starting value is captured at pointerdown: the block's width in pixels, each row's height, each
 * cell's width, the class lists. Nothing is ever computed from what the preview itself wrote, or a drag
 * would compound its own frames instead of following the pointer.
 *
 * Every measurement is taken on the live host. The renderer builds its markup on a detached tree where each
 * rectangle is zero, which is why the strip between two pictures is placed here rather than there.
 */

export interface MediaSurface {
  /** The note text this surface is showing, or null when it has nothing to write back to. */
  source: () => string | null
  commit: (edit: MediaEdit) => boolean
  /**
   * Replace the whole document, for the presses a line range cannot express — the settings panel's own
   * buttons commit a full document the way every other block toolbar in the app does.
   */
  replaceDocument?: (next: string) => void
  toast: (message: string, tone?: 'default' | 'success' | 'warning' | 'danger') => void
}

type GestureKind = 'none' | 'width' | 'height' | 'both' | 'boundary' | 'place' | 'reorder';

interface Gesture {
  kind: GestureKind
  block: HTMLElement | null
  row: HTMLElement | null
  cells: HTMLElement[]
  index: number
  pair: [number, number]
  pointerId: number
  startX: number
  startY: number
  /** The block's width in pixels when the gesture began, which is what a percent is divided by. */
  startWidth: number
  /** The block's height in pixels when the gesture began, which is what a row is scaled from. */
  startHeight: number
  /** Each row's height at pointerdown, keyed by the row, so a frame drag scales and never compounds. */
  startRowHeights: Map<HTMLElement, number>
  /** Each cell's width at pointerdown, in pixels. */
  widths: number[]
  moved: boolean
  styles: Array<{ node: HTMLElement, name: string, value: string }>
  classes: Array<{ node: HTMLElement, value: string }>
}

const MIN_CELL_PX = 48
const GAP_HIT_PX = 12
const DRAG_START_PX = 4

function emptyGesture(): Gesture {
  return {
    kind: 'none',
    block: null,
    row: null,
    cells: [],
    index: 0,
    pair: [0, 0],
    pointerId: -1,
    startX: 0,
    startY: 0,
    startWidth: 0,
    startHeight: 0,
    startRowHeights: new Map(),
    widths: [],
    moved: false,
    styles: [],
    classes: [],
  }
}

function snapshot(gesture: Gesture, node: HTMLElement, property: string): void {
  if (gesture.styles.some((entry) => entry.node === node && entry.name === property)) return
  gesture.styles.push({ node, name: property, value: node.style.getPropertyValue(property) })
}

function snapshotClass(gesture: Gesture, node: HTMLElement): void {
  if (gesture.classes.some((entry) => entry.node === node)) return
  gesture.classes.push({ node, value: node.className })
}

function restore(gesture: Gesture): void {
  for (const entry of gesture.styles) {
    if (entry.value) entry.node.style.setProperty(entry.name, entry.value)
    else entry.node.style.removeProperty(entry.name)
  }
  for (const entry of gesture.classes) entry.node.className = entry.value
  gesture.styles = []
  gesture.classes = []
}

function rowsOf(block: HTMLElement): HTMLElement[] {
  return [...block.querySelectorAll<HTMLElement>(':scope > .markdown-media-row')]
}

/** The nearest enclosing element matching a selector, from whatever an event was aimed at. */
function closestOf(target: EventTarget | null, selector: string): HTMLElement | null {
  const element = target instanceof Element ? target : null
  return element ? element.closest<HTMLElement>(selector) : null
}

function cellsOf(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>(':scope > .markdown-media-cell')]
}

function widthOf(node: HTMLElement): number {
  return node.getBoundingClientRect().width
}

function heightOf(node: HTMLElement): number {
  return node.getBoundingClientRect().height
}

/** The width the header says the block has: a sized block states its own number, an unsized one the line. */
function declaredPercent(block: HTMLElement): number {
  const declared = Number(block.dataset.mediaWidth)
  return Number.isInteger(declared) && declared >= 20 && declared <= 100 ? declared : 100
}

/** Where each gap of a row really is, in the row's own coordinates. */
function gapPositions(row: HTMLElement): number[] {
  const cells = cellsOf(row)
  const origin = row.getBoundingClientRect().left
  const stops: number[] = []
  for (let index = 0; index < cells.length - 1; index++) {
    const left = cells[index]!.getBoundingClientRect()
    const right = cells[index + 1]!.getBoundingClientRect()
    stops.push((left.right + right.left) / 2 - origin)
  }
  return stops
}

function gapNear(row: HTMLElement, x: number): number {
  const stops = gapPositions(row)
  for (let index = 0; index < stops.length; index++) {
    if (Math.abs(stops[index]! - x) <= GAP_HIT_PX) return index
  }
  return -1
}

/**
 * The strip that says "this gap can be dragged".
 *
 * It is built the first time a pointer finds that gap, because until then nothing has a width: the block's
 * markup is assembled on a detached tree, and a strip positioned from a zero would sit at the row's left
 * edge forever.
 */
function showGapHandle(row: HTMLElement, index: number): void {
  const at = gapPositions(row)[index]
  if (at === undefined) return
  let layer = row.querySelector<HTMLElement>(':scope > .media-handles')
  if (!layer) {
    layer = document.createElement('div')
    layer.className = 'media-handles'
    row.append(layer)
  }
  let strip = layer.querySelector<HTMLElement>(`[data-media-gap="${index}"]`)
  if (!strip) {
    strip = document.createElement('div')
    strip.className = 'media-splitter'
    strip.dataset.mediaGap = String(index)
    strip.setAttribute('role', 'separator')
    strip.setAttribute('aria-label', t('preview.media_gap_handle'))
    layer.append(strip)
  }
  strip.style.left = `${at}px`
  strip.classList.add('is-media-shown')
}

function hideGapHandles(scope: HTMLElement): void {
  scope.querySelectorAll<HTMLElement>('.media-splitter').forEach((strip) => strip.classList.remove('is-media-shown'))
}

/**
 * The weights a gap drag produces, from the widths the row was showing when the pointer went down.
 *
 * Pictures the reader did not touch keep the share they were drawn with, so dragging one gap cannot quietly
 * re-shape the rest of the row. Pixels become relative numbers here, at the one decimal the source format
 * carries. This is the only arithmetic of a resize: the live preview and the written note both come from it,
 * so what the reader saw is what the note says.
 */
export function weightsAfterDrag(widths: number[], pair: [number, number], dx: number): number[] {
  const [a, b] = pair
  const shares = widths.map((value, index) => {
    if (index === a) return Math.max(MIN_CELL_PX, value + dx)
    if (index === b) return Math.max(MIN_CELL_PX, value - dx)
    return value
  })
  const smallest = Math.min(...shares)
  if (!(smallest > 0)) return []
  return shares.map((value) => Math.min(99, Math.max(0.1, Math.round((value / smallest) * 10) / 10)))
}

/** The block width, in percent of the line, after dragging an edge by `dx` pixels. */
export function percentAfterDrag(startPx: number, startPercent: number, dx: number): number {
  const perPercent = Math.max(0.01, startPx / Math.max(1, startPercent))
  return clampWidth((startPx + dx) / perPercent)
}

/** Every row's height after the frame's bottom edge moved by `dy` pixels, scaled from the whole frame. */
export function rowHeightsAfterDrag(startHeights: number[], startTotal: number, dy: number): number[] {
  const total = Math.max(1, startTotal)
  const ratio = Math.max(0.2, Math.min(5, (total + dy) / total))
  return startHeights.map((height) => clampRowHeight(Math.max(1, height) * ratio))
}

/** Where a single picture in a row lands, from the pointer's share of the row's width. */
export function alignForShare(share: number): MediaAlignChoice {
  return share < 0.3 ? 'left' : share > 0.7 ? 'right' : 'center'
}

type MediaAlignChoice = 'left' | 'center' | 'right';

export function attachMediaLayoutHost(host: HTMLElement, getSurface: () => MediaSurface | null, ownActions = false): () => void {
  let gesture: Gesture = emptyGesture()
  let swallowClick = false
  // The live editor replaces a rendered block with its own source the moment the caret lands inside it,
  // so a press on the block's chrome would shut the panel it had just opened. Where that surface is the
  // host, this one answers the presses itself and keeps the caret where it was.
  const liveWidget = host.classList.contains('cm-live-block')

  const writeDocument = (next: string): void => {
    const surface = getSurface()
    const current = surface?.source()
    if (surface && current !== null && current !== next) surface.replaceDocument?.(next)
  }

  const captureBlock = (next: Gesture): void => {
    const block = next.block
    if (!block) return
    next.startWidth = widthOf(block)
    next.startHeight = heightOf(block)
    snapshot(next, block, '--media-width')
    for (const row of rowsOf(block)) {
      next.startRowHeights.set(row, heightOf(row))
      snapshot(next, row, '--media-row-h')
      snapshotClass(next, row)
      for (const cell of cellsOf(row)) snapshotClass(next, cell)
    }
  }

  const begin = (event: PointerEvent): Gesture | null => {
    const target = event.target as HTMLElement | null
    if (!target || event.button !== 0 || !target.closest) return null
    if (target.closest('a, input, textarea, select, [data-media-action]')) return null
    const block = target.closest<HTMLElement>('.markdown-media[data-media]')
    if (!block) return null
    if (getSurface()?.source() == null) return null

    const next = emptyGesture()
    next.block = block
    next.pointerId = event.pointerId
    next.startX = event.clientX
    next.startY = event.clientY

    const handle = target.closest<HTMLElement>('[data-media-handle]')
    if (handle) {
      const which = handle.dataset.mediaHandle
      next.kind = which === 'width' || which === 'both' || which === 'height' ? which : 'none'
      if (next.kind === 'none') return null
      captureBlock(next)
      return next
    }

    const row = target.closest<HTMLElement>('.markdown-media-row')
    if (!row || row.closest('.markdown-media') !== block) return null
    next.row = row
    const x = event.clientX - row.getBoundingClientRect().left
    // A columned block has no gap to pull apart: its pictures sit in the block's own grid tracks, and the
    // numbers this gesture writes — a per-row share — are what a row with no box cannot answer to.
    const gap = block.hasAttribute('data-media-columns') ? -1 : gapNear(row, x)
    const cells = cellsOf(row)
    next.cells = cells
    next.widths = cells.map((cell) => Math.max(1, Math.round(gap >= 0 ? Math.max(MIN_CELL_PX, widthOf(cell)) : widthOf(cell))))
    if (gap >= 0) {
      next.kind = 'boundary'
      next.pair = [gap, gap + 1]
      for (const cell of cells) {
        snapshot(next, cell, '--media-w')
        snapshotClass(next, cell)
      }
      return next
    }
    const cell = target.closest<HTMLElement>('.markdown-media-cell')
    if (!cell || cell.closest('.markdown-media-row') !== row) return null
    // A lone picture in a columned block has no room to slide to: the grid track it sits in is where it
    // stays, so the placement gesture that would only write a dead alignment is not offered at all.
    if (cells.length === 1 && block.hasAttribute('data-media-columns')) return null
    next.index = cells.indexOf(cell)
    next.kind = cells.length === 1 ? 'place' : 'reorder'
    snapshotClass(next, cell)
    return next
  }

  const previewWidth = (dx: number): void => {
    if (!gesture.block) return
    const percent = percentAfterDrag(gesture.startWidth, declaredPercent(gesture.block), dx)
    gesture.block.style.setProperty('--media-width', `${percent}%`)
  }

  const previewRows = (dy: number): void => {
    const active = gesture
    if (!active.block) return
    const rows = rowsOf(active.block)
    const heights = rowHeightsAfterDrag(rows.map((row) => active.startRowHeights.get(row) ?? heightOf(row)), active.startHeight, dy)
    rows.forEach((row, index) => {
      row.style.setProperty('--media-row-h', `${heights[index] ?? 1}px`)
      row.classList.add('is-media-sized')
      for (const cell of cellsOf(row)) cell.classList.add('is-media-sized')
    })
  }

  const previewGap = (dx: number): void => {
    const active = gesture
    const weights = weightsAfterDrag(active.widths, active.pair, dx)
    active.cells.forEach((cell, index) => {
      cell.classList.add('is-media-weighted')
      cell.style.setProperty('--media-w', String(weights[index] ?? 1))
    })
    if (active.row) showGapHandle(active.row, active.pair[0])
  }

  const previewPlace = (event: PointerEvent): void => {
    const active = gesture
    if (!active.row) return
    const rect = active.row.getBoundingClientRect()
    const align = alignForShare((event.clientX - rect.left) / Math.max(1, rect.width))
    active.row.style.justifyContent = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center'
    active.cells[active.index]?.classList.add('is-media-lifted')
  }

  /** The node under the pointer, where the platform can say; a surface with no layout answers nothing. */
  const pointTarget = (x: number, y: number): HTMLElement | null => {
    if (typeof document.elementFromPoint !== 'function') return null
    return document.elementFromPoint(x, y) as HTMLElement | null
  }

  const previewReorder = (event: PointerEvent): void => {
    const active = gesture
    const block = active.block
    if (!block) return
    const drop = pointTarget(event.clientX, event.clientY) as HTMLElement | null
    const cell = drop?.closest<HTMLElement>('.markdown-media-cell') ?? null
    for (const each of block.querySelectorAll<HTMLElement>('.markdown-media-cell')) {
      each.classList.toggle('is-media-over', each === cell && each !== active.cells[active.index])
    }
    active.cells[active.index]?.classList.add('is-media-lifted')
  }

  const apply = (event: PointerEvent): void => {
    const active = gesture
    if (active.kind === 'none' || !active.block) return
    const dx = event.clientX - active.startX
    const dy = event.clientY - active.startY
    if (!active.moved) {
      if (Math.abs(dx) < DRAG_START_PX && Math.abs(dy) < DRAG_START_PX) return
      active.moved = true
      active.block.classList.add('is-media-dragging')
      // Capture only once the reader has committed to a drag: a click must keep reaching the editor.
      host.setPointerCapture?.(event.pointerId)
    }
    if (active.kind === 'width') previewWidth(dx)
    else if (active.kind === 'both') {
      previewWidth(dx)
      previewRows(dy)
    }
    else if (active.kind === 'height') previewRows(dy)
    else if (active.kind === 'boundary') previewGap(dx)
    else if (active.kind === 'place') previewPlace(event)
    else previewReorder(event)
  }

  const editFor = (active: Gesture, event: PointerEvent): MediaEdit | null => {
    const block = active.block
    if (!block) return null
    const source = getSurface()?.source()
    const line = headerLineOf(block)
    if (source == null || line === null) return null
    if (active.kind === 'width' || active.kind === 'both' || active.kind === 'height') {
      const dx = event.clientX - active.startX
      const dy = event.clientY - active.startY
      const width = active.kind === 'height'
        ? null
        : percentAfterDrag(active.startWidth, declaredPercent(block), dx)
      const rows = active.kind === 'width' ? [] : rowsOf(block)
      const heights = rows.length === 0 ? [] : rowHeightsAfterDrag(
        rows.map((row) => active.startRowHeights.get(row) ?? heightOf(row)),
        active.startHeight,
        dy,
      ).map((height, index) => ({ line: Number(rows[index]!.dataset.line), height }))
        .filter((entry) => Number.isInteger(entry.line))
      return editBlockGeometry(source, line, { width, heights })
    }
    const rowLine = Number(active.row?.dataset.line)
    if (!Number.isInteger(rowLine)) return null
    if (active.kind === 'boundary') {
      const weights = weightsAfterDrag(active.widths, active.pair, event.clientX - active.startX)
      return editRowOptions(source, line, rowLine, (current) => ({ ...current, weights }))
    }
    if (active.kind === 'place') {
      const rect = (active.row as HTMLElement).getBoundingClientRect()
      const align = alignForShare((event.clientX - rect.left) / Math.max(1, rect.width))
      if (mediaRowFromDOM(active.row as HTMLElement).align === align) return null
      return editRowOptions(source, line, rowLine, (current) => ({ ...current, align }))
    }
    if (active.kind === 'reorder') {
      const drop = pointTarget(event.clientX, event.clientY) as HTMLElement | null
      const cell = drop?.closest<HTMLElement>('.markdown-media-cell')
      const row = drop?.closest<HTMLElement>('.markdown-media-row')
      if (!cell || !row || !block.contains(row)) return null
      const target = Number(row.dataset.line)
      const index = cellsOf(row).indexOf(cell)
      if (index < 0 || !Number.isInteger(target)) return null
      const sameRow = target === rowLine
      // Inside a row the picture lands where the pointer went; across rows it joins the end.
      const to = sameRow ? (index > active.index ? index - 1 : index) : cellsOf(row).length - 1
      if (sameRow && to === active.index) return null
      return editMoveCell(source, line, { line: rowLine, index: active.index }, { line: target, index: to })
    }
    return null
  }

  const finish = (event: PointerEvent): void => {
    const active = gesture
    if (active.kind === 'none') return
    gesture = emptyGesture()
    active.block?.classList.remove('is-media-dragging')
    if (active.block) hideGapHandles(active.block)
    if (!active.moved) {
      restore(active)
      return
    }
    // The release also ends the click the same pointer sequence would otherwise deliver, so a drag never
    // doubles as "open the lightbox" or "jump the caret here".
    swallowClick = true
    const surface = getSurface()
    if (!surface || !active.block) {
      restore(active)
      return
    }
    const edit = editFor(active, event)
    restore(active)
    if (edit === null) return
    if (!surface.commit(edit)) surface.toast(t('preview.media_edit_unavailable'), 'warning')
  }

  const cancel = (): void => {
    const active = gesture
    if (active.kind === 'none') return
    gesture = emptyGesture()
    active.block?.classList.remove('is-media-dragging')
    if (active.block) hideGapHandles(active.block)
    restore(active)
  }

  const onPointerDown = (event: PointerEvent): void => {
    const started = begin(event)
    if (!started) return
    gesture = started
    // An edge or a gap is unambiguous: nothing else lives there. A picture is not — a press on one that
    // never moves has to reach the editor as the click it was, so only these two take the event.
    const kind = started.kind
    if (kind === 'width' || kind === 'height' || kind === 'both' || kind === 'boundary') {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (gesture.kind !== 'none') {
      if (event.pointerId !== gesture.pointerId) return
      apply(event)
      return
    }
    const row = closestOf(event.target, '.markdown-media-row')
    if (!row || !row.querySelector('.markdown-media-cell')) return
    if (row.closest('.markdown-media')?.hasAttribute('data-media-columns')) {
      hideGapHandles(row)
      return
    }
    const gap = gapNear(row, event.clientX - row.getBoundingClientRect().left)
    if (gap >= 0) showGapHandle(row, gap)
    else hideGapHandles(row)
  }

  const onPointerUp = (event: PointerEvent): void => {
    if (gesture.kind === 'none' || event.pointerId !== gesture.pointerId) return
    finish(event)
  }

  const onClickCapture = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null
    const chrome = liveWidget ? target?.closest?.('[data-media-action], [data-media-handle], .markdown-media-cell') ?? null : null
    if (chrome) {
      // Nothing below this block's own picture, handle or button belongs to the caret.
      event.stopPropagation()
      const button = chrome.closest<HTMLElement>('[data-media-action]')
      if (button && ownActions) {
        event.preventDefault()
        const source = getSurface()?.source()
        const surface = getSurface()
        if (source === null || source === undefined || !surface) return
        executeMediaAction(button.dataset.mediaAction!, button, source, writeDocument, (message) => surface.toast(message.title, message.tone))
      }
      return
    }
    if (!swallowClick) return
    swallowClick = false
    event.preventDefault()
    event.stopPropagation()
  }

  const stepBy = (event: KeyboardEvent): number => {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
    const step = event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? 5 : 20
    return forward ? step : -step
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      cancel()
      return
    }
    // The arrow test comes before the containment test on purpose: this listener answers every key press of
    // every rendered block in the note, and a keystroke that could not be a step must not walk the tree.
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    if (!host.contains(event.target as Node)) return
    const handle = closestOf(event.target, '[data-media-handle]')
    if (!handle) return
    const block = handle.closest<HTMLElement>('.markdown-media[data-media]')
    const source = getSurface()?.source()
    const line = block ? headerLineOf(block) : null
    if (!block || source == null || line === null) return
    const delta = stepBy(event)
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
    const which = handle.dataset.mediaHandle
    // Each edge answers to its own axis, and the corner to both: an arrow that the reader did not aim at
    // this handle changes nothing, rather than resizing the block sideways when they meant vertically.
    const asksWidth = which === 'both' || (which === 'width' && horizontal)
    const asksHeight = which === 'both' ? !horizontal : which === 'height' && !horizontal
    let edit: MediaEdit | null = null
    if (asksWidth) edit = editBlockGeometry(source, line, { width: clampWidth(declaredPercent(block) + delta), heights: [] })
    else if (asksHeight) {
      const rows = rowsOf(block)
      if (!rows.length) return
      const heights = rows
        .map((row) => ({ line: Number(row.dataset.line), height: clampRowHeight((mediaRowFromDOM(row).height ?? heightOf(row)) + delta) }))
        .filter((entry) => Number.isInteger(entry.line))
      edit = heights.length ? editBlockGeometry(source, line, { width: null, heights }) : null
    }
    if (edit === null) return
    event.preventDefault()
    event.stopPropagation()
    const surface = getSurface()
    if (surface && !surface.commit(edit)) surface.toast(t('preview.media_edit_unavailable'), 'warning')
  }

  host.addEventListener('pointerdown', onPointerDown, true)
  host.addEventListener('pointermove', onPointerMove)
  host.addEventListener('pointerup', onPointerUp)
  host.addEventListener('pointercancel', cancel)
  host.addEventListener('click', onClickCapture, true)
  // Escape is listened for above the host on purpose: in the live editor the focused element is the
  // editor itself, an ancestor of the rendered block, so a key pressed to abandon a drag would never
  // reach a handler on the widget host at all.
  document.addEventListener('keydown', onKeyDown, true)
  return () => {
    cancel()
    host.removeEventListener('pointerdown', onPointerDown, true)
    host.removeEventListener('pointermove', onPointerMove)
    host.removeEventListener('pointerup', onPointerUp)
    host.removeEventListener('pointercancel', cancel)
    host.removeEventListener('click', onClickCapture, true)
    document.removeEventListener('keydown', onKeyDown, true)
  }
}

/** The band a keyboard step is allowed to move inside, kept next to the code that asks for it. */
export const MEDIA_HEIGHT_LIMITS = { min: MEDIA_MIN_ROW_HEIGHT, max: MEDIA_MAX_ROW_HEIGHT }

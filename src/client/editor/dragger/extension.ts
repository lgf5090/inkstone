import { EditorState, StateEffect, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type Command, type PluginValue, type ViewUpdate } from '@codemirror/view'
import {
  HANDLE_CLASS,
  applyCommit,
  dragRuntime,
  dragTransitionEffect,
  dropSeam,
  elementTarget,
  lineAtPoint,
  lineBand,
  resolveDropPositionAtPoint,
  scrollPort,
  sourceLineFromInput,
  type MdDraggerCodeMirrorOptions,
} from 'md-dragger/adapter/codemirror'
import {
  detectBlock,
  isLineNumberInRanges,
  selectionLineRanges,
  type DropPosition,
  type LineRange,
} from 'md-dragger/domain'
import { dragSelectionDoc, dropSeamState, selectionFromOutputs, type PipelineOutput } from 'md-dragger/runtime'
import { autoScroll } from 'md-dragger/runtime/modules'
import type { EditorSettings } from '@shared/types'
import { DRAGGER_DRAGGING_CLASS, DRAGGER_EDITOR_CLASS, DRAGGER_GESTURE_LOCK_CLASS } from './presentation'
import { applyDocEdits, moveBlockOver, outsideTable } from './commands'

/** What the editor host tells the dragger, and what the dragger can ask of it. */
export interface DraggerHost {
  /** Read live: a colour or a duration changes the next frame, without rebuilding the editor. */
  settings(): EditorSettings
  /** The pointer device, not the screen width — a stylus laptop drags from the handle like a desktop. */
  isTouch(): boolean
  /** Long-press-anywhere mode, which a reader turns on for one carrying session on a phone. */
  dragMode(): boolean
  openBlockMenu(view: EditorView, line: number, point: { x: number, y: number }): void
  /** A block landed. The host may repaint what a move invalidates, and end a phone's drag mode. */
  notifyDrop(): void
}

const CORE_CLASS = 'ink-dragger-handle-core'

/** Dispatched by the host when a setting the layer paints from has changed. */
export const draggerOptionsChanged = StateEffect.define<null>()

/** The settings the layer reads while drawing; the rest reach the DOM through custom properties. */
export function draggerPaintKey(settings: EditorSettings): string {
  return [settings.dragger, settings.draggerHandles, settings.draggerHandleSize,
    settings.draggerHandleOffset, settings.draggerHandleSide, settings.draggerHighlight].join(':')
}
const HANDLE_GAP = 6

/**
 * The dragger's editor extensions.
 *
 * The engine owns the gesture, the block rules and the move plan; this host owns the pixels. Handles,
 * the carried block's highlight, and the drop seam are drawn in one overlay layer because a rendered
 * block in live preview has no line element of its own — its source lines are inside a widget, and a
 * gutter decoration or a line class would have nothing to attach to.
 *
 * The extension is mounted once and read live: rebuilding it would tear the engine down inside a
 * CodeMirror update, which it does not survive, so switching the feature off takes away the grips and
 * the press rather than unmounting the runtime.
 */
export function draggerExtensions(host: DraggerHost): Extension[] {
  const options: MdDraggerCodeMirrorOptions = {
    config: () => {
      const tabSize = Math.max(1, host.settings().tabSize)
      return { tabSize, listIndentUnit: tabSize }
    },
    listIndentWidthPx: (view) => draggerIndentStepPx(view, host),
    locate: (view) => ({
      sourceLineFromInput: (input) => {
        if (!host.settings().dragger) return null
        const fromHandle = sourceLineFromInput(view, input)
        if (fromHandle !== null) return fromHandle
        if (!host.isTouch() || !host.dragMode()) return null
        const target = elementTarget(input.native)
        if (target && !view.dom.contains(target)) return null
        return lineAtPoint(view, input.point)
      },
      // The engine's own rules cover fences, math and rules; a table's interior is the seam it will
      // accept and the note cannot survive, so the host answers for it.
      resolveDropPosition: (point, context) => {
        if (!host.settings().dragger) return null
        const position = resolveDropPositionAtPoint(view, point, context.selection, options)
        return position ? outsideTable(view.state.doc, position, Math.max(1, host.settings().tabSize)) : null
      },
    }),
    ux: (view) => ({
      gesture: () => gestureConfig(host),
      modules: dragModules(host, view),
    }),
    // The engine plans the move; the host writes it. Committing here is what lets a drop keep the
    // note's blank-line rhythm instead of leaving a gap that grows with every drag.
    commit: (view) => ({
      apply: (edits) => {
        for (const edit of edits) {
          // A second editor over the same document (a pinned window) is the engine's own registry's
          // business; only the view that owns the doc rewrites it here.
          if (edit.doc !== view.state.doc) applyCommit([edit])
          else applyDocEdits(view, [edit], 'drag.drop')
        }
      },
    }),
    onChange: (result) => {
      for (const output of result.outputs) {
        if (output.type === 'dropped') host.notifyDrop()
      }
    },
  }
  return [
    EditorView.editorAttributes.of({ class: DRAGGER_EDITOR_CLASS }),
    dragRuntime(options),
    draggerLayer(host, options),
    handleHover(host),
    gestureShell(host),
  ]
}

function gestureConfig(host: DraggerHost) {
  const settings = host.settings()
  const carrying = host.isTouch() && host.dragMode()
  return {
    // Desktop: a press on a handle becomes a drag the moment it travels. On a phone the press has to
    // be held first, so a tap stays a tap.
    dragArmMs: carrying ? settings.draggerMobileArmMs : 0,
    multiSelectMs: settings.draggerMultiSelectMs,
    dragStartMoveThresholdPx: carrying ? 8 : 4,
    // Travel never cancels a drag: on a touch screen a swipe back toward the origin reads as a drop in
    // place, not as a cancel, and the release settles it.
    dragCancelMoveThresholdPx: Number.POSITIVE_INFINITY,
    multiSelectEnabled: settings.draggerMultiSelect,
  }
}

function dragModules(host: DraggerHost, view: EditorView) {
  if (!host.settings().draggerAutoScroll) return []
  return [autoScroll(
    scrollPort(() => view.dom.ownerDocument),
    () => ({
      edgeZonePx: host.settings().draggerAutoScrollEdge,
      maxSpeedPx: host.settings().draggerAutoScrollSpeed,
    }),
  )]
}

const indentStepCache = new WeakMap<EditorView, { doc: unknown; px: number }>()

/**
 * How wide one nesting level is on screen — the number that turns a drag's sideways travel into an
 * indent level, and a carried block's highlight into the column it actually sits in.
 *
 * Source mode writes an indent as literal spaces, so a level is `tabSize` characters wide. A rendered
 * list indents by the prose sheet's own padding instead, and that is measured from a list the editor
 * has drawn. The engine asks on every drag frame, so the answer is kept until the document changes.
 */
function draggerIndentStepPx(view: EditorView, host: DraggerHost): number {
  const tabSize = Math.max(1, host.settings().tabSize)
  const fallback = view.defaultCharacterWidth * tabSize
  const cached = indentStepCache.get(view)
  if (cached && cached.doc === view.state.doc) return cached.px
  const px = Math.max(8, Math.round((renderedListStepPx(view) || fallback) * 100) / 100)
  indentStepCache.set(view, { doc: view.state.doc, px })
  return px
}

function renderedListStepPx(view: EditorView): number {
  const win = view.dom.ownerDocument.defaultView
  if (!win) return 0
  const nested = view.contentDOM.querySelector<HTMLElement>('li > ul, li > ol')
  if (!nested) return 0
  const style = win.getComputedStyle(nested)
  const step = (parseFloat(style.paddingInlineStart) || 0) + (parseFloat(style.marginInlineStart) || 0)
  return Number.isFinite(step) && step > 0 ? step : 0
}

/**
 * The one layer that shows the dragger: a grip beside every block in view, the band over the block
 * being carried, and the seam where it will land.
 *
 * Everything is placed in document coordinates and moved with the scroll, the same way the outline
 * guides are, so a frame of dragging costs one measure pass instead of a re-render of the note.
 */
function draggerLayer(host: DraggerHost, options: MdDraggerCodeMirrorOptions): Extension {
  return ViewPlugin.fromClass(class implements PluginValue {
    private readonly layer: HTMLElement
    private readonly inner: HTMLElement
    private readonly grips = new Map<number, HTMLElement>()
    private readonly bands: HTMLElement[] = []
    private seam: HTMLElement | null = null
    private ranges: LineRange[] = []
    private seamState: { position: DropPosition | null, invalid: boolean } = { position: null, invalid: false }
    private frame = 0
    private readonly onScroll = () => this.syncScroll()
    constructor(private readonly view: EditorView) {
      this.layer = view.dom.ownerDocument.createElement('div')
      this.layer.className = 'ink-dragger-layer'
      this.inner = view.dom.ownerDocument.createElement('div')
      this.inner.className = 'ink-dragger-inner'
      this.layer.append(this.inner)
      view.dom.appendChild(this.layer)
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true })
      this.draw()
    }
    update(update: ViewUpdate) {
      let transitions = false
      for (const transaction of update.transactions) {
        for (const effect of transaction.effects) {
          if (!effect.is(dragTransitionEffect)) continue
          transitions = true
          this.consume(effect.value.outputs, update)
        }
      }
      const optionsChanged = update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(draggerOptionsChanged)))
      if (transitions || optionsChanged || update.viewportChanged || update.geometryChanged || update.docChanged) this.schedule()
    }
    destroy() {
      if (this.frame) this.view.dom.ownerDocument.defaultView?.cancelAnimationFrame(this.frame)
      this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
      this.layer.remove()
    }
    /** The engine's per-frame output, kept as data: which blocks are in hand, and where the seam is. */
    private consume(outputs: readonly PipelineOutput[], update: ViewUpdate) {
      const sourceDoc = dragSelectionDoc(outputs)
      if (sourceDoc === null || sourceDoc === update.state.doc) {
        const selection = selectionFromOutputs(outputs)
        this.ranges = selectionLineRanges(update.state.doc.lines, selection ?? { blocks: [] })
      }
      const next = dropSeamState(outputs, update.state.doc)
      this.seamState = { position: next.position, invalid: next.invalid }
    }
    private schedule() {
      const win = this.view.dom.ownerDocument.defaultView
      if (!win || this.frame) return
      this.frame = win.requestAnimationFrame(() => {
        this.frame = 0
        this.draw()
      })
    }
    private draw() {
      const view = this.view
      const settings = host.settings()
      const editorLeft = view.dom.getBoundingClientRect().left
      // A grip is centred on the row it belongs to, and a row's height is the editor's own line box —
      // the stylesheet cannot know it, because the editor's font changes with the reader's settings.
      const win = view.dom.ownerDocument.defaultView
      const lineHeight = win ? parseFloat(win.getComputedStyle(view.contentDOM).lineHeight) || 0 : 0
      if (lineHeight > 0) this.layer.style.setProperty('--ink-dragger-line-height', `${Math.round(lineHeight)}px`)
      this.drawGrips(view, settings, editorLeft)
      this.drawBands(view, options, editorLeft)
      this.drawSeam(view, options, editorLeft)
      this.syncScroll()
    }
    private drawGrips(view: EditorView, settings: EditorSettings, editorLeft: number) {
      const wanted = new Set<number>()
      if (settings.dragger && settings.draggerHandles !== 'hidden') {
        for (const block of view.viewportLineBlocks) {
          const line = blockStartLine(view, block.from)
          if (line !== null) wanted.add(line)
        }
      }
      const left = this.gripLeft(view, settings, editorLeft)
      for (const [line, grip] of this.grips) {
        if (wanted.has(line)) continue
        grip.remove()
        this.grips.delete(line)
      }
      for (const line of wanted) {
        const block = view.lineBlockAt(view.state.doc.line(line).from)
        let grip = this.grips.get(line)
        if (!grip) {
          grip = createGrip(view.dom.ownerDocument)
          grip.setAttribute('data-block-start', String(line))
          this.grips.set(line, grip)
          this.inner.appendChild(grip)
        }
        grip.style.top = `${Math.round(block.top)}px`
        grip.style.left = `${Math.round(left)}px`
        grip.classList.toggle('is-selected', isLineNumberInRanges(line, this.ranges))
      }
    }
    /** Where the rail puts a grip: beside the text column, or inside its padding when there is no room. */
    private gripLeft(view: EditorView, settings: EditorSettings, editorLeft: number): number {
      const content = view.contentDOM.getBoundingClientRect()
      const size = settings.draggerHandleSize
      const offset = settings.draggerHandleSide === 'right' ? -settings.draggerHandleOffset : settings.draggerHandleOffset
      if (settings.draggerHandleSide === 'right') {
        const room = view.scrollDOM.clientWidth - (content.right - editorLeft) - size
        return content.right - editorLeft + Math.max(0, Math.min(HANDLE_GAP, room)) + offset
      }
      return Math.max(0, content.left - editorLeft - size - HANDLE_GAP) + offset
    }
    private drawBands(view: EditorView, options: MdDraggerCodeMirrorOptions, editorLeft: number) {
      const bands = host.settings().draggerHighlight
        ? bandsFor(view, options, this.ranges, editorLeft)
        : []
      for (const [index, band] of bands.entries()) {
        let element = this.bands[index]
        if (!element) {
          element = view.dom.ownerDocument.createElement('div')
          element.className = `${DRAG_SOURCE_CLASS} ink-dragger-band`
          this.bands[index] = element
          this.inner.appendChild(element)
        }
        element.style.top = `${Math.round(band.top)}px`
        element.style.left = `${Math.round(band.left)}px`
        element.style.width = `${Math.round(band.width)}px`
        element.style.height = `${Math.round(band.height)}px`
        element.style.display = 'block'
      }
      for (let index = bands.length; index < this.bands.length; index++) this.bands[index].style.display = 'none'
    }
    private drawSeam(view: EditorView, options: MdDraggerCodeMirrorOptions, editorLeft: number) {
      const position = this.seamState.position
      const seam = position ? dropSeam(view, position, options) : null
      if (!seam) {
        this.seam?.remove()
        this.seam = null
        return
      }
      if (!this.seam) {
        this.seam = view.dom.ownerDocument.createElement('div')
        this.seam.className = 'ink-dragger-seam'
        this.inner.appendChild(this.seam)
      }
      this.seam.classList.toggle('is-invalid', this.seamState.invalid)
      this.seam.style.top = `${Math.round(seam.y - view.documentTop)}px`
      this.seam.style.left = `${Math.round(seam.left - editorLeft)}px`
      this.seam.style.width = `${Math.round(Math.max(24, seam.right - seam.left))}px`
    }
    private syncScroll() {
      this.inner.style.transform = `translateY(${this.view.documentTop - this.view.dom.getBoundingClientRect().top}px)`
    }
  })
}

const DRAG_SOURCE_CLASS = 'md-dragger-drag-source'

function bandsFor(
  view: EditorView,
  options: MdDraggerCodeMirrorOptions,
  ranges: readonly LineRange[],
  editorLeft: number,
) {
  const bands: { top: number, left: number, width: number, height: number }[] = []
  const doc = view.state.doc
  for (const range of ranges) {
    const start = lineBand(view, range.startLine, options)
    const end = lineBand(view, Math.min(range.endLine, doc.lines), options)
    if (!start || !end) continue
    bands.push({
      top: start.top - view.documentTop,
      left: start.left - editorLeft,
      width: Math.max(24, start.right - start.left),
      height: Math.max(4, end.bottom - start.top),
    })
  }
  return bands
}

/** The document line a rendered block starts on, when that line begins a block. */
function blockStartLine(view: EditorView, from: number): number | null {
  const docLine = view.state.doc.lineAt(from)
  if (docLine.from !== from) return null
  const block = detectBlock(view.state.doc, docLine.number, { tabSize: view.state.facet(EditorState.tabSize) })
  return block && block.lines.startLine === docLine.number ? docLine.number : null
}

function createGrip(doc: Document): HTMLElement {
  const grip = doc.createElement('div')
  grip.className = HANDLE_CLASS
  const core = doc.createElement('span')
  core.className = CORE_CLASS
  core.setAttribute('aria-hidden', 'true')
  grip.appendChild(core)
  return grip
}

/** The handle of the block the pointer is over is the one that shows itself. */
function handleHover(host: DraggerHost): Extension {
  return ViewPlugin.fromClass(class implements PluginValue {
    private visible: HTMLElement | null = null
    private frame = 0
    private revealedAt = 0
    private readonly onMove = (event: PointerEvent) => {
      const view = this.view
      const win = view.dom.ownerDocument.defaultView
      if (!win) return
      // The pointer that has just arrived is answered at once: waiting a frame would leave the grip
      // under the cursor still invisible — and so still unclickable — for a fast first press.
      const now = win.performance.now()
      if (now - this.revealedAt > 120) {
        this.revealedAt = now
        this.hoverAt(event.clientX, event.clientY)
        return
      }
      if (this.frame) return
      this.frame = win.requestAnimationFrame(() => {
        this.frame = 0
        this.revealedAt = win.performance.now()
        this.hoverAt(event.clientX, event.clientY)
      })
    }
    private readonly onLeave = () => this.setVisible(null)
    constructor(private readonly view: EditorView) {
      view.dom.addEventListener('pointermove', this.onMove)
      view.dom.addEventListener('pointerleave', this.onLeave)
    }
    destroy() {
      const win = this.view.dom.ownerDocument.defaultView
      if (this.frame && win) win.cancelAnimationFrame(this.frame)
      this.view.dom.removeEventListener('pointermove', this.onMove)
      this.view.dom.removeEventListener('pointerleave', this.onLeave)
      this.setVisible(null)
    }
    private hoverAt(x: number, y: number) {
      const view = this.view
      if (!host.settings().dragger || document.documentElement.classList.contains(DRAGGER_DRAGGING_CLASS)) {
        this.setVisible(null)
        return
      }
      const line = lineAtPoint(view, { x, y })
      if (line === null) {
        this.setVisible(null)
        return
      }
      const block = detectBlock(view.state.doc, line, { tabSize: view.state.facet(EditorState.tabSize) })
      this.setVisible(block
        ? view.dom.querySelector<HTMLElement>(`.${HANDLE_CLASS}[data-block-start="${block.lines.startLine}"]`)
        : null)
    }
    private setVisible(handle: HTMLElement | null) {
      if (this.visible === handle) return
      this.visible?.classList.remove('is-visible')
      this.visible = handle
      handle?.classList.add('is-visible')
    }
  })
}

/**
 * The gesture's document-wide classes, and the menu a short press on a handle asks for.
 *
 * A press that never travelled is not a drag: it is the reader pointing at a block, and the block's
 * menu is what they get for pointing — the same offer a right-click makes.
 */
function gestureShell(host: DraggerHost): Extension {
  return ViewPlugin.fromClass(class implements PluginValue {
    private lastPress: { event: PointerEvent; onHandle: boolean } | null = null
    private locked: Document | null = null
    private readonly onTouchMove = (event: TouchEvent) => {
      event.preventDefault()
    }
    private readonly onPointerDown = (event: PointerEvent) => {
      this.lastPress = { event, onHandle: elementTarget(event)?.closest(`.${HANDLE_CLASS}`) != null }
      if (host.isTouch() && host.dragMode()) event.preventDefault()
    }
    private readonly onContextMenu = (event: Event) => {
      // The grip lives in this editor's overlay layer, outside `.cm-content`, so the host's own
      // `domEventHandlers` never see the event — the right answer for a grip is the block's menu.
      const pointer = event as MouseEvent
      const grip = elementTarget(pointer)?.closest(`.${HANDLE_CLASS}`) as HTMLElement | null
      if (grip) {
        event.preventDefault()
        const line = Number(grip.getAttribute('data-block-start'))
        if (Number.isInteger(line) && line > 0) host.openBlockMenu(this.view, line, { x: pointer.clientX, y: pointer.clientY })
        return
      }
      if (!host.isTouch() || !host.dragMode()) return
      event.preventDefault()
    }
    constructor(private readonly view: EditorView) {
      view.dom.addEventListener('pointerdown', this.onPointerDown, true)
      view.dom.addEventListener('contextmenu', this.onContextMenu, true)
    }
    update(update: ViewUpdate) {
      for (const transaction of update.transactions) {
        for (const effect of transaction.effects) {
          if (effect.is(dragTransitionEffect)) this.consume(effect.value.outputs)
        }
      }
    }
    destroy() {
      this.setLock(false)
      // A mode switch can tear the view down mid-drag, and a grabbing cursor left on the document
      // outlives the view that put it there.
      document.documentElement.classList.remove(DRAGGER_DRAGGING_CLASS)
      this.view.dom.removeEventListener('pointerdown', this.onPointerDown, true)
      this.view.dom.removeEventListener('contextmenu', this.onContextMenu, true)
    }
    private consume(outputs: readonly PipelineOutput[]) {
      for (const output of outputs) {
        if (output.type === 'state_changed') {
          const state = output.state.type
          this.setLock(state !== 'idle')
          document.documentElement.classList.toggle(DRAGGER_DRAGGING_CLASS, state === 'dragging')
        }
        if (output.type === 'cancelled' && output.reason === 'press_cancelled') {
          const press = this.lastPress
          this.lastPress = null
          const startLine = output.selection?.blocks[0]?.lines.startLine
          if (press?.onHandle && typeof startLine === 'number') {
            host.openBlockMenu(this.view, startLine, { x: press.event.clientX, y: press.event.clientY })
          }
        }
        if (output.type === 'dropped' || output.type === 'terminal') this.lastPress = null
      }
    }
    private setLock(locked: boolean) {
      if (locked === (this.locked !== null)) return
      if (locked) {
        const doc = this.view.dom.ownerDocument
        doc.documentElement.classList.add(DRAGGER_GESTURE_LOCK_CLASS)
        doc.addEventListener('touchmove', this.onTouchMove, { capture: true, passive: false })
        this.locked = doc
      } else if (this.locked !== null) {
        this.locked.documentElement.classList.remove(DRAGGER_GESTURE_LOCK_CLASS)
        this.locked.removeEventListener('touchmove', this.onTouchMove, true)
        this.locked = null
      }
    }
  })
}

/** The caret's block, carried over its neighbour: the keyboard's version of the drag. */
export function draggerMoveCommand(direction: -1 | 1, allowed: () => boolean): Command {
  return (view) => allowed() && moveBlockOver(view, view.state.doc.lineAt(view.state.selection.main.head).number, direction)
}

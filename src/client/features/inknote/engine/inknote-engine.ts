/**
 * The Inknote canvas engine (S1).
 *
 * The engine owns one mutable page object, the pointer state machine, the viewport, the off-screen
 * page raster and its own bounded content history. It never imports React or the store: the host
 * supplies page, paper, metrics, tool and font through callbacks and receives synchronous change
 * notifications. All pointer work stays inside pointer events and rAF; serialization happens only
 * when an edit starts or finishes.
 */
import { INKNOTE_LIMITS, INKNOTE_PAGE_HEIGHT, INKNOTE_PAGE_WIDTH, SHAPE_SNAP_SIZE } from '@shared/inknote/constants'
import { serializePageContent } from '@shared/inknote/parse'
import type {
  InknoteImage,
  InknotePageContent,
  InknotePaper,
  InknoteShapeKind,
  InknoteShapeTool,
  InknoteStroke,
  InknoteTextBox,
} from '@shared/inknote/types'
import {
  boundsOf,
  computeSelectionBox,
  fromContentPoint as contentToDisplayPoint,
  pointInPolygon,
  selectionBounds,
  toContentPoint as displayToContentPoint,
  type Bounds,
  type Point,
} from '../../../lib/inknote/geometry'
import {
  moveSelection as movePageSelection,
  pixelErase,
  scaleSelection as scalePageSelection,
  type ScaleCorner,
} from '../../../lib/inknote/document-ops'
import { paperLineStep } from '../../../lib/inknote/paper'
import { detectShape, snapToGrid } from '../../../lib/inknote/shape-recognition'
import { pressureFilter } from '../../../lib/inknote/stroke-math'
import { InknoteHistory } from './history'
import {
  drawShape,
  drawStroke,
  inknoteCanvasBudget,
  renderPage,
  renderPageToCanvas,
  RENDER_SCALE,
} from './renderer'
import type {
  InknoteEngine,
  InknoteEngineHost,
  InknotePageMetrics,
  InknoteToolState,
  InknoteViewport,
} from './inknote-engine-types'

const MIN_ZOOM = 0.15
const MAX_ZOOM = 4
const FIT_PADDING = 40
const MIN_SAMPLE_DISTANCE = 0.7
const FAST_STROKE_GAP = 12
const ERASER_SAMPLE_STEP = 8
const PIXEL_ERASE_SAMPLE_STEP = 6
const DEFAULT_ERASER_SIZE = 24
const LASSO_HANDLE_RADIUS = 16
const TWO_FINGER_TAP_MS = 320
const TWO_FINGER_TAP_MOVE = 12
const TWO_FINGER_TAP_GAP_MS = 180
const TWO_FINGER_TAP_DISTANCE = 40
const TWO_FINGER_SCROLL_THRESHOLD = 6
const PAGE_TURN_DISTANCE = 40
const PAGE_TURN_LOCK_MS = 400
const PINCH_RATIO_THRESHOLD = 0.03
const SHAPE_HOLD_MS = 250
const SHAPE_MIN_POINTS = 5
const AUTO_PAGE_RATIO = 0.94
const AUTO_PAGE_DELAY_MS = 200
const CLIPBOARD_OFFSET_RATIO = 0.02
const TEXT_TAP_TOLERANCE = 5
const MIN_SHAPE_DRAG = 4
const SHADOW_OFFSET_X = 6
const SHADOW_OFFSET_Y = 8
const SELECTION_FILL = 'rgba(37,99,235,.10)'
const SELECTION_STROKE = 'rgba(37,99,235,.80)'
const SELECTION_HANDLE = '#2563eb'
const LASSO_FILL = 'rgba(37,99,235,.10)'
const LASSO_STROKE = 'rgba(37,99,235,.75)'
const ERASER_PREVIEW_FILL = 'rgba(220,38,38,.15)'
const PIXEL_ERASER_PREVIEW_FILL = 'rgba(220,38,38,.14)'
const SHAPE_PREVIEW_ALPHA = 0.65
const SHADOW_FILL = 'rgba(0,0,0,.13)'

const RECT_LIKE_SHAPES: ReadonlySet<InknoteShapeKind> = new Set(['rect', 'square', 'circle', 'ellipse'])

const DEFAULT_PAPER: InknotePaper = { style: 'line', color: 'white', spacing: 'normal' }
const DEFAULT_TOOL: InknoteToolState = {
  tool: 'ballpen',
  color: '#1e293b',
  width: 5,
  style: 'normal',
  shape: 'line',
  eraserSize: DEFAULT_ERASER_SIZE,
  eraserMode: 'stroke',
}
const DEFAULT_METRICS: InknotePageMetrics = {
  width: INKNOTE_PAGE_WIDTH,
  height: INKNOTE_PAGE_HEIGHT,
  contentWidth: INKNOTE_PAGE_WIDTH,
  contentHeight: INKNOTE_PAGE_HEIGHT,
}

/**
 * Optional host additions that the frozen contract does not cover. The host may implement any of
 * them; the engine only calls them when present.
 */
export interface InknoteEngineHostExtras {
  /**
   * Scroll the page stack by a display-space delta. Used by one-finger touch and two-finger vertical
   * panning. Without it the engine pans its own viewport instead.
   */
  onScroll?: (dy: number, dx: number) => boolean | void
  /** Human-facing name i18n is the host's job; the engine only reports the recognized kind. */
  onShapeRecognized?: (kind: InknoteShapeKind) => void
  /** Optional behavioural settings that the frozen tool state does not carry. */
  getSettings?: () => {
    fingerDraw?: boolean
    autoPage?: boolean
    twoFingerAction?: 'undo' | 'redo' | 'off'
    threeFingerAction?: 'redo' | 'off'
  }
  /** Report an unavailable canvas instead of leaving the host with a blank surface. */
  onError?: (code: 'canvas-unavailable' | 'raster-unavailable') => void
}

export interface InknoteTextLayerItem {
  id: string
  text: string
  world: Bounds
  screen: Bounds
  fontSizePx: number
  color: string
}

/** Public surface consumed by the Inknote UI beyond the frozen contract. */
export interface InknoteEngineApi extends InknoteEngine {
  undo(): boolean
  redo(): boolean
  canUndo(): boolean
  canRedo(): boolean
  clearHistory(): void
  selectionBox(): Bounds | null
  getSelectionIds(): string[]
  selectAll(): void
  deleteSelection(): boolean
  copySelection(): boolean
  pasteSelection(): boolean
  rotateSelection(): boolean
  moveSelection(dx: number, dy: number): boolean
  scaleSelection(corner: ScaleCorner, point: Point): boolean
  getViewport(): InknoteViewport
  getScale(): number
  getMetrics(): InknotePageMetrics
  getPaper(): InknotePaper
  getTool(): InknoteToolState
  worldToScreen(x: number, y: number): Point
  screenToWorld(x: number, y: number): Point
  toContentPoint(point: Point): Point
  fromContentPoint<T extends Point>(point: T): T
  hitText(world: Point): InknoteTextBox | null
  textLayerItems(): InknoteTextLayerItem[]
  renderNow(): void
  renderThumbnail(page: InknotePageContent, width: number, paper?: InknotePaper, font?: string): HTMLCanvasElement | null
  isPlaybackLocked(): boolean
}

interface PointerRecord {
  id: number
  x: number
  y: number
  t: number
  pointerType: string
  /** Position when the current multi-finger gesture began. */
  gestureStart?: Point
}

interface GestureState {
  count: number
  tGap: number
  dist: number
  mid: Point
  startMid: Point
  scale: number
  offsetX: number
  offsetY: number
  startTime: number
  maxMove: number
  hadStroke: boolean
  turned: boolean
  lastScroll: Point
}

interface ClipboardPayload {
  strokes: InknoteStroke[]
  texts: InknoteTextBox[]
  images: InknoteImage[]
}

function newId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function pointInBox(point: Point, box: Bounds): boolean {
  return point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const denominator = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x)
  if (Math.abs(denominator) < 1e-9) return false
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / denominator
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / denominator
  return t >= 0 && t <= 1 && u >= 0 && u <= 1
}

function polygonIntersectsBox(path: readonly Point[], box: Bounds): boolean {
  for (const point of path) if (pointInBox(point, box)) return true
  const corners: readonly Point[] = [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ]
  // A lasso drawn around an object never crosses its edges; containment is a hit too.
  for (const corner of corners) if (pointInPolygon(corner, path)) return true
  for (let index = 0; index < corners.length; index++) {
    const a = corners[index]!
    const b = corners[(index + 1) % corners.length]!
    for (let step = 0; step < path.length; step++) {
      const start = path[step]!
      const end = path[(step + 1) % path.length]!
      if (segmentsIntersect(a, b, start, end)) return true
    }
  }
  return false
}

function sampleLine(from: Point, to: Point, step: number): Point[] {
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  const count = Math.max(1, Math.floor(distance / step))
  const points: Point[] = []
  for (let index = 0; index <= count; index++) {
    const ratio = index / count
    points.push({ x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio })
  }
  return points
}

function cloneStroke(stroke: InknoteStroke): InknoteStroke {
  return { ...stroke, points: stroke.points.map((point) => ({ ...point })) }
}

export class InknoteEngineImpl implements InknoteEngineApi {
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private host: (InknoteEngineHost & InknoteEngineHostExtras) | null = null
  private resizeObserver: ResizeObserver | null = null
  private raster: HTMLCanvasElement | null = null
  private rasterCtx: CanvasRenderingContext2D | null = null

  private page: InknotePageContent | null = null
  private paper: InknotePaper = DEFAULT_PAPER
  private metrics: InknotePageMetrics = DEFAULT_METRICS
  private tool: InknoteToolState = DEFAULT_TOOL
  private font = 'sans-serif'
  private viewport: InknoteViewport = { scale: 1, offsetX: 0, offsetY: 0 }
  private cw = 0
  private ch = 0
  private dpr = 1
  private fitted = false
  private mounted = false
  private destroyed = false
  private playbackLock = false
  private dirtyRaster = true
  private frame: number | null = null
  private viewportFrame: number | null = null

  private readonly pointers = new Map<number, PointerRecord>()
  private gesture: GestureState | null = null
  private pan: { pointerId: number; x: number; y: number } | null = null
  private touchScroll: { pointerId: number; x: number; y: number } | null = null
  private lastPageTurnAt = 0

  private activeStroke: InknoteStroke | null = null
  private activeLastDisplay: Point | null = null
  private lastSampleAt = 0
  private lastPressure = 1
  private lastPointerWorld: Point | null = null
  private dwellTimer: number | null = null
  private autoPageTimer: number | null = null
  private beforeSnapshot: string | null = null

  private curShape: { kind: InknoteShapeTool; start: Point; end: Point } | null = null
  private lassoPath: Point[] | null = null
  private eraseIds = new Set<string>()
  private erasePath: Point[] | null = null
  private erasePointer: Point | null = null
  private textTap: { startLocal: Point; world: Point; moved: boolean } | null = null

  private selected = new Set<string>()
  private selectionBoxCache: Bounds | null = null
  private selectionMove: { start: Point; last: Point; dx: number; dy: number } | null = null
  private selectionScale: { corner: ScaleCorner; box: Bounds } | null = null
  private clipboard: ClipboardPayload | null = null

  private readonly history = new InknoteHistory()

  private readonly onPointerDown = (event: PointerEvent): void => this.handlePointerDown(event)
  private readonly onPointerMove = (event: PointerEvent): void => this.handlePointerMove(event)
  private readonly onPointerUp = (event: PointerEvent): void => this.handlePointerUp(event)
  private readonly onPointerCancel = (event: PointerEvent): void => this.handlePointerUp(event, true)
  private readonly onWheel = (event: WheelEvent): void => this.handleWheel(event)
  private readonly onContextMenu = (event: MouseEvent): void => event.preventDefault()
  private readonly onWindowBlur = (): void => this.handleWindowBlur()
  private readonly onMediaReady = (): void => {
    if (!this.destroyed) this.invalidateRasterOnly()
  }

  mount(canvas: HTMLCanvasElement, host: InknoteEngineHost): void {
    if (this.mounted) throw new Error('Inknote engine is already mounted')
    const extras = host as InknoteEngineHost & InknoteEngineHostExtras
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      extras.onError?.('canvas-unavailable')
      throw new Error('Inknote engine requires a 2D canvas context')
    }
    const raster = document.createElement('canvas')
    const rasterCtx = raster.getContext('2d')
    if (!rasterCtx) {
      extras.onError?.('raster-unavailable')
      throw new Error('Inknote engine requires an off-screen 2D canvas context')
    }

    this.destroyed = false
    this.mounted = true
    this.fitted = false
    this.canvas = canvas
    this.ctx = ctx
    this.raster = raster
    this.rasterCtx = rasterCtx
    this.host = extras
    this.font = host.getFont()
    this.tool = host.getTool()
    this.paper = host.getPaper()
    const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio
    this.dpr = Math.min(2.5, Math.max(1, finite(ratio, 1)))
    canvas.style.touchAction = 'none'

    canvas.addEventListener('pointerdown', this.onPointerDown, { passive: false })
    canvas.addEventListener('pointermove', this.onPointerMove, { passive: false })
    canvas.addEventListener('pointerup', this.onPointerUp, { passive: false })
    canvas.addEventListener('pointercancel', this.onPointerCancel, { passive: false })
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('contextmenu', this.onContextMenu)
    window.addEventListener('blur', this.onWindowBlur)
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => this.resize())
      this.resizeObserver.observe(canvas)
    }
    this.resize()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    const canvas = this.canvas
    if (canvas) {
      canvas.removeEventListener('pointerdown', this.onPointerDown)
      canvas.removeEventListener('pointermove', this.onPointerMove)
      canvas.removeEventListener('pointerup', this.onPointerUp)
      canvas.removeEventListener('pointercancel', this.onPointerCancel)
      canvas.removeEventListener('wheel', this.onWheel)
      canvas.removeEventListener('contextmenu', this.onContextMenu)
    }
    window.removeEventListener('blur', this.onWindowBlur)
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    if (this.viewportFrame !== null) cancelAnimationFrame(this.viewportFrame)
    this.frame = null
    this.viewportFrame = null
    this.clearDwell()
    this.clearAutoPage()
    this.cancelInteraction()
    this.selected.clear()
    this.selectionBoxCache = null
    this.clipboard = null
    this.history.clear()
    this.canvas = null
    this.ctx = null
    this.host = null
    this.raster = null
    this.rasterCtx = null
    this.page = null
    this.mounted = false
  }

  setPage(page: InknotePageContent, paper: InknotePaper, metrics: InknotePageMetrics): void {
    if (this.destroyed) return
    if (this.selectionScale) this.finishSelectionScale()
    const previous = this.page
    const sizeChanged = !previous
      || metrics.width !== this.metrics.width
      || metrics.height !== this.metrics.height
      || metrics.contentWidth !== this.metrics.contentWidth
      || metrics.contentHeight !== this.metrics.contentHeight
    this.page = page
    this.paper = paper
    this.metrics = {
      width: metrics.width > 0 ? metrics.width : INKNOTE_PAGE_WIDTH,
      height: metrics.height > 0 ? metrics.height : INKNOTE_PAGE_HEIGHT,
      contentWidth: metrics.contentWidth > 0 ? metrics.contentWidth : (metrics.width > 0 ? metrics.width : INKNOTE_PAGE_WIDTH),
      contentHeight: metrics.contentHeight > 0 ? metrics.contentHeight : (metrics.height > 0 ? metrics.height : INKNOTE_PAGE_HEIGHT),
    }
    if (previous !== page) this.history.clear()
    this.cancelInteraction()
    this.clearSelection()
    this.clearAutoPage()
    this.dirtyRaster = true
    if (sizeChanged || !this.fitted) this.fitView()
    this.requestRender()
  }

  setTool(tool: InknoteToolState): void {
    const switched = this.tool.tool !== tool.tool || this.tool.eraserMode !== tool.eraserMode
    this.tool = { ...tool }
    if (switched) {
      if (this.selectionScale) this.finishSelectionScale()
      this.cancelInteraction()
      this.clearSelection()
      this.requestRender()
    }
  }

  setFont(font: string): void {
    this.font = font
    this.invalidate()
  }

  refreshPaper(): void {
    if (this.host) this.paper = this.host.getPaper()
    this.invalidate()
  }

  invalidate(): void {
    this.dirtyRaster = true
    if (this.selected.size) this.selectionBoxCache = null
    this.requestRender()
  }

  fitView(): void {
    const pad = FIT_PADDING
    const availableWidth = Math.max(1, this.cw - pad * 2)
    const availableHeight = Math.max(1, this.ch - pad * 2)
    const width = Math.max(1, this.metrics.width)
    const height = Math.max(1, this.metrics.height)
    const scale = clamp(Math.min(availableWidth / width, availableHeight / height), MIN_ZOOM, MAX_ZOOM)
    this.viewport = {
      scale,
      offsetX: (this.cw - width * scale) / 2,
      offsetY: (this.ch - height * scale) / 2,
    }
    this.fitted = true
    this.notifyViewport()
    this.requestRender()
  }

  /** Anchor a zoom at a client-space point, as the contract names it. */
  zoomAt(clientX: number, clientY: number, factor: number): void {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || !Number.isFinite(factor) || factor <= 0) return
    const local = this.clientToLocal(clientX, clientY)
    const world = this.screenToWorld(local.x, local.y)
    const next = clamp(this.viewport.scale * factor, MIN_ZOOM, MAX_ZOOM)
    if (next === this.viewport.scale) return
    this.viewport.scale = next
    this.viewport.offsetX = local.x - world.x * next
    this.viewport.offsetY = local.y - world.y * next
    this.notifyViewport()
    this.requestRender()
  }

  frameContent(): boolean {
    if (!this.page) return false
    const ids: string[] = []
    for (const stroke of this.page.strokes) ids.push(stroke.id)
    for (const text of this.page.texts) ids.push(`t:${text.id}`)
    for (const image of this.page.images) ids.push(`i:${image.id}`)
    const box = selectionBounds(this.page, ids, this.metrics)
    if (!box) return false
    const width = Math.max(1, box.w)
    const height = Math.max(1, box.h)
    const scale = clamp(
      Math.min(Math.max(1, this.cw - FIT_PADDING * 2) / width, Math.max(1, this.ch - FIT_PADDING * 2) / height),
      MIN_ZOOM,
      MAX_ZOOM,
    )
    this.viewport = {
      scale,
      offsetX: this.cw / 2 - (box.x + box.w / 2) * scale,
      offsetY: this.ch / 2 - (box.y + box.h / 2) * scale,
    }
    this.notifyViewport()
    this.requestRender()
    return true
  }

  selectionIds(): string[] {
    return [...this.selected]
  }

  getSelectionIds(): string[] {
    return this.selectionIds()
  }

  selectionBox(): Bounds | null {
    if (!this.selected.size) return null
    if (!this.selectionBoxCache) this.refreshSelectionBox()
    return this.selectionBoxCache ? { ...this.selectionBoxCache } : null
  }

  clearSelection(): void {
    const had = this.selected.size > 0
    this.selected.clear()
    this.selectionBoxCache = null
    this.selectionMove = null
    this.selectionScale = null
    this.host?.onSelectionChange([])
    if (had) this.requestRender()
  }

  applyContent(content: InknotePageContent): void {
    const page = this.page
    if (!page) {
      this.page = content
      this.invalidate()
      return
    }
    if (page === content) return
    page.strokes = content.strokes
    page.texts = content.texts
    page.images = content.images
    page.bg = content.bg
    this.history.clear()
    this.cancelInteraction()
    this.clearSelection()
    this.invalidate()
  }

  setPlaybackLock(locked: boolean): void {
    this.playbackLock = locked
    if (locked) {
      if (this.selectionScale) this.finishSelectionScale()
      this.cancelInteraction()
    }
    this.requestRender()
  }

  /** The engine has no replay buffers of its own; releasing the lock and pending gesture is enough. */
  destroyRecordingReplay(): void {
    this.playbackLock = false
    this.cancelInteraction()
    this.requestRender()
  }

  isPlaybackLocked(): boolean {
    return this.playbackLock
  }

  getViewport(): InknoteViewport {
    return { ...this.viewport }
  }

  getScale(): number {
    return this.viewport.scale
  }

  getMetrics(): InknotePageMetrics {
    return { ...this.metrics }
  }

  getPaper(): InknotePaper {
    return this.paper
  }

  getTool(): InknoteToolState {
    return this.host?.getTool() ?? this.tool
  }

  /** Page display units to canvas-local CSS pixels, for DOM overlays such as the text layer. */
  worldToScreen(x: number, y: number): Point {
    return { x: x * this.viewport.scale + this.viewport.offsetX, y: y * this.viewport.scale + this.viewport.offsetY }
  }

  /** Canvas-local CSS pixels back to page display units. */
  screenToWorld(x: number, y: number): Point {
    return { x: (x - this.viewport.offsetX) / this.viewport.scale, y: (y - this.viewport.offsetY) / this.viewport.scale }
  }

  toContentPoint(point: Point): Point {
    return displayToContentPoint(point, this.metrics)
  }

  fromContentPoint<T extends Point>(point: T): T {
    return contentToDisplayPoint(point, this.metrics)
  }

  hitText(world: Point): InknoteTextBox | null {
    const page = this.page
    if (!page) return null
    for (let index = page.texts.length - 1; index >= 0; index--) {
      const text = page.texts[index]!
      const box = this.normalizedBox(text)
      if (pointInBox(world, box)) return text
    }
    return null
  }

  textLayerItems(): InknoteTextLayerItem[] {
    const page = this.page
    if (!page) return []
    const width = this.metrics.width
    const height = this.metrics.height
    return page.texts.map((text) => {
      const world = { x: text.x * width, y: text.y * height, w: text.w * width, h: text.h * height }
      const topLeft = this.worldToScreen(world.x, world.y)
      const bottomRight = this.worldToScreen(world.x + world.w, world.y + world.h)
      return {
        id: text.id,
        text: text.text,
        world,
        screen: { x: topLeft.x, y: topLeft.y, w: bottomRight.x - topLeft.x, h: bottomRight.y - topLeft.y },
        fontSizePx: text.fontSize * this.viewport.scale,
        color: text.color,
      }
    })
  }

  renderThumbnail(
    page: InknotePageContent,
    width: number,
    paper: InknotePaper = this.paper,
    font: string = this.font,
  ): HTMLCanvasElement | null {
    return renderPageToCanvas(page, paper, this.metrics, width, font)
  }

  renderNow(): void {
    const canvas = this.canvas
    const ctx = this.ctx
    if (!canvas || !ctx) return
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.cw, this.ch)
    const page = this.page
    if (!page) return
    if (this.dirtyRaster) this.renderRaster()
    if (!this.page) return
    const width = this.metrics.width
    const height = this.metrics.height
    const { scale, offsetX, offsetY } = this.viewport
    ctx.setTransform(this.dpr * scale, 0, 0, this.dpr * scale, this.dpr * offsetX, this.dpr * offsetY)
    ctx.fillStyle = SHADOW_FILL
    ctx.fillRect(SHADOW_OFFSET_X, SHADOW_OFFSET_Y, width, height)
    if (this.raster) ctx.drawImage(this.raster, 0, 0, width, height)
    this.drawLiveInk(ctx)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }

  /* ------------------------------ history and selection ------------------------------ */

  undo(): boolean {
    if (this.playbackLock) return false
    const entry = this.history.undo()
    if (!entry) return false
    if (entry.page !== this.page) {
      this.history.clear()
      return false
    }
    this.applySnapshot(entry.before)
    this.afterHistoryApply()
    return true
  }

  redo(): boolean {
    if (this.playbackLock) return false
    const entry = this.history.redo()
    if (!entry) return false
    if (entry.page !== this.page) {
      this.history.clear()
      return false
    }
    this.applySnapshot(entry.after)
    this.afterHistoryApply()
    return true
  }

  canUndo(): boolean {
    return this.history.canUndo
  }

  canRedo(): boolean {
    return this.history.canRedo
  }

  clearHistory(): void {
    this.history.clear()
  }

  selectAll(): void {
    const page = this.page
    if (!page) return
    this.selected.clear()
    for (const stroke of page.strokes) this.selected.add(stroke.id)
    for (const text of page.texts) this.selected.add(`t:${text.id}`)
    for (const image of page.images) this.selected.add(`i:${image.id}`)
    this.refreshSelectionBox()
    this.notifySelection()
    this.requestRender()
  }

  deleteSelection(): boolean {
    const page = this.page
    if (!page || !this.selected.size || this.playbackLock) return false
    this.beginEdit()
    const ids = new Set(this.selected)
    page.strokes = page.strokes.filter((stroke) => !ids.has(stroke.id))
    page.texts = page.texts.filter((text) => !ids.has(`t:${text.id}`) && !ids.has(text.id))
    page.images = page.images.filter((image) => !ids.has(`i:${image.id}`) && !ids.has(image.id))
    this.selected.clear()
    this.selectionBoxCache = null
    this.selectionMove = null
    this.selectionScale = null
    const changed = this.commitEdit('delete', 'erase')
    this.notifySelection()
    this.requestRender()
    return changed
  }

  copySelection(): boolean {
    const page = this.page
    if (!page || !this.selected.size) return false
    const payload: ClipboardPayload = { strokes: [], texts: [], images: [] }
    for (const id of this.selected) {
      if (id.startsWith('t:')) {
        const text = page.texts.find((entry) => entry.id === id.slice(2))
        if (text) payload.texts.push({ ...text })
      } else if (id.startsWith('i:')) {
        const image = page.images.find((entry) => entry.id === id.slice(2))
        if (image) payload.images.push({ ...image })
      } else {
        const stroke = page.strokes.find((entry) => entry.id === id)
        if (stroke) payload.strokes.push(cloneStroke(stroke))
      }
    }
    const count = payload.strokes.length + payload.texts.length + payload.images.length
    if (count === 0) return false
    this.clipboard = payload
    return true
  }

  pasteSelection(): boolean {
    const page = this.page
    const payload = this.clipboard
    if (!page || !payload || this.playbackLock) return false
    this.beginEdit()
    const offsetX = this.metrics.width * CLIPBOARD_OFFSET_RATIO
    const offsetY = this.metrics.height * CLIPBOARD_OFFSET_RATIO
    const contentDx = offsetX * (this.metrics.contentWidth / Math.max(1, this.metrics.width))
    const contentDy = offsetY * (this.metrics.contentHeight / Math.max(1, this.metrics.height))
    const normalizedDx = offsetX / Math.max(1, this.metrics.width)
    const normalizedDy = offsetY / Math.max(1, this.metrics.height)
    const ids: string[] = []
    for (const stroke of payload.strokes) {
      const copy = cloneStroke(stroke)
      copy.id = newId()
      for (const point of copy.points) {
        point.x += contentDx
        point.y += contentDy
      }
      page.strokes.push(copy)
      ids.push(copy.id)
    }
    for (const text of payload.texts) {
      const copy = { ...text, id: newId(), x: text.x + normalizedDx, y: text.y + normalizedDy }
      page.texts.push(copy)
      ids.push(`t:${copy.id}`)
    }
    for (const image of payload.images) {
      const copy = { ...image, id: newId(), x: image.x + normalizedDx, y: image.y + normalizedDy }
      page.images.push(copy)
      ids.push(`i:${copy.id}`)
    }
    if (ids.length === 0) {
      this.discardEdit()
      return false
    }
    this.selected = new Set(ids)
    const changed = this.commitEdit('paste', 'stroke')
    this.refreshSelectionBox()
    this.notifySelection()
    this.requestRender()
    return changed
  }

  rotateSelection(): boolean {
    const page = this.page
    if (!page || !this.selected.size || this.playbackLock) return false
    const images = page.images.filter((image) => this.selected.has(`i:${image.id}`) || this.selected.has(image.id))
    if (!images.length) return false
    this.beginEdit()
    for (const image of images) {
      image.rot = ((image.rot + 90) % 360) as InknoteImage['rot']
    }
    const changed = this.commitEdit('rotate', 'move')
    this.refreshSelectionBox()
    this.notifySelection()
    this.requestRender()
    return changed
  }

  moveSelection(dx: number, dy: number): boolean {
    const page = this.page
    if (!page || !this.selected.size || this.playbackLock || !Number.isFinite(dx) || !Number.isFinite(dy)) return false
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return false
    this.beginEdit()
    movePageSelection(page, [...this.selected], dx, dy, this.metrics)
    const changed = this.commitEdit('move', 'move')
    this.refreshSelectionBox()
    this.notifySelection()
    this.requestRender()
    return changed
  }

  scaleSelection(corner: ScaleCorner, point: Point): boolean {
    const page = this.page
    const box = this.selectionBox()
    if (!page || !box || !this.selected.size || this.playbackLock || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false
    this.beginEdit()
    this.selectionBoxCache = scalePageSelection(page, [...this.selected], box, corner, point, this.metrics)
    const changed = this.commitEdit('scale', 'scale')
    this.refreshSelectionBox()
    this.notifySelection()
    this.requestRender()
    return changed
  }

  /* ------------------------------ input ------------------------------ */

  private handlePointerDown(event: PointerEvent): void {
    const canvas = this.canvas
    if (!canvas || this.destroyed) return
    event.preventDefault()
    if (this.playbackLock) return
    if (this.pointers.size >= 3) return
    this.clearAutoPage()
    if (typeof canvas.setPointerCapture === 'function') canvas.setPointerCapture(event.pointerId)
    const local = this.local(event)
    this.pointers.set(event.pointerId, {
      id: event.pointerId,
      x: local.x,
      y: local.y,
      t: Date.now(),
      pointerType: event.pointerType,
    })
    if (this.pointers.size >= 2) {
      this.beginGesture()
      return
    }
    if (event.pointerType === 'mouse' && (event.button === 1 || event.button === 2)) {
      this.pan = { pointerId: event.pointerId, x: local.x, y: local.y }
      return
    }
    if (event.pointerType === 'touch' && !this.fingerDraw()) {
      this.touchScroll = { pointerId: event.pointerId, x: local.x, y: local.y }
      return
    }

    const world = this.screenToWorld(local.x, local.y)
    this.lastPointerWorld = world
    const tool = this.getTool()
    switch (tool.tool) {
      case 'pen':
      case 'ballpen':
      case 'highlighter': {
        const snapped = this.snapWorld(world, tool.tool)
        const content = this.toContentPoint(snapped)
        this.lastPressure = this.pressure(event)
        this.activeStroke = {
          id: newId(),
          tool: tool.tool,
          style: tool.tool === 'highlighter' ? 'normal' : tool.style,
          shape: null,
          color: tool.color,
          width: this.toContentWidth(tool.width),
          points: [{ ...content, p: this.lastPressure }],
        }
        this.activeLastDisplay = snapped
        this.lastSampleAt = Date.now()
        break
      }
      case 'eraser':
      case 'pixelEraser': {
        this.eraseIds = new Set()
        this.erasePath = tool.tool === 'pixelEraser' || tool.eraserMode === 'pixel' ? [world] : null
        this.erasePointer = world
        if (tool.tool === 'eraser' && tool.eraserMode !== 'pixel') this.hitErase(world)
        break
      }
      case 'lasso': {
        if (this.selected.size) {
          const handle = this.hitHandle(world)
          const box = this.selectionBox()
          if (handle && box) {
            // Scaling mutates the page during the drag; the one unavoidable snapshot is taken here.
            this.beginEdit()
            this.selectionScale = { corner: handle, box }
            break
          }
          if (box && pointInBox(world, box)) {
            this.selectionMove = { start: world, last: world, dx: 0, dy: 0 }
            break
          }
        }
        this.lassoPath = [world]
        break
      }
      case 'text': {
        this.textTap = { startLocal: local, world, moved: false }
        break
      }
      case 'shape': {
        this.curShape = { kind: tool.shape, start: world, end: world }
        break
      }
      default:
        break
    }
    this.requestRender()
  }

  private handlePointerMove(event: PointerEvent): void {
    const pointer = this.pointers.get(event.pointerId)
    if (!pointer) return
    event.preventDefault()
    const local = this.local(event)
    const previous = { x: pointer.x, y: pointer.y }
    pointer.x = local.x
    pointer.y = local.y

    if (this.pointers.size >= 2) {
      this.updateGesture()
      return
    }
    if (this.gesture) {
      this.trackGestureMove(pointer)
      return
    }
    if (this.pan && this.pan.pointerId === event.pointerId) {
      this.viewport.offsetX += local.x - previous.x
      this.viewport.offsetY += local.y - previous.y
      this.pan.x = local.x
      this.pan.y = local.y
      this.requestRender()
      return
    }
    if (this.touchScroll && this.touchScroll.pointerId === event.pointerId) {
      const dy = local.y - previous.y
      const dx = local.x - previous.x
      this.touchScroll.x = local.x
      this.touchScroll.y = local.y
      this.scrollHost(dy, dx)
      return
    }

    const world = this.screenToWorld(local.x, local.y)
    this.lastPointerWorld = world
    const tool = this.getTool()
    if (this.activeStroke) {
      this.lastPressure = this.pressure(event)
      this.appendStrokeSample(world, this.lastPressure, false)
      this.requestRender()
      return
    }
    if (tool.tool === 'eraser' || tool.tool === 'pixelEraser') {
      if (tool.tool === 'eraser' && tool.eraserMode !== 'pixel') this.hitErase(world)
      else this.recordErasePath(world)
      this.requestRender()
      return
    }
    if (tool.tool === 'lasso') {
      if (this.lassoPath) {
        const last = this.lassoPath[this.lassoPath.length - 1]!
        if (Math.hypot(world.x - last.x, world.y - last.y) >= MIN_SAMPLE_DISTANCE) this.lassoPath.push(world)
      } else if (this.selectionMove) {
        this.selectionMove.last = world
        this.selectionMove.dx = world.x - this.selectionMove.start.x
        this.selectionMove.dy = world.y - this.selectionMove.start.y
      } else if (this.selectionScale) {
        this.selectionBoxCache = scalePageSelection(
          this.page!,
          [...this.selected],
          this.selectionScale.box,
          this.selectionScale.corner,
          world,
          this.metrics,
        )
        this.selectionScale.box = this.selectionBoxCache
      }
      this.requestRender()
      return
    }
    if (tool.tool === 'text' && this.textTap) {
      const dx = local.x - this.textTap.startLocal.x
      const dy = local.y - this.textTap.startLocal.y
      if (Math.hypot(dx, dy) > TEXT_TAP_TOLERANCE) this.textTap.moved = true
      return
    }
    if (tool.tool === 'shape' && this.curShape) {
      this.curShape.end = world
      this.requestRender()
    }
  }

  private handlePointerUp(event: PointerEvent, cancelled = false): void {
    const pointer = this.pointers.get(event.pointerId)
    if (!pointer) return
    event.preventDefault()
    this.clearDwell()
    const local = this.local(event)
    const world = this.screenToWorld(local.x, local.y)
    this.lastPointerWorld = world
    this.pointers.delete(event.pointerId)

    if (this.pointers.size >= 2) {
      this.updateGesture()
      return
    }
    if (this.gesture) {
      if (this.pointers.size === 0) {
        const gesture = this.gesture
        this.gesture = null
        if (!cancelled) this.evaluateTap(gesture)
      }
      return
    }
    if (this.pan && this.pan.pointerId === event.pointerId) {
      this.pan = null
      this.requestRender()
      return
    }
    if (this.touchScroll && this.touchScroll.pointerId === event.pointerId) {
      this.touchScroll = null
      return
    }

    const tool = this.getTool()
    if (this.activeStroke) {
      this.finishActiveStroke(world, Math.max(0, Date.now() - this.lastSampleAt), cancelled, this.pressure(event))
    } else if (tool.tool === 'eraser' || tool.tool === 'pixelEraser') {
      this.finishErase(tool, cancelled)
    } else if (tool.tool === 'lasso') {
      this.finishLassoGesture(cancelled)
    } else if (tool.tool === 'text') {
      const tap = this.textTap
      this.textTap = null
      if (tap && !tap.moved && !cancelled) this.host?.onTextTap(tap.world)
    } else if (tool.tool === 'shape') {
      this.finishShape(cancelled)
    }
    this.textTap = null
    this.requestRender()
  }

  private handleWheel(event: WheelEvent): void {
    if (!this.canvas) return
    event.preventDefault()
    if (event.ctrlKey || event.metaKey) {
      this.zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.002))
    } else if (event.shiftKey && event.deltaX === 0) {
      this.viewport.offsetX -= event.deltaY
      this.requestRender()
    } else {
      this.viewport.offsetX -= event.deltaX
      this.viewport.offsetY -= event.deltaY
      this.requestRender()
    }
  }

  private evaluateTap(gesture: GestureState): void {
    const elapsed = Date.now() - gesture.startTime
    const tap = elapsed < TWO_FINGER_TAP_MS
      && gesture.maxMove < TWO_FINGER_TAP_MOVE
      && gesture.tGap < TWO_FINGER_TAP_GAP_MS
      && gesture.dist > TWO_FINGER_TAP_DISTANCE
      && !gesture.hadStroke
    if (!tap) return
    const settings = this.host?.getSettings?.()
    if (gesture.count >= 3) {
      if (settings?.threeFingerAction !== 'off') this.host?.onGesture('redo')
      return
    }
    if (gesture.count !== 2) return
    const action = settings?.twoFingerAction ?? 'undo'
    if (action === 'off') return
    this.host?.onGesture(action)
  }

  private beginGesture(): void {
    const pointers = [...this.pointers.values()]
    const first = pointers[0]
    const second = pointers[1]
    if (!first || !second) return
    const now = Date.now()
    const mid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
    for (const pointer of pointers) pointer.gestureStart = { x: pointer.x, y: pointer.y }
    this.gesture = {
      count: pointers.length,
      tGap: Math.abs(first.t - second.t),
      dist: Math.hypot(first.x - second.x, first.y - second.y),
      mid,
      startMid: { ...mid },
      scale: this.viewport.scale,
      offsetX: this.viewport.offsetX,
      offsetY: this.viewport.offsetY,
      startTime: now,
      maxMove: 0,
      hadStroke: this.activeStroke !== null,
      turned: false,
      lastScroll: { ...mid },
    }
    this.activeStroke = null
    this.activeLastDisplay = null
    this.lassoPath = null
    this.curShape = null
    this.textTap = null
    this.eraseIds.clear()
    this.erasePath = null
    this.erasePointer = null
    this.selectionMove = null
    // A scale gesture mutates the page on every move; commit it before a second finger turns the
    // interaction into a pinch so the partial transform is not silently lost.
    if (this.selectionScale) this.finishSelectionScale()
    else this.selectionScale = null
    this.pan = null
    this.touchScroll = null
    this.beforeSnapshot = null
    this.clearDwell()
    this.requestRender()
  }

  private trackGestureMove(pointer: PointerRecord): void {
    const gesture = this.gesture
    if (!gesture || !pointer.gestureStart) return
    gesture.maxMove = Math.max(
      gesture.maxMove,
      Math.hypot(pointer.x - pointer.gestureStart.x, pointer.y - pointer.gestureStart.y),
    )
  }

  private updateGesture(): void {
    const gesture = this.gesture
    if (!gesture) return
    const pointers = [...this.pointers.values()].slice(0, 2)
    const first = pointers[0]
    const second = pointers[1]
    if (!first || !second) return
    for (const pointer of pointers) this.trackGestureMove(pointer)
    const distance = Math.hypot(first.x - second.x, first.y - second.y)
    const mid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
    const ratio = gesture.dist > 0 ? distance / gesture.dist : 1

    if (Math.abs(ratio - 1) > PINCH_RATIO_THRESHOLD) {
      const nextScale = clamp(gesture.scale * ratio, MIN_ZOOM, MAX_ZOOM)
      const anchorX = (gesture.mid.x - gesture.offsetX) / gesture.scale
      const anchorY = (gesture.mid.y - gesture.offsetY) / gesture.scale
      const scaleChanged = nextScale !== this.viewport.scale
      this.viewport.scale = nextScale
      this.viewport.offsetX = mid.x - anchorX * nextScale
      this.viewport.offsetY = mid.y - anchorY * nextScale
      if (scaleChanged) this.notifyViewport()
      this.requestRender()
      return
    }

    const dx = mid.x - gesture.startMid.x
    const dy = mid.y - gesture.startMid.y
    if (gesture.maxMove <= TWO_FINGER_SCROLL_THRESHOLD || gesture.turned) {
      this.requestRender()
      return
    }
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > PAGE_TURN_DISTANCE) {
      const now = Date.now()
      if (now - this.lastPageTurnAt >= PAGE_TURN_LOCK_MS) {
        this.lastPageTurnAt = now
        this.host?.onGesture(dx < 0 ? 'page-next' : 'page-prev')
      }
      gesture.turned = true
      this.requestRender()
      return
    }
    const scrollDy = mid.y - gesture.lastScroll.y
    const scrollDx = mid.x - gesture.lastScroll.x
    if (Math.abs(scrollDy) + Math.abs(scrollDx) > 0.5) {
      this.scrollHost(scrollDy, scrollDx)
      gesture.lastScroll = { ...mid }
    }
    this.requestRender()
  }

  private scrollHost(dy: number, dx: number): void {
    const onScroll = this.host?.onScroll
    if (onScroll) {
      onScroll(dy, dx)
      return
    }
    this.viewport.offsetY += dy
    this.viewport.offsetX += dx
    this.requestRender()
  }

  private handleWindowBlur(): void {
    if (this.activeStroke) {
      this.finishActiveStroke(this.lastPointerWorld, Math.max(0, Date.now() - this.lastSampleAt), false, this.lastPressure)
    }
    if (this.selectionScale) this.finishSelectionScale()
    if (this.selectionMove) {
      this.selectionMove = null
      this.beforeSnapshot = null
      this.refreshSelectionBox()
    }
    this.pointers.clear()
    this.gesture = null
    this.pan = null
    this.touchScroll = null
    this.textTap = null
    this.curShape = null
    this.lassoPath = null
    this.eraseIds.clear()
    this.erasePath = null
    this.erasePointer = null
    this.beforeSnapshot = null
    this.clearAutoPage()
    this.requestRender()
  }

  /* ------------------------------ strokes, erasing and shapes ------------------------------ */

  private finishActiveStroke(world: Point | null, holdMs: number, cancelled: boolean, pressure: number): void {
    const stroke = this.activeStroke
    if (!stroke) return
    if (world) this.appendStrokeSample(world, pressure, true)
    this.activeStroke = null
    this.activeLastDisplay = null
    this.clearDwell()
    if (!stroke.points.length) {
      this.discardEdit()
      return
    }
    const page = this.page
    if (!page) {
      this.discardEdit()
      return
    }
    const recognized = !cancelled && holdMs >= SHAPE_HOLD_MS ? this.recognizeStroke(stroke) : null
    this.beginEdit()
    if (recognized) {
      page.strokes.push(recognized)
      this.commitEdit('shape', 'shape')
      this.reportShape(recognized.shape)
      this.maybeAutoPage(recognized)
      return
    }
    page.strokes.push(stroke)
    this.commitEdit('stroke', 'stroke')
    this.maybeAutoPage(stroke)
  }

  private appendStrokeSample(world: Point, rawPressure: number, final: boolean): boolean {
    const stroke = this.activeStroke
    if (!stroke || !stroke.points.length) return false
    if (stroke.points.length >= INKNOTE_LIMITS.pointsPerStroke) return false
    const snapped = this.snapWorld(world, stroke.tool)
    const lastPoint = stroke.points[stroke.points.length - 1]!
    const lastDisplay = this.activeLastDisplay ?? contentToDisplayPoint(lastPoint, this.metrics)
    const gap = Math.hypot(snapped.x - lastDisplay.x, snapped.y - lastDisplay.y)
    if (gap < MIN_SAMPLE_DISTANCE) return false
    const filtered = pressureFilter(rawPressure, lastPoint.p ?? 1)
    const content = this.toContentPoint(snapped)
    if (gap > FAST_STROKE_GAP) {
      const steps = Math.max(2, Math.floor(gap / 4))
      for (let step = 1; step <= steps; step++) {
        if (stroke.points.length >= INKNOTE_LIMITS.pointsPerStroke) break
        const ratio = step / steps
        stroke.points.push({
          x: lastPoint.x + (content.x - lastPoint.x) * ratio,
          y: lastPoint.y + (content.y - lastPoint.y) * ratio,
          p: filtered,
        })
      }
    } else {
      stroke.points.push({ ...content, p: filtered })
    }
    this.activeLastDisplay = snapped
    this.lastSampleAt = Date.now()
    if (!final) this.armDwell()
    return true
  }

  private armDwell(): void {
    this.clearDwell()
    const stroke = this.activeStroke
    if (!stroke || (stroke.tool !== 'pen' && stroke.tool !== 'ballpen')) return
    this.dwellTimer = window.setTimeout(() => {
      this.dwellTimer = null
      this.handleDwell()
    }, SHAPE_HOLD_MS)
  }

  private clearDwell(): void {
    if (this.dwellTimer !== null) window.clearTimeout(this.dwellTimer)
    this.dwellTimer = null
  }

  private handleDwell(): void {
    const stroke = this.activeStroke
    if (!stroke) return
    const recognized = this.recognizeStroke(stroke)
    if (!recognized) return
    this.activeStroke = null
    this.activeLastDisplay = null
    const page = this.page
    if (!page) return
    this.beginEdit()
    page.strokes.push(recognized)
    this.commitEdit('shape', 'shape')
    this.reportShape(recognized.shape)
    this.maybeAutoPage(recognized)
    this.requestRender()
  }

  private recognizeStroke(stroke: InknoteStroke): InknoteStroke | null {
    if (stroke.tool !== 'pen' && stroke.tool !== 'ballpen') return null
    if (stroke.points.length < SHAPE_MIN_POINTS) return null
    const display = stroke.points.map((point) => contentToDisplayPoint(point, this.metrics))
    const detected = detectShape(display)
    if (!detected) return null
    const detectedPoints = RECT_LIKE_SHAPES.has(detected.kind)
      ? snapToGrid(detected.points, SHAPE_SNAP_SIZE)
      : detected.points
    return {
      id: stroke.id,
      tool: 'pen',
      style: 'normal',
      shape: detected.kind,
      color: stroke.color,
      width: stroke.width,
      points: detectedPoints.map((point) => ({ ...this.toContentPoint(point), p: 1 })),
    }
  }

  private reportShape(kind: InknoteShapeKind | null): void {
    if (kind) this.host?.onShapeRecognized?.(kind)
  }

  private finishShape(cancelled: boolean): void {
    const shape = this.curShape
    this.curShape = null
    if (!shape || cancelled) return
    if (Math.hypot(shape.end.x - shape.start.x, shape.end.y - shape.start.y) <= MIN_SHAPE_DRAG) return
    const page = this.page
    if (!page) return
    const tool = this.getTool()
    this.beginEdit()
    page.strokes.push({
      id: newId(),
      tool: 'pen',
      style: 'normal',
      shape: shape.kind,
      color: tool.color,
      width: this.toContentWidth(tool.width),
      points: [
        { ...this.toContentPoint(shape.start), p: 1 },
        { ...this.toContentPoint(shape.end), p: 1 },
      ],
    })
    this.commitEdit('shape', 'shape')
  }

  private recordErasePath(world: Point): void {
    if (!this.erasePath) this.erasePath = []
    const tail = this.erasePath[this.erasePath.length - 1]
    if (!tail || Math.hypot(world.x - tail.x, world.y - tail.y) >= PIXEL_ERASE_SAMPLE_STEP) this.erasePath.push(world)
  }

  private hitErase(world: Point): void {
    const page = this.page
    if (!page) return
    const tool = this.getTool()
    const radius = Math.max(1, tool.eraserSize || DEFAULT_ERASER_SIZE)
    const last = this.erasePointer ?? world
    const samples = Math.hypot(world.x - last.x, world.y - last.y) > ERASER_SAMPLE_STEP
      ? sampleLine(last, world, ERASER_SAMPLE_STEP)
      : [world]
    const contentSamples = samples.map((point) => this.toContentPoint(point))
    const contentRadius = radius * (this.metrics.contentWidth / Math.max(1, this.metrics.width))
    this.erasePointer = world

    for (const stroke of page.strokes) {
      if (this.eraseIds.has(stroke.id)) continue
      if (stroke.shape) {
        const box = this.shapeBox(stroke)
        if (!box) continue
        const width = stroke.width * (this.metrics.width / Math.max(1, this.metrics.contentWidth))
        for (const point of samples) {
          const nearestX = clamp(point.x, box.x, box.x + box.w)
          const nearestY = clamp(point.y, box.y, box.y + box.h)
          if (Math.hypot(point.x - nearestX, point.y - nearestY) <= radius + width) {
            this.eraseIds.add(stroke.id)
            break
          }
        }
        continue
      }
      let hit = false
      for (const sample of contentSamples) {
        let previous = stroke.points[0]
        if (!previous) continue
        if (Math.hypot(sample.x - previous.x, sample.y - previous.y) <= contentRadius + stroke.width / 2) {
          hit = true
          break
        }
        for (let index = 1; index < stroke.points.length; index++) {
          const current = stroke.points[index]!
          const nearest = nearestPointOnSegment(sample, previous, current)
          if (Math.hypot(sample.x - nearest.x, sample.y - nearest.y) <= contentRadius + stroke.width / 2) {
            hit = true
            break
          }
          previous = current
        }
        if (hit) break
      }
      if (hit) this.eraseIds.add(stroke.id)
    }
  }

  private finishErase(tool: InknoteToolState, cancelled: boolean): void {
    const page = this.page
    const pixelMode = tool.tool === 'pixelEraser' || tool.eraserMode === 'pixel'
    const path = this.erasePath
    const ids = [...this.eraseIds]
    this.erasePath = null
    this.erasePointer = null
    this.eraseIds.clear()
    if (!page || cancelled) {
      this.discardEdit()
      return
    }
    if (pixelMode) {
      if (!path || path.length < 2) {
        this.discardEdit()
        return
      }
      const contentPath = path.map((point) => this.toContentPoint(point))
      const radius = Math.max(1, tool.eraserSize || DEFAULT_ERASER_SIZE)
        * (this.metrics.contentWidth / Math.max(1, this.metrics.width))
      const next = pixelErase({ strokes: page.strokes }, contentPath, radius, newId)
      if (!next) {
        this.discardEdit()
        return
      }
      this.beginEdit()
      page.strokes = next
      this.commitEdit('pixel-erase', 'pixel-erase')
      return
    }
    if (!ids.length) {
      this.discardEdit()
      return
    }
    const erased = new Set(ids)
    this.beginEdit()
    page.strokes = page.strokes.filter((stroke) => !erased.has(stroke.id))
    this.commitEdit('erase', 'erase')
  }

  /* ------------------------------ lasso and selection ------------------------------ */

  private finishLassoGesture(cancelled: boolean): void {
    if (this.lassoPath) {
      const path = this.lassoPath
      this.lassoPath = null
      if (!cancelled && path.length >= 3) this.finishLasso(path)
      return
    }
    if (this.selectionMove) {
      this.finishSelectionMove()
      return
    }
    if (this.selectionScale) this.finishSelectionScale()
  }

  private finishLasso(path: Point[]): void {
    const page = this.page
    if (!page) return
    const contentPath = path.map((point) => this.toContentPoint(point))
    const ids: string[] = []
    for (const stroke of page.strokes) {
      if (stroke.shape) {
        const box = this.shapeBox(stroke)
        if (box && polygonIntersectsBox(path, box)) ids.push(stroke.id)
      } else {
        for (const point of stroke.points) {
          if (pointInPolygon(point, contentPath)) {
            ids.push(stroke.id)
            break
          }
        }
      }
    }
    for (const text of page.texts) {
      if (polygonIntersectsBox(path, this.normalizedBox(text))) ids.push(`t:${text.id}`)
    }
    for (const image of page.images) {
      if (polygonIntersectsBox(path, this.normalizedBox(image))) ids.push(`i:${image.id}`)
    }
    this.selected = new Set(ids)
    this.refreshSelectionBox()
    this.notifySelection()
    this.requestRender()
  }

  private finishSelectionMove(): void {
    const move = this.selectionMove
    const page = this.page
    this.selectionMove = null
    if (!move || !page) {
      this.discardEdit()
      return
    }
    if (Math.abs(move.dx) < 0.5 && Math.abs(move.dy) < 0.5) {
      this.discardEdit()
      this.requestRender()
      return
    }
    this.beginEdit()
    movePageSelection(page, [...this.selected], move.dx, move.dy, this.metrics)
    this.commitEdit('move', 'move')
    this.refreshSelectionBox()
    this.notifySelection()
    this.requestRender()
  }

  private finishSelectionScale(): void {
    const scale = this.selectionScale
    this.selectionScale = null
    if (!scale) {
      this.discardEdit()
      return
    }
    this.refreshSelectionBox()
    this.commitEdit('scale', 'scale')
    this.notifySelection()
    this.requestRender()
  }

  private hitHandle(world: Point): ScaleCorner | null {
    const box = this.selectionBox()
    if (!box) return null
    const corners: Array<[ScaleCorner, Point]> = [
      ['nw', { x: box.x, y: box.y }],
      ['ne', { x: box.x + box.w, y: box.y }],
      ['sw', { x: box.x, y: box.y + box.h }],
      ['se', { x: box.x + box.w, y: box.y + box.h }],
    ]
    for (const [corner, point] of corners) {
      if (Math.hypot(world.x - point.x, world.y - point.y) <= LASSO_HANDLE_RADIUS) return corner
    }
    return null
  }

  private refreshSelectionBox(): Bounds | null {
    if (!this.page || !this.selected.size) {
      this.selectionBoxCache = null
      return null
    }
    this.selectionBoxCache = computeSelectionBox(selectionBounds(this.page, [...this.selected], this.metrics))
    return this.selectionBoxCache
  }

  private notifySelection(): void {
    this.host?.onSelectionChange([...this.selected])
  }

  private normalizedBox(item: { x: number; y: number; w: number; h: number }): Bounds {
    return {
      x: item.x * this.metrics.width,
      y: item.y * this.metrics.height,
      w: item.w * this.metrics.width,
      h: item.h * this.metrics.height,
    }
  }

  private shapeBox(stroke: InknoteStroke): Bounds | null {
    if (!stroke.points.length) return null
    const display = stroke.points.map((point) => contentToDisplayPoint(point, this.metrics))
    return boundsOf(display)
  }

  /* ------------------------------ commits and history ------------------------------ */

  private beginEdit(): void {
    if (!this.page) return
    this.beforeSnapshot = serializePageContent(this.page)
  }

  private discardEdit(): void {
    this.beforeSnapshot = null
  }

  private commitEdit(label: string, reason: 'stroke' | 'erase' | 'pixel-erase' | 'shape' | 'move' | 'scale' | 'text'): boolean {
    const page = this.page
    const before = this.beforeSnapshot
    this.beforeSnapshot = null
    if (!page || before === null) {
      this.requestRender()
      return false
    }
    const after = serializePageContent(page)
    if (before === after) {
      this.requestRender()
      return false
    }
    this.history.push({ before, after, label, page })
    this.host?.onCommit(before, after, label)
    this.host?.onContentChange(reason)
    this.invalidate()
    return true
  }

  private applySnapshot(snapshot: string): void {
    const page = this.page
    if (!page) return
    let parsed: InknotePageContent
    try {
      parsed = JSON.parse(snapshot) as InknotePageContent
    } catch (error) {
      throw new Error('Inknote history snapshot is not valid JSON', { cause: error })
    }
    page.strokes = parsed.strokes
    page.texts = parsed.texts
    page.images = parsed.images
    page.bg = parsed.bg
  }

  private afterHistoryApply(): void {
    this.cancelInteraction()
    this.clearAutoPage()
    this.selected.clear()
    this.selectionBoxCache = null
    this.host?.onSelectionChange([])
    this.invalidate()
    this.host?.onContentChange('stroke')
  }

  private maybeAutoPage(stroke: InknoteStroke): void {
    if (!this.host) return
    const settings = this.host.getSettings?.()
    if (settings?.autoPage === false) return
    if (!stroke.points.length) return
    let maxY = 0
    for (const point of stroke.points) {
      const display = contentToDisplayPoint(point, this.metrics)
      if (display.y > maxY) maxY = display.y
    }
    if (maxY < this.metrics.height * AUTO_PAGE_RATIO) return
    this.clearAutoPage()
    this.autoPageTimer = window.setTimeout(() => {
      this.autoPageTimer = null
      if (!this.destroyed) this.host?.onAutoPage()
    }, AUTO_PAGE_DELAY_MS)
  }

  private clearAutoPage(): void {
    if (this.autoPageTimer !== null) window.clearTimeout(this.autoPageTimer)
    this.autoPageTimer = null
  }

  private cancelInteraction(): void {
    this.activeStroke = null
    this.activeLastDisplay = null
    this.curShape = null
    this.lassoPath = null
    this.eraseIds.clear()
    this.erasePath = null
    this.erasePointer = null
    this.textTap = null
    this.selectionMove = null
    this.selectionScale = null
    this.gesture = null
    this.pan = null
    this.touchScroll = null
    this.pointers.clear()
    this.clearDwell()
    this.clearAutoPage()
    this.beforeSnapshot = null
  }

  /* ------------------------------ rendering ------------------------------ */

  private renderRaster(): void {
    const raster = this.raster
    const ctx = this.rasterCtx
    const page = this.page
    if (!raster || !ctx || !page) return
    const budget = inknoteCanvasBudget(this.metrics.width, this.metrics.height, RENDER_SCALE)
    raster.width = budget.width
    raster.height = budget.height
    ctx.setTransform(budget.scale, 0, 0, budget.scale, 0, 0)
    renderPage(ctx, page, this.paper, this.metrics, { font: this.font, onMediaReady: this.onMediaReady })
    this.dirtyRaster = false
  }

  private drawLiveInk(ctx: CanvasRenderingContext2D): void {
    const page = this.page
    if (!page) return
    if (this.activeStroke) drawStroke(ctx, this.activeStroke, this.metrics, this.paper)
    if (this.curShape) {
      const tool = this.getTool()
      ctx.save()
      ctx.globalAlpha = SHAPE_PREVIEW_ALPHA
      drawShape(ctx, this.curShape.kind, [this.curShape.start, this.curShape.end], tool.color, Math.max(1, tool.width))
      ctx.restore()
    }
    if (this.eraseIds.size) {
      ctx.save()
      ctx.fillStyle = ERASER_PREVIEW_FILL
      for (const id of this.eraseIds) {
        const stroke = page.strokes.find((entry) => entry.id === id)
        if (!stroke) continue
        const box = stroke.shape ? this.shapeBox(stroke) : this.strokeBox(stroke)
        if (box) ctx.fillRect(box.x, box.y, box.w, box.h)
      }
      ctx.restore()
    }
    if (this.erasePath && this.erasePath.length) {
      const radius = Math.max(1, this.getTool().eraserSize || DEFAULT_ERASER_SIZE)
      ctx.save()
      ctx.fillStyle = PIXEL_ERASER_PREVIEW_FILL
      ctx.beginPath()
      for (const point of this.erasePath) {
        ctx.moveTo(point.x + radius, point.y)
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
      }
      ctx.fill()
      ctx.restore()
    }
    if (this.lassoPath && this.lassoPath.length) {
      ctx.save()
      ctx.fillStyle = LASSO_FILL
      ctx.strokeStyle = LASSO_STROKE
      ctx.lineWidth = 1.6
      ctx.setLineDash([6, 5])
      ctx.beginPath()
      ctx.moveTo(this.lassoPath[0]!.x, this.lassoPath[0]!.y)
      for (let index = 1; index < this.lassoPath.length; index++) {
        ctx.lineTo(this.lassoPath[index]!.x, this.lassoPath[index]!.y)
      }
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      ctx.restore()
    }
    this.drawSelection(ctx)
  }

  private drawSelection(ctx: CanvasRenderingContext2D): void {
    const box = this.selectionBox()
    if (!box || !this.selected.size) return
    let x = box.x
    let y = box.y
    if (this.selectionMove) {
      x += this.selectionMove.dx
      y += this.selectionMove.dy
    }
    ctx.save()
    ctx.fillStyle = SELECTION_FILL
    ctx.fillRect(x, y, box.w, box.h)
    ctx.strokeStyle = SELECTION_STROKE
    ctx.lineWidth = 1.5
    ctx.setLineDash([5, 4])
    ctx.strokeRect(x, y, box.w, box.h)
    ctx.setLineDash([])
    ctx.fillStyle = SELECTION_HANDLE
    for (const point of [
      { x, y },
      { x: x + box.w, y },
      { x, y: y + box.h },
      { x: x + box.w, y: y + box.h },
    ]) {
      ctx.beginPath()
      ctx.arc(point.x, point.y, 5, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  private strokeBox(stroke: InknoteStroke): Bounds | null {
    if (!stroke.points.length) return null
    const box = boundsOf(stroke.points.map((point) => contentToDisplayPoint(point, this.metrics)))
    if (!box) return null
    return { x: box.x - 4, y: box.y - 4, w: box.w + 8, h: box.h + 8 }
  }

  /* ------------------------------ scheduling and helpers ------------------------------ */

  private requestRender(): void {
    if (this.destroyed || !this.canvas) return
    if (this.frame !== null) return
    if (typeof requestAnimationFrame !== 'function') {
      this.renderNow()
      return
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.renderNow()
    })
  }

  private invalidateRasterOnly(): void {
    this.dirtyRaster = true
    this.requestRender()
  }

  private notifyViewport(): void {
    if (!this.canvas) return
    if (this.viewportFrame !== null) return
    if (typeof requestAnimationFrame !== 'function') {
      this.host?.onViewportChange(this.viewport.scale)
      return
    }
    this.viewportFrame = requestAnimationFrame(() => {
      this.viewportFrame = null
      this.host?.onViewportChange(this.viewport.scale)
    })
  }

  private resize(): void {
    const canvas = this.canvas
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const first = this.cw <= 0 || this.ch <= 0
    this.cw = Math.max(0, finite(rect.width, 0))
    this.ch = Math.max(0, finite(rect.height, 0))
    canvas.width = Math.max(1, Math.round(this.cw * this.dpr))
    canvas.height = Math.max(1, Math.round(this.ch * this.dpr))
    if (first || !this.fitted) this.fitView()
    else this.requestRender()
  }

  private local(event: { clientX: number; clientY: number }): Point {
    const rect = this.canvas?.getBoundingClientRect()
    if (!rect) return { x: event.clientX, y: event.clientY }
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  private clientToLocal(clientX: number, clientY: number): Point {
    return this.local({ clientX, clientY })
  }

  private fingerDraw(): boolean {
    return this.host?.getSettings?.().fingerDraw === true
  }

  private pressure(event: PointerEvent): number {
    if (event.pointerType === 'pen') return clamp(event.pressure || 0.6, 0.15, 1)
    return 1
  }

  private snapWorld(point: Point, tool: InknoteStroke['tool']): Point {
    if (tool !== 'highlighter' || this.paper.style !== 'line') return point
    const step = paperLineStep('line', this.paper.spacing)
    if (!(step > 0)) return point
    return { x: point.x, y: Math.round(point.y / step) * step }
  }

  private toContentWidth(width: number): number {
    const ratio = this.metrics.contentWidth / Math.max(1, this.metrics.width)
    return Math.max(0.1, finite(width, 1) * ratio)
  }
}

function nearestPointOnSegment(point: Point, start: Point, end: Point): Point {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (!lengthSquared) return { x: start.x, y: start.y }
  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1)
  return { x: start.x + dx * t, y: start.y + dy * t }
}

/** Create the engine the Inknote editor mounts. */
export function createInknoteEngine(): InknoteEngineImpl {
  return new InknoteEngineImpl()
}

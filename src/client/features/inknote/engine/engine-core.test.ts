import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InknotePageContent, InknotePaper, InknoteStroke, InknoteTextBox } from '@shared/inknote/types'
import { PAPER_STYLES } from '@shared/inknote/constants'
import type { InknoteEngineHost, InknoteToolState } from './inknote-engine-types'
import {
  createInknoteEngine,
  InknoteEngineImpl,
  type InknoteEngineHostExtras,
} from './inknote-engine'
import {
  clearImageCache,
  drawPaper,
  inknoteCanvasBudget,
  MAX_RASTER_PIXELS,
  renderPageToCanvas,
} from './renderer'

const METRICS = { width: 816, height: 1056, contentWidth: 612, contentHeight: 792 }
const WIDE_METRICS = { width: 1056, height: 816, contentWidth: 792, contentHeight: 612 }
const PAPER: InknotePaper = { style: 'blank', color: 'white', spacing: 'normal' }
const LINE_PAPER: InknotePaper = { style: 'line', color: 'white', spacing: 'normal' }

interface MockContext extends CanvasRenderingContext2D {
  count(method: string): number
  reset(): void
}

let contexts = new WeakMap<HTMLCanvasElement, MockContext>()
let createdCanvases: HTMLCanvasElement[] = []
let engines: InknoteEngineImpl[] = []
let createCanvasElement: (() => HTMLCanvasElement) | null = null
let restoreCreateElement: (() => void) | null = null
let restoreGetContext: (() => void) | null = null
let restoreResizeObserver: (() => void) | null = null
let restoreAnimationFrame: (() => void) | null = null
let originalDpr = 1
let frames = new Map<number, FrameRequestCallback>()
let nextFrameId = 1
let observers: MockResizeObserver[] = []

class MockResizeObserver {
  readonly observe = vi.fn()
  readonly unobserve = vi.fn()
  readonly disconnect = vi.fn()
  constructor(readonly callback: ResizeObserverCallback) {
    void callback
    observers.push(this)
  }
}

function mockContext(): MockContext {
  const calls = new Map<string, number>()
  const record = (method: string) => (..._args: unknown[]): void => {
    calls.set(method, (calls.get(method) ?? 0) + 1)
  }
  const ctx: Record<string, unknown> = {
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    quadraticCurveTo: record('quadraticCurveTo'),
    bezierCurveTo: record('bezierCurveTo'),
    arc: record('arc'),
    ellipse: record('ellipse'),
    rect: record('rect'),
    fill: record('fill'),
    stroke: record('stroke'),
    strokeRect: record('strokeRect'),
    fillRect: record('fillRect'),
    clearRect: record('clearRect'),
    drawImage: record('drawImage'),
    fillText: record('fillText'),
    setTransform: record('setTransform'),
    translate: record('translate'),
    rotate: record('rotate'),
    scale: record('scale'),
    setLineDash: record('setLineDash'),
    putImageData: record('putImageData'),
    measureText: (text: string) => ({ width: text.length * 8 }),
    createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    count: (method: string) => calls.get(method) ?? 0,
    reset: () => calls.clear(),
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    strokeStyle: '#000',
    fillStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '10px sans-serif',
    textBaseline: 'alphabetic',
  }
  return ctx as unknown as MockContext
}

function contextFor(canvas: HTMLCanvasElement): MockContext {
  let ctx = contexts.get(canvas)
  if (!ctx) {
    ctx = mockContext()
    contexts.set(canvas, ctx)
  }
  return ctx
}

function flushFrames(): void {
  let guard = 0
  while (frames.size && guard++ < 20) {
    const entries = [...frames.values()]
    frames.clear()
    for (const callback of entries) callback(0)
  }
}

function setDevicePixelRatio(value: number): void {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value })
}

beforeEach(() => {
  contexts = new WeakMap()
  createdCanvases = []
  engines = []
  frames = new Map()
  nextFrameId = 1
  observers = []
  originalDpr = window.devicePixelRatio

  const originalGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string) {
    return kind === '2d' ? contextFor(this) : null
  } as typeof HTMLCanvasElement.prototype.getContext
  restoreGetContext = () => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
  }

  const originalCreate = document.createElement.bind(document)
  createCanvasElement = () => originalCreate('canvas')
  const createSpy = vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
    const element = originalCreate(tagName, options)
    if (tagName === 'canvas') createdCanvases.push(element as HTMLCanvasElement)
    return element
  }) as typeof document.createElement)
  restoreCreateElement = () => createSpy.mockRestore()

  const originalResizeObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
  restoreResizeObserver = () => {
    globalThis.ResizeObserver = originalResizeObserver
  }

  const originalRaf = globalThis.requestAnimationFrame
  const originalCancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const id = nextFrameId++
    frames.set(id, callback)
    return id
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = ((id: number) => {
    frames.delete(id)
  }) as typeof cancelAnimationFrame
  restoreAnimationFrame = () => {
    globalThis.requestAnimationFrame = originalRaf
    globalThis.cancelAnimationFrame = originalCancel
  }
})

afterEach(() => {
  for (const engine of engines) engine.destroy()
  engines = []
  restoreCreateElement?.()
  restoreGetContext?.()
  restoreResizeObserver?.()
  restoreAnimationFrame?.()
  restoreCreateElement = null
  restoreGetContext = null
  restoreResizeObserver = null
  restoreAnimationFrame = null
  setDevicePixelRatio(originalDpr)
  clearImageCache()
  vi.restoreAllMocks()
})

function makeCanvas(width = 800, height = 1000): HTMLCanvasElement {
  const canvas = createCanvasElement?.() ?? document.createElement('canvas')
  canvas.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  })
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  })
  return canvas
}

function toolState(overrides: Partial<InknoteToolState> = {}): InknoteToolState {
  return {
    tool: 'ballpen',
    color: '#112233',
    width: 5,
    style: 'normal',
    shape: 'line',
    eraserSize: 24,
    eraserMode: 'stroke',
    ...overrides,
  }
}

function blankPage(overrides: Partial<InknotePageContent> = {}): InknotePageContent {
  return {
    format: 'inknote-page',
    version: 1,
    strokes: [],
    texts: [],
    images: [],
    bg: null,
    ...overrides,
  }
}

function textBox(overrides: Partial<InknoteTextBox> = {}): InknoteTextBox {
  return {
    id: 't1',
    x: 0.1,
    y: 0.2,
    w: 0.3,
    h: 0.1,
    text: 'hello',
    fontSize: 26,
    color: '#111111',
    align: 'left',
    bold: false,
    italic: false,
    underline: false,
    hl: null,
    lh: 1.3,
    list: null,
    ...overrides,
  }
}

function testStroke(id: string, points: Array<[number, number]>): InknoteStroke {
  return {
    id,
    tool: 'ballpen',
    style: 'dashed',
    shape: null,
    color: '#334455',
    width: 4,
    points: points.map(([x, y]) => ({ x, y, p: 1 })),
  }
}

interface SetupOptions {
  page?: InknotePageContent
  paper?: InknotePaper
  metrics?: typeof METRICS
  tool?: InknoteToolState
  extras?: Partial<InknoteEngineHostExtras>
}

function setup(options: SetupOptions = {}) {
  const page = options.page ?? blankPage()
  const paper = options.paper ?? PAPER
  const metrics = options.metrics ?? METRICS
  const toolRef = { current: options.tool ?? toolState() }
  const onContentChange = vi.fn()
  const onCommit = vi.fn()
  const onTextTap = vi.fn()
  const onSelectionChange = vi.fn()
  const onGesture = vi.fn()
  const onAutoPage = vi.fn()
  const onViewportChange = vi.fn()
  const host: InknoteEngineHost & InknoteEngineHostExtras = {
    getPage: () => page,
    getPaper: () => paper,
    getPageMetrics: () => metrics,
    getFont: () => 'sans-serif',
    getTool: () => toolRef.current,
    onContentChange,
    onCommit,
    onTextTap,
    onSelectionChange,
    onGesture,
    onAutoPage,
    onViewportChange,
    ...options.extras,
  }
  const canvas = makeCanvas()
  const engine = new InknoteEngineImpl()
  engines.push(engine)
  engine.mount(canvas, host)
  engine.setTool(toolRef.current)
  engine.setPage(page, paper, metrics)
  flushFrames()
  return {
    engine,
    canvas,
    host,
    page,
    paper,
    metrics,
    toolRef,
    onContentChange,
    onCommit,
    onTextTap,
    onSelectionChange,
    onGesture,
    onAutoPage,
    onViewportChange,
  }
}

function pointerEvent(
  type: string,
  init: {
    x: number
    y: number
    id?: number
    pointerType?: string
    button?: number
    pressure?: number
  },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, {
    pointerId: init.id ?? 1,
    pointerType: init.pointerType ?? 'mouse',
    button: init.button ?? 0,
    buttons: init.button ? 4 : 1,
    clientX: init.x,
    clientY: init.y,
    pressure: init.pressure ?? 0.5,
  })
  return event
}

function drawStroke(
  canvas: HTMLCanvasElement,
  engine: InknoteEngineImpl,
  points: Array<{ x: number; y: number }>,
  pointerId = 1,
  pointerType = 'mouse',
): void {
  const first = engine.worldToScreen(points[0]!.x, points[0]!.y)
  canvas.dispatchEvent(pointerEvent('pointerdown', { x: first.x, y: first.y, id: pointerId, pointerType }))
  for (const point of points.slice(1)) {
    const screen = engine.worldToScreen(point.x, point.y)
    canvas.dispatchEvent(pointerEvent('pointermove', { x: screen.x, y: screen.y, id: pointerId, pointerType }))
  }
  const lastPoint = points[points.length - 1]!
  const last = engine.worldToScreen(lastPoint.x, lastPoint.y)
  canvas.dispatchEvent(pointerEvent('pointerup', { x: last.x, y: last.y, id: pointerId, pointerType }))
}

describe('engine lifecycle and viewport', () => {
  it('mounts once, caps DPR at 2.5 and tears every listener down idempotently', () => {
    setDevicePixelRatio(3)
    const { engine, canvas, host, page } = setup()
    expect(canvas.width).toBe(2000)
    expect(canvas.height).toBe(2500)
    expect(() => engine.mount(canvas, host)).toThrow()

    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    canvas.dispatchEvent(contextMenu)
    expect(contextMenu.defaultPrevented).toBe(true)

    engine.destroy()
    expect(observers.at(-1)?.disconnect).toHaveBeenCalled()
    engine.destroy()

    const afterDestroy = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    canvas.dispatchEvent(afterDestroy)
    expect(afterDestroy.defaultPrevented).toBe(false)
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 100, y: 100 }))
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 120, y: 120 }))
    expect(page.strokes).toHaveLength(0)

    const secondCanvas = makeCanvas()
    engine.mount(secondCanvas, host)
    engine.setTool(toolState())
    engine.setPage(page, PAPER, METRICS)
    drawStroke(secondCanvas, engine, [{ x: 100, y: 100 }, { x: 200, y: 200 }])
    expect(page.strokes).toHaveLength(1)
  })

  it('pans with the right mouse button and never draws it as ink', () => {
    const { engine, canvas, page } = setup()
    const before = engine.getViewport()
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 100, y: 100, button: 2 }))
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 160, y: 130, button: 2 }))
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 160, y: 130, button: 2 }))
    expect(page.strokes).toHaveLength(0)
    expect(engine.getViewport().offsetX).toBeCloseTo(before.offsetX + 60)
    expect(engine.getViewport().offsetY).toBeCloseTo(before.offsetY + 30)
  })

  it('zooms around the wheel pointer and frames page content', () => {
    const { engine, canvas } = setup()
    const scale = engine.getScale()
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, clientX: 400, clientY: 500, bubbles: true, cancelable: true }))
    expect(engine.getScale()).toBeGreaterThan(scale)
    expect(engine.frameContent()).toBe(false)

    const worldBefore = engine.screenToWorld(400, 500)
    engine.zoomAt(400, 500, 1.5)
    const worldAfter = engine.screenToWorld(400, 500)
    expect(worldAfter.x).toBeCloseTo(worldBefore.x)
    expect(worldAfter.y).toBeCloseTo(worldBefore.y)
  })

  it('keeps viewport, clears selection/history and rebuilds the raster on setPage', () => {
    const pageA = blankPage({ strokes: [testStroke('s1', [[100, 100], [300, 200]])] })
    const { engine, canvas, onSelectionChange } = setup({ page: pageA })
    engine.zoomAt(400, 500, 1.7)
    flushFrames()
    const scale = engine.getScale()
    engine.selectAll()
    expect(engine.selectionIds()).toHaveLength(1)
    onSelectionChange.mockClear()

    drawStroke(canvas, engine, [{ x: 400, y: 400 }, { x: 500, y: 500 }])
    expect(engine.canUndo()).toBe(true)
    const raster = createdCanvases.find((entry) => entry !== canvas)
    expect(raster).toBeDefined()
    const rasterContext = contextFor(raster!)
    rasterContext.reset()

    const pageB = blankPage()
    engine.setPage(pageB, PAPER, METRICS)
    flushFrames()
    expect(engine.getScale()).toBeCloseTo(scale)
    expect(engine.canUndo()).toBe(false)
    expect(engine.selectionIds()).toEqual([])
    expect(onSelectionChange).toHaveBeenLastCalledWith([])

    engine.renderNow()
    expect(rasterContext.count('lineTo')).toBe(0)
    expect(rasterContext.count('quadraticCurveTo')).toBe(0)

    drawStroke(canvas, engine, [{ x: 400, y: 400 }, { x: 500, y: 500 }])
    expect(pageB.strokes).toHaveLength(1)
    expect(pageA.strokes).toHaveLength(2)
  })

  it('refits when setPage changes the page dimensions', () => {
    const { engine } = setup()
    const before = engine.getScale()
    const wide = blankPage()
    engine.setPage(wide, PAPER, WIDE_METRICS)
    flushFrames()
    expect(engine.getMetrics()).toEqual(WIDE_METRICS)
    expect(engine.getScale()).not.toBeCloseTo(before)
  })
})

describe('pointer input, tools and gestures', () => {
  it('converts display coordinates to content coordinates and stores a ballpen stroke', () => {
    const { engine, canvas, page, onCommit, onContentChange } = setup()
    drawStroke(canvas, engine, [{ x: 100, y: 100 }, { x: 200, y: 150 }, { x: 300, y: 200 }])
    expect(page.strokes).toHaveLength(1)
    const stroke = page.strokes[0]!
    expect(stroke.tool).toBe('ballpen')
    expect(stroke.points[0]!.x).toBeCloseTo(75)
    expect(stroke.points[0]!.y).toBeCloseTo(75)
    expect(stroke.points.at(-1)!.x).toBeCloseTo(225)
    expect(stroke.points.at(-1)!.y).toBeCloseTo(150)
    expect(stroke.width).toBeCloseTo(3.75)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onContentChange).toHaveBeenCalledWith('stroke')
  })

  it('commits a single tap as a one-point dot', () => {
    const { engine, canvas, page } = setup()
    const screen = engine.worldToScreen(100, 100)
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: screen.x, y: screen.y }))
    canvas.dispatchEvent(pointerEvent('pointerup', { x: screen.x, y: screen.y }))
    expect(page.strokes[0]?.points).toHaveLength(1)
  })

  it('snaps the highlighter to ruled-paper lines', () => {
    const { engine, canvas, page } = setup({
      paper: LINE_PAPER,
      tool: toolState({ tool: 'highlighter', color: '#fde047', width: 14 }),
    })
    drawStroke(canvas, engine, [{ x: 100, y: 50 }, { x: 200, y: 55 }, { x: 300, y: 60 }])
    const stroke = page.strokes[0]!
    expect(stroke.tool).toBe('highlighter')
    const expectedY = 48 * (METRICS.contentHeight / METRICS.height)
    for (const point of stroke.points) expect(point.y).toBeCloseTo(expectedY)
  })

  it('creates a rectangle through the shape tool and drops a too-short drag', () => {
    const { engine, canvas, page } = setup({ tool: toolState({ tool: 'shape', shape: 'rect', color: '#123456', width: 6 }) })
    drawStroke(canvas, engine, [{ x: 300, y: 300 }, { x: 500, y: 450 }])
    expect(page.strokes).toHaveLength(1)
    const shape = page.strokes[0]!
    expect(shape.shape).toBe('rect')
    expect(shape.points[0]!.x).toBeCloseTo(225)
    expect(shape.points[1]!.x).toBeCloseTo(375)

    drawStroke(canvas, engine, [{ x: 100, y: 100 }, { x: 102, y: 102 }])
    expect(page.strokes).toHaveLength(1)
  })

  it('erases a whole stroke and restores it through undo', () => {
    const { engine, canvas, page, toolRef, onContentChange } = setup()
    drawStroke(canvas, engine, [{ x: 100, y: 100 }, { x: 300, y: 200 }])
    toolRef.current = toolState({ tool: 'eraser', eraserSize: 24 })
    const target = engine.worldToScreen(200, 150)
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: target.x, y: target.y }))
    canvas.dispatchEvent(pointerEvent('pointerup', { x: target.x, y: target.y }))
    expect(page.strokes).toHaveLength(0)
    expect(onContentChange).toHaveBeenLastCalledWith('erase')
    expect(engine.undo()).toBe(true)
    expect(page.strokes).toHaveLength(1)
  })

  it('splits a stroke with the pixel eraser and preserves its style', () => {
    const points: Array<[number, number]> = []
    for (let x = 100; x <= 500; x += 8) points.push([x, 300])
    const page = blankPage({ strokes: [testStroke('s1', points)] })
    const { engine, canvas, onContentChange } = setup({
      page,
      tool: toolState({ tool: 'pixelEraser', eraserSize: 20 }),
    })
    const from = engine.fromContentPoint({ x: 150, y: 300 })
    const to = engine.fromContentPoint({ x: 350, y: 300 })
    const start = engine.worldToScreen(from.x, from.y)
    const end = engine.worldToScreen(to.x, to.y)
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: start.x, y: start.y }))
    canvas.dispatchEvent(pointerEvent('pointermove', { x: end.x, y: end.y }))
    canvas.dispatchEvent(pointerEvent('pointerup', { x: end.x, y: end.y }))
    expect(page.strokes.length).toBeGreaterThanOrEqual(2)
    for (const stroke of page.strokes) {
      expect(stroke.tool).toBe('ballpen')
      expect(stroke.style).toBe('dashed')
      expect(stroke.color).toBe('#334455')
    }
    expect(onContentChange).toHaveBeenLastCalledWith('pixel-erase')
    expect(engine.undo()).toBe(true)
    expect(page.strokes).toHaveLength(1)
  })

  it('routes a text tap to the host and answers hit tests', () => {
    const page = blankPage({ texts: [textBox()] })
    const { engine, canvas, onTextTap } = setup({ page, tool: toolState({ tool: 'text' }) })
    expect(engine.hitText({ x: 100, y: 250 })?.id).toBe('t1')
    expect(engine.hitText({ x: 780, y: 1000 })).toBeNull()

    const screen = engine.worldToScreen(200, 300)
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: screen.x, y: screen.y }))
    canvas.dispatchEvent(pointerEvent('pointerup', { x: screen.x, y: screen.y }))
    expect(onTextTap).toHaveBeenCalledTimes(1)
    expect(onTextTap.mock.calls[0]![0].x).toBeCloseTo(200)
    expect(onTextTap.mock.calls[0]![0].y).toBeCloseTo(300)
    expect(engine.textLayerItems()[0]?.screen.w).toBeCloseTo(0.3 * METRICS.width * engine.getScale())
  })

  it('does not turn a two-finger drag into an undo tap', () => {
    const { canvas, onGesture } = setup()
    const now = vi.spyOn(Date, 'now')
    let clock = 1_000
    now.mockImplementation(() => clock)
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 100, y: 100, id: 1, pointerType: 'touch' }))
    clock += 50
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 200, y: 200, id: 2, pointerType: 'touch' }))
    clock += 20
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 145, y: 100, id: 1, pointerType: 'touch' }))
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 145, y: 100, id: 1, pointerType: 'touch' }))
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 200, y: 200, id: 2, pointerType: 'touch' }))
    expect(onGesture).not.toHaveBeenCalled()
    now.mockRestore()
  })

  it('uses the two-finger tap thresholds for undo and rejects slow taps', () => {
    const { canvas, onGesture } = setup()
    const now = vi.spyOn(Date, 'now')
    let clock = 1_000
    now.mockImplementation(() => clock)
    const tap = (): void => {
      canvas.dispatchEvent(pointerEvent('pointerdown', { x: 100, y: 100, id: 1, pointerType: 'touch' }))
      clock += 50
      canvas.dispatchEvent(pointerEvent('pointerdown', { x: 200, y: 200, id: 2, pointerType: 'touch' }))
      canvas.dispatchEvent(pointerEvent('pointerup', { x: 100, y: 100, id: 1, pointerType: 'touch' }))
      canvas.dispatchEvent(pointerEvent('pointerup', { x: 200, y: 200, id: 2, pointerType: 'touch' }))
    }

    tap()
    expect(onGesture).toHaveBeenLastCalledWith('undo')
    onGesture.mockClear()

    clock += 400
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 100, y: 100, id: 1, pointerType: 'touch' }))
    clock += 50
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 200, y: 200, id: 2, pointerType: 'touch' }))
    clock += 400
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 100, y: 100, id: 1, pointerType: 'touch' }))
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 200, y: 200, id: 2, pointerType: 'touch' }))
    expect(onGesture).not.toHaveBeenCalled()
    now.mockRestore()
  })

  it('handles three-finger tap redo, pinch zoom and two-finger page turn', () => {
    const { engine, canvas, onGesture } = setup()
    const now = vi.spyOn(Date, 'now')
    let clock = 1_000
    now.mockImplementation(() => clock)
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 100, y: 100, id: 1, pointerType: 'touch' }))
    clock += 30
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 200, y: 200, id: 2, pointerType: 'touch' }))
    clock += 30
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 300, y: 300, id: 3, pointerType: 'touch' }))
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 100, y: 100, id: 1, pointerType: 'touch' }))
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 200, y: 200, id: 2, pointerType: 'touch' }))
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 300, y: 300, id: 3, pointerType: 'touch' }))
    expect(onGesture).toHaveBeenLastCalledWith('redo')
    onGesture.mockClear()

    const scale = engine.getScale()
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 100, y: 400, id: 4, pointerType: 'touch' }))
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 200, y: 400, id: 5, pointerType: 'touch' }))
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 50, y: 400, id: 4, pointerType: 'touch' }))
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 250, y: 400, id: 5, pointerType: 'touch' }))
    expect(engine.getScale()).toBeGreaterThan(scale * 1.5)
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 50, y: 400, id: 4, pointerType: 'touch' }))
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 250, y: 400, id: 5, pointerType: 'touch' }))

    clock += 1_000
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 100, y: 400, id: 6, pointerType: 'touch' }))
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 200, y: 400, id: 7, pointerType: 'touch' }))
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 20, y: 400, id: 6, pointerType: 'touch' }))
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 120, y: 400, id: 7, pointerType: 'touch' }))
    expect(onGesture).toHaveBeenLastCalledWith('page-next')
    now.mockRestore()
  })

  it('scrolls the host with one-finger touch and falls back to viewport panning', () => {
    const onScroll = vi.fn()
    const { engine, canvas, page } = setup({ extras: { onScroll } })
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 100, y: 100, pointerType: 'touch' }))
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 100, y: 150, pointerType: 'touch' }))
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 100, y: 150, pointerType: 'touch' }))
    expect(onScroll).toHaveBeenCalledWith(50, 0)
    expect(page.strokes).toHaveLength(0)

    const fallback = setup()
    const offset = fallback.engine.getViewport().offsetY
    fallback.canvas.dispatchEvent(pointerEvent('pointerdown', { x: 100, y: 100, pointerType: 'touch' }))
    fallback.canvas.dispatchEvent(pointerEvent('pointermove', { x: 100, y: 150, pointerType: 'touch' }))
    expect(fallback.engine.getViewport().offsetY).toBeCloseTo(offset + 50)
    expect(engine.getScale()).toBe(fallback.engine.getScale())
  })
})

describe('history and selection', () => {
  it('undoes and redoes content, and a new edit clears the redo tail', () => {
    const { engine, canvas, page, onContentChange } = setup()
    drawStroke(canvas, engine, [{ x: 100, y: 100 }, { x: 300, y: 200 }])
    expect(page.strokes).toHaveLength(1)
    expect(engine.canUndo()).toBe(true)
    expect(engine.undo()).toBe(true)
    expect(page.strokes).toHaveLength(0)
    expect(engine.canRedo()).toBe(true)
    expect(engine.redo()).toBe(true)
    expect(page.strokes).toHaveLength(1)

    expect(engine.undo()).toBe(true)
    drawStroke(canvas, engine, [{ x: 400, y: 400 }, { x: 500, y: 500 }])
    expect(engine.canRedo()).toBe(false)
    expect(page.strokes).toHaveLength(1)
    expect(onContentChange).toHaveBeenCalled()
  })

  it('selects all, copies, pastes with an offset, rotates images and deletes', () => {
    const image = { id: 'i1', x: 0.1, y: 0.2, w: 0.2, h: 0.2, assetId: 'a1', url: '/api/inknote/assets/a1', rot: 0 as const }
    const page = blankPage({
      strokes: [testStroke('s1', [[100, 100], [200, 200]])],
      texts: [textBox()],
      images: [image],
    })
    const { engine, page: current } = setup({ page, tool: toolState({ tool: 'lasso' }) })
    engine.selectAll()
    expect(engine.selectionIds()).toHaveLength(3)
    expect(engine.selectionBox()).not.toBeNull()

    expect(engine.rotateSelection()).toBe(true)
    expect(current.images[0]!.rot).toBe(90)
    expect(engine.copySelection()).toBe(true)
    expect(engine.pasteSelection()).toBe(true)
    expect(current.strokes).toHaveLength(2)
    expect(current.texts).toHaveLength(2)
    expect(current.images).toHaveLength(2)
    expect(current.strokes[1]!.points[0]!.x).toBeCloseTo(100 + METRICS.contentWidth * 0.02)

    expect(engine.deleteSelection()).toBe(true)
    expect(current.strokes).toHaveLength(1)
    expect(current.texts).toHaveLength(1)
    expect(current.images).toHaveLength(1)
    expect(engine.undo()).toBe(true)
    expect(current.strokes).toHaveLength(2)
  })

  it('moves and scales the selection through the public API', () => {
    const page = blankPage({ strokes: [testStroke('s1', [[100, 100], [300, 200]])] })
    const { engine } = setup({ page, tool: toolState({ tool: 'lasso' }) })
    engine.selectAll()
    const before = engine.selectionBox()!
    expect(engine.moveSelection(20, 10)).toBe(true)
    const moved = engine.selectionBox()!
    expect(moved.x).toBeCloseTo(before.x + 20)
    expect(moved.y).toBeCloseTo(before.y + 10)
    expect(engine.scaleSelection('se', { x: moved.x + moved.w + 50, y: moved.y + moved.h + 50 })).toBe(true)
    expect(engine.selectionBox()!.w).toBeGreaterThan(moved.w)
  })

  it('selects strokes, text and images with the lasso', () => {
    const page = blankPage({
      strokes: [testStroke('s1', [[100, 100], [120, 100]])],
      texts: [textBox({ x: 0.4, y: 0.4, w: 0.2, h: 0.1 })],
      images: [{ id: 'i1', x: 0.2, y: 0.7, w: 0.1, h: 0.1, assetId: 'a1', url: '/api/inknote/assets/a1', rot: 0 }],
    })
    const { engine, canvas, onSelectionChange } = setup({ page, tool: toolState({ tool: 'lasso' }) })
    drawStroke(canvas, engine, [{ x: 20, y: 20 }, { x: 790, y: 20 }, { x: 790, y: 1030 }, { x: 20, y: 1030 }])
    expect(engine.selectionIds()).toEqual(expect.arrayContaining(['s1', 't:t1', 'i:i1']))
    expect(onSelectionChange).toHaveBeenLastCalledWith(expect.arrayContaining(['s1', 't:t1', 'i:i1']))
  })

  it('recognizes a held freehand rectangle and reports the shape', () => {
    const onShapeRecognized = vi.fn()
    const now = vi.spyOn(Date, 'now')
    let clock = 1_000
    now.mockImplementation(() => clock)
    const { engine, canvas, page } = setup({
      tool: toolState({ tool: 'pen', color: '#123456', width: 5 }),
      extras: { onShapeRecognized },
    })
    const points = [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }, { x: 100, y: 100 }]
    const first = engine.worldToScreen(points[0]!.x, points[0]!.y)
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: first.x, y: first.y }))
    for (const point of points.slice(1)) {
      const screen = engine.worldToScreen(point.x, point.y)
      canvas.dispatchEvent(pointerEvent('pointermove', { x: screen.x, y: screen.y }))
    }
    clock += 300
    const last = engine.worldToScreen(points.at(-1)!.x, points.at(-1)!.y)
    canvas.dispatchEvent(pointerEvent('pointerup', { x: last.x, y: last.y }))
    expect(page.strokes).toHaveLength(1)
    expect(page.strokes[0]!.shape).toBe('square')
    expect(onShapeRecognized).toHaveBeenCalledWith('square')
    now.mockRestore()
  })

  it('asks the host to advance the page after ink reaches the bottom', () => {
    vi.useFakeTimers()
    try {
      const { engine, canvas, onAutoPage } = setup()
      drawStroke(canvas, engine, [{ x: 200, y: 1_000 }, { x: 300, y: 1_010 }])
      expect(onAutoPage).not.toHaveBeenCalled()
      vi.advanceTimersByTime(250)
      expect(onAutoPage).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('locks editing during playback and ignores undo', () => {
    const { engine, canvas, page } = setup()
    engine.setPlaybackLock(true)
    const screen = engine.worldToScreen(100, 100)
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: screen.x, y: screen.y }))
    canvas.dispatchEvent(pointerEvent('pointerup', { x: screen.x, y: screen.y }))
    expect(page.strokes).toHaveLength(0)
    expect(engine.undo()).toBe(false)
    engine.destroyRecordingReplay()
    expect(engine.isPlaybackLocked()).toBe(false)
  })
})

describe('renderer budget', () => {
  it('keeps a normal page at the 2.5 raster scale', () => {
    expect(inknoteCanvasBudget(816, 1056, 2.5).scale).toBeCloseTo(2.5)
  })

  it('reduces the scale so a 4K raster stays inside the pixel ceiling', () => {
    const budget = inknoteCanvasBudget(3840, 2160, 2.5)
    expect(budget.scale).toBeLessThan(2.5)
    expect(budget.width * budget.height).toBeLessThanOrEqual(MAX_RASTER_PIXELS)
  })

  it('draws every paper style', () => {
    const ctx = mockContext()
    for (const style of PAPER_STYLES) {
      expect(() => drawPaper(ctx, { style: style.id, color: 'white', spacing: 'normal' }, 816, 1056)).not.toThrow()
    }
    expect(ctx.count('fillRect')).toBe(PAPER_STYLES.length)
  })

  it('renders a thumbnail at the requested width', () => {
    const canvas = renderPageToCanvas(blankPage(), PAPER, METRICS, 160, 'sans-serif')
    expect(canvas).not.toBeNull()
    expect(canvas!.width).toBe(160)
    expect(canvas!.height).toBe(Math.round((1056 / 816) * 160))
  })
})

describe('factory', () => {
  it('creates independent engine instances', () => {
    const first = createInknoteEngine()
    const second = createInknoteEngine()
    expect(first).not.toBe(second)
  })
})

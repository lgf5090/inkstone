import { boundsOf, contentBounds, selectLasso, selectionBounds, type InkBounds } from '../../lib/inkpad/geometry'
import { kindFromMime } from '../../lib/inkpad/element-kind'
import { serializeInkDocument } from '../../lib/inkpad/format'
import { classifyInkLink } from '../../lib/inkpad/link'
import { buildInkSvg } from '../../lib/inkpad/svg-export'
import { canAcceptPoint, filterPressure } from '../../lib/inkpad/stroke-math'
import {
    frameTransform,
    pinchTransform,
    resetZoomTransform,
    toWorldPoint,
    zoomAt,
    type InkTransform,
} from '../../lib/inkpad/transform'
import type { InkDocument, InkElement, InkPoint, InkShape, InkStroke, InkTool } from '../../lib/inkpad/types'
import { renderInkPng, renderSelectionPng } from './ink-export'
import type { InkEngine, InkEngineHost } from './ink-engine-types'
import { InkHistory } from './ink-history'
import { coalescedPointerEvents, isMiddleButton, isPenBarrelPress } from './ink-input'
import { InkRenderer } from './ink-renderer'

interface PendingMouseInk {
    stroke: InkStroke
    first: InkPoint
    points: InkPoint[]
}

interface SelectionMove {
    start: InkPoint
    strokes: InkStroke[]
    shapes: InkShape[]
}

interface ElementGesture {
    id: string
    pointerId: number
    startClientX: number
    startClientY: number
    startX: number
    startY: number
    startWidth: number
    startHeight: number
    mode: 'move' | 'resize'
}

const SHAPE_TOOLS: ReadonlySet<InkTool> = new Set(['line', 'arrow', 'rectangle', 'ellipse'])
const BRUSH_TOOLS: ReadonlySet<InkTool> = new Set(['pen', 'pencil', 'marker', 'highlighter'])
const VIEWPORT_DIRTY_DELAY_MS = 250

function newId(): string {
    return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function lastOf<T>(items: readonly T[]): T | undefined {
    return items.length ? items[items.length - 1] : undefined
}

export class InkEngineImpl implements InkEngine {
    private readonly host: InkEngineHost
    private readonly history = new InkHistory()
    private document: InkDocument = { format: 'inkpad', version: 1, strokes: [], shapes: [], elements: [] }
    private transform: InkTransform = { x: 0, y: 0, zoom: 1 }
    private tool: InkTool = 'pen'
    private color = '#ffffff'
    private width = 3

    private canvas: HTMLCanvasElement | null = null
    private hostEl: HTMLElement | null = null
    private renderer: InkRenderer | null = null
    private resizeObserver: ResizeObserver | null = null
    private navigationFrame: number | null = null
    private navigationZoomChanged = false
    private mouseFrame: number | null = null
    private viewportDirtyTimer: number | null = null
    private destroyed = false

    private activeStroke: InkStroke | null = null
    private activeShape: InkShape | null = null
    private lassoPoints: InkPoint[] = []
    private selectedStrokeIds = new Set<string>()
    private selectedShapeIds = new Set<string>()
    private selectionMove: SelectionMove | null = null

    private pointers = new Map<number, PointerEvent>()
    private activePointer: number | null = null
    private panPointer: number | null = null
    private panStart: { x: number; y: number; transform: InkTransform } | null = null
    private pinchStart: { distance: number; centerX: number; centerY: number; transform: InkTransform } | null = null
    private pendingMouseInk: PendingMouseInk | null = null
    private elementGesture: ElementGesture | null = null

    private readonly onPointerDown = (event: PointerEvent): void => this.handlePointerDown(event)
    private readonly onPointerMove = (event: PointerEvent): void => this.handlePointerMove(event)
    private readonly onPointerUp = (event: PointerEvent): void => this.handlePointerUp(event)
    private readonly onWheel = (event: WheelEvent): void => this.handleWheel(event)
    private readonly onKeyDown = (event: KeyboardEvent): void => this.handleKeyDown(event)
    private readonly onContextMenu = (event: MouseEvent): void => event.preventDefault()
    private readonly onWindowBlur = (): void => this.handleWindowBlur()

    constructor(host: InkEngineHost) {
        this.host = host
    }

    mount(canvas: HTMLCanvasElement, hostEl: HTMLElement): void {
        if (this.canvas) throw new Error('InkEngine is already mounted')
        this.destroyed = false
        this.canvas = canvas
        this.hostEl = hostEl
        this.renderer = new InkRenderer(canvas)
        if (!this.renderer.available) this.host.onError('canvas_unavailable')
        canvas.addEventListener('pointerdown', this.onPointerDown, { passive: false })
        canvas.addEventListener('pointermove', this.onPointerMove, { passive: false })
        canvas.addEventListener('pointerup', this.onPointerUp, { passive: false })
        canvas.addEventListener('pointercancel', this.onPointerUp, { passive: false })
        canvas.addEventListener('wheel', this.onWheel, { passive: false })
        canvas.addEventListener('keydown', this.onKeyDown)
        canvas.addEventListener('contextmenu', this.onContextMenu)
        window.addEventListener('blur', this.onWindowBlur)
        this.resizeObserver = new ResizeObserver(() => this.resize())
        this.resizeObserver.observe(hostEl)
        this.resize()
    }

    destroy(): void {
        if (this.destroyed) return
        this.destroyed = true
        if (this.canvas) {
            this.canvas.removeEventListener('pointerdown', this.onPointerDown)
            this.canvas.removeEventListener('pointermove', this.onPointerMove)
            this.canvas.removeEventListener('pointerup', this.onPointerUp)
            this.canvas.removeEventListener('pointercancel', this.onPointerUp)
            this.canvas.removeEventListener('wheel', this.onWheel)
            this.canvas.removeEventListener('keydown', this.onKeyDown)
            this.canvas.removeEventListener('contextmenu', this.onContextMenu)
        }
        window.removeEventListener('blur', this.onWindowBlur)
        this.resizeObserver?.disconnect()
        this.resizeObserver = null
        if (this.navigationFrame !== null) cancelAnimationFrame(this.navigationFrame)
        if (this.mouseFrame !== null) cancelAnimationFrame(this.mouseFrame)
        if (this.viewportDirtyTimer !== null) window.clearTimeout(this.viewportDirtyTimer)
        this.navigationFrame = null
        this.mouseFrame = null
        this.viewportDirtyTimer = null
        this.pointers.clear()
        this.activePointer = null
        this.panPointer = null
        this.pinchStart = null
        this.activeStroke = null
        this.activeShape = null
        this.elementGesture = null
        this.renderer?.destroy()
        this.renderer = null
        this.canvas = null
        this.hostEl = null
    }

    load(document: InkDocument): void {
        this.document = document
        this.transform = document.viewport ? { ...document.viewport } : { x: 0, y: 0, zoom: 1 }
        this.history.clear()
        this.activeStroke = null
        this.activeShape = null
        this.lassoPoints = []
        this.selectionMove = null
        this.selectedStrokeIds.clear()
        this.selectedShapeIds.clear()
        this.renderer?.invalidate()
        this.render()
        this.host.onElementsChange()
        this.host.onSelectionChange(0, false)
        this.host.onViewportChange(this.transform.zoom)
    }

    serialize(): string {
        this.document.viewport = { ...this.transform }
        return serializeInkDocument(this.document)
    }

    elements(): readonly InkElement[] {
        return this.document.elements
    }

    bookmarks() {
        return this.document.bookmarks ?? []
    }

    zoom(): number {
        return this.transform.zoom
    }

    layoutElements(): void {
        const host = this.hostEl
        if (!host) return
        const zoom = this.transform.zoom
        const rects = this.document.elements.map((element) => ({
            left: this.transform.x + element.x * zoom,
            top: this.transform.y + element.y * zoom,
            width: element.width * zoom,
            height: element.height * zoom,
        }))
        const elements = new Map(this.document.elements.map((element, index) => [element.id, { element, index }]))
        for (const attr of ['data-element-body-id', 'data-element-control-id'] as const) {
            for (const node of host.querySelectorAll<HTMLElement>(`[${attr}]`)) {
                const entry = elements.get(node.dataset[attr === 'data-element-body-id' ? 'elementBodyId' : 'elementControlId'] ?? '')
                if (!entry) continue
                const { index } = entry
                const rect = rects[index]!
                node.style.left = `${rect.left}px`
                node.style.top = `${rect.top}px`
                node.style.width = `${rect.width}px`
                node.style.height = `${rect.height}px`
                node.style.zIndex = String(index + 1)
                if (attr === 'data-element-body-id') {
                    node.style.setProperty('--ink-card-zoom', String(zoom))
                } else {
                    // Controls live above the ink layer, so a control whose own header is covered
                    // by a higher card must stand down: otherwise its buttons float over that card.
                    const header = { left: rect.left, top: rect.top, width: rect.width, height: 42 }
                    const covered = rects.slice(index + 1).some((other) => other.width > 0 && other.height > 0
                        && other.left < header.left + header.width
                        && other.left + other.width > header.left
                        && other.top < header.top + header.height
                        && other.top + other.height > header.top)
                    node.style.visibility = covered ? 'hidden' : ''
                }
            }
        }
    }

    setTool(tool: InkTool): void {
        this.tool = tool
        this.host.onToolChange(tool)
    }

    setInk(color: string, width: number): void {
        this.color = color
        this.width = Math.min(16, Math.max(1, Number.isFinite(width) ? width : 3))
    }

    refreshAppearance(): void {
        this.render()
    }

    undo(): void {
        const previous = this.history.undo(this.document)
        if (!previous) return
        this.document = previous
        this.activeStroke = null
        this.activeShape = null
        this.clearSelection()
        this.renderer?.invalidate()
        this.render()
        this.host.onElementsChange()
        this.host.onDirty()
    }

    redo(): void {
        const next = this.history.redo(this.document)
        if (!next) return
        this.document = next
        this.activeStroke = null
        this.activeShape = null
        this.clearSelection()
        this.renderer?.invalidate()
        this.render()
        this.host.onElementsChange()
        this.host.onDirty()
    }

    canUndo(): boolean {
        return this.history.canUndo
    }

    canRedo(): boolean {
        return this.history.canRedo
    }

    frameContent(): boolean {
        const bounds = contentBounds(this.document)
        if (!bounds) return false
        const size = this.renderer?.logicalSize() ?? { width: 1, height: 1 }
        this.transform = frameTransform(bounds, { left: 0, top: 0, width: size.width, height: size.height })
        this.render()
        this.host.onViewportChange(this.transform.zoom)
        this.markDirty()
        return true
    }

    resetZoom(): void {
        const size = this.renderer?.logicalSize() ?? { width: 1, height: 1 }
        this.transform = resetZoomTransform(this.transform, { left: 0, top: 0, width: size.width, height: size.height })
        this.render()
        this.host.onViewportChange(this.transform.zoom)
        this.markDirty()
    }

    selectionCount(): number {
        return this.selectedStrokeIds.size + this.selectedShapeIds.size
    }

    hasSelectionLink(): boolean {
        return this.document.strokes.some((stroke) => this.selectedStrokeIds.has(stroke.id) && Boolean(stroke.link))
            || this.document.shapes.some((shape) => this.selectedShapeIds.has(shape.id) && Boolean(shape.link))
    }

    deleteSelection(): void {
        if (!this.selectionCount()) return
        this.history.snapshot(this.document)
        this.document.strokes = this.document.strokes.filter((stroke) => !this.selectedStrokeIds.has(stroke.id))
        this.document.shapes = this.document.shapes.filter((shape) => !this.selectedShapeIds.has(shape.id))
        this.clearSelection()
        this.renderer?.invalidate()
        this.render()
        this.markDirty()
    }

    duplicateSelection(): void {
        if (!this.selectionCount()) return
        this.history.snapshot(this.document)
        const offset = 24
        const strokes = this.document.strokes
            .filter((stroke) => this.selectedStrokeIds.has(stroke.id))
            .map((stroke) => ({
                ...stroke,
                id: newId(),
                points: stroke.points.map((point) => ({ ...point, x: point.x + offset, y: point.y + offset })),
            }))
        const shapes = this.document.shapes
            .filter((shape) => this.selectedShapeIds.has(shape.id))
            .map((shape) => ({
                ...shape,
                id: newId(),
                start: { x: shape.start.x + offset, y: shape.start.y + offset },
                end: { x: shape.end.x + offset, y: shape.end.y + offset },
            }))
        this.document.strokes.push(...strokes)
        this.document.shapes.push(...shapes)
        this.selectedStrokeIds = new Set(strokes.map((stroke) => stroke.id))
        this.selectedShapeIds = new Set(shapes.map((shape) => shape.id))
        this.renderer?.invalidate()
        this.render()
        this.notifySelection()
        this.markDirty()
    }

    applyColorToSelection(): void {
        if (!this.selectionCount()) return
        this.history.snapshot(this.document)
        this.document.strokes = this.document.strokes.map((stroke) => this.selectedStrokeIds.has(stroke.id) ? { ...stroke, color: this.color } : stroke)
        this.document.shapes = this.document.shapes.map((shape) => this.selectedShapeIds.has(shape.id) ? { ...shape, color: this.color } : shape)
        this.renderer?.invalidate()
        this.render()
        this.markDirty()
    }

    convertSelection(type: 'line' | 'rectangle' | 'ellipse'): void {
        const selected = this.document.strokes.filter((stroke) => this.selectedStrokeIds.has(stroke.id))
        if (!selected.length) return
        this.history.snapshot(this.document)
        const shapes: InkShape[] = []
        for (const stroke of selected) {
            const start = stroke.points[0]
            const end = lastOf(stroke.points)
            const bounds = boundsOf(stroke.points)
            if (!start || !end || !bounds) continue
            shapes.push(type === 'line'
                ? { id: newId(), type, color: stroke.color, width: stroke.width, link: stroke.link, start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } }
                : { id: newId(), type, color: stroke.color, width: stroke.width, link: stroke.link, start: { x: bounds.left, y: bounds.top }, end: { x: bounds.right, y: bounds.bottom } })
        }
        this.document.strokes = this.document.strokes.filter((stroke) => !this.selectedStrokeIds.has(stroke.id))
        this.document.shapes.push(...shapes)
        this.selectedStrokeIds.clear()
        this.selectedShapeIds = new Set([...this.selectedShapeIds, ...shapes.map((shape) => shape.id)])
        this.renderer?.invalidate()
        this.render()
        this.notifySelection()
        this.markDirty()
    }

    linkSelection(link: string | null): void {
        if (link === null || !this.selectionCount()) return
        const trimmed = link.trim()
        if (trimmed && classifyInkLink(trimmed).kind === 'invalid') return
        this.history.snapshot(this.document)
        const value = trimmed || undefined
        this.document.strokes = this.document.strokes.map((stroke) => this.selectedStrokeIds.has(stroke.id) ? { ...stroke, link: value } : stroke)
        this.document.shapes = this.document.shapes.map((shape) => this.selectedShapeIds.has(shape.id) ? { ...shape, link: value } : shape)
        this.notifySelection()
        this.markDirty()
    }

    openSelectionLink(): void {
        const link = this.document.strokes.find((stroke) => this.selectedStrokeIds.has(stroke.id) && stroke.link)?.link
            ?? this.document.shapes.find((shape) => this.selectedShapeIds.has(shape.id) && shape.link)?.link
        if (!link) return
        const target = classifyInkLink(link)
        if (target.kind === 'url') this.host.openUrl(target.url)
        else if (target.kind === 'note') this.host.openNote(target.note)
    }

    addBookmark(name: string): void {
        const trimmed = name.trim().slice(0, 80)
        if (!trimmed) return
        this.history.snapshot(this.document)
        this.document.bookmarks = [...(this.document.bookmarks ?? []), { id: newId(), name: trimmed, ...this.transform }]
        this.markDirty()
    }

    goToBookmark(id: string): void {
        const bookmark = this.document.bookmarks?.find((item) => item.id === id)
        if (!bookmark) return
        this.transform = { x: bookmark.x, y: bookmark.y, zoom: bookmark.zoom }
        this.render()
        this.host.onViewportChange(this.transform.zoom)
        this.markDirty()
    }

    deleteBookmark(id: string): void {
        if (!this.document.bookmarks?.some((item) => item.id === id)) return
        this.history.snapshot(this.document)
        this.document.bookmarks = this.document.bookmarks.filter((item) => item.id !== id)
        this.markDirty()
    }

    insertNote(note: { id: string; title: string }): void {
        const center = this.viewportCenter()
        this.insertElement({
            id: newId(), kind: 'markdown', path: note.title, noteId: note.id,
            x: center.x - 220, y: center.y - 180, width: 440, height: 360,
        })
    }

    insertFile(file: { id: string; filename: string; mime: string; url: string }): void {
        const kind = kindFromMime(file.mime, file.filename)
        if (!kind) {
            this.host.onError('unsupported_file')
            return
        }
        const center = this.viewportCenter()
        const size = kind === 'pdf' ? { width: 560, height: 720 } : kind === 'image' ? { width: 480, height: 360 } : { width: 440, height: 100 }
        const url = file.url.startsWith('/api/files/') ? file.url : `/api/files/${encodeURIComponent(file.id)}`
        this.insertElement({
            id: newId(), kind, path: file.filename, fileId: file.id, url, mime: file.mime,
            x: center.x - size.width / 2, y: center.y - size.height / 2, ...size,
        })
    }

    insertText(text: string): void {
        const value = text.trim()
        if (!value) return
        const center = this.viewportCenter()
        this.insertElement({
            id: newId(), kind: 'text', path: '', text: value,
            x: center.x - 160, y: center.y - 50, width: 320, height: 100,
        })
    }

    removeElement(id: string): void {
        if (!this.document.elements.some((element) => element.id === id)) return
        this.history.snapshot(this.document)
        this.document.elements = this.document.elements.filter((element) => element.id !== id)
        this.afterElementChange()
    }

    toggleElementLock(id: string): void {
        const element = this.document.elements.find((item) => item.id === id)
        if (!element) return
        this.history.snapshot(this.document)
        element.locked = !element.locked
        this.afterElementChange()
    }

    bringElementToFront(id: string): void {
        const index = this.document.elements.findIndex((item) => item.id === id)
        if (index < 0 || index === this.document.elements.length - 1) return
        this.history.snapshot(this.document)
        const [element] = this.document.elements.splice(index, 1)
        if (!element) return
        this.document.elements.push(element)
        this.afterElementChange()
    }

    sendElementToBack(id: string): void {
        const index = this.document.elements.findIndex((item) => item.id === id)
        if (index <= 0) return
        this.history.snapshot(this.document)
        const [element] = this.document.elements.splice(index, 1)
        if (!element) return
        this.document.elements.unshift(element)
        this.afterElementChange()
    }

    patchElement(
        id: string,
        patch: Partial<Pick<InkElement, 'noteId' | 'fileId' | 'url' | 'mime' | 'text' | 'aspectRatio' | 'fitPdfPages' | 'height' | 'pageCount' | 'pageAspect'>>,
        options: { history?: boolean } = {},
    ): void {
        const element = this.document.elements.find((item) => item.id === id)
        if (!element) return
        const keys = Object.keys(patch) as Array<keyof typeof patch>
        const changed = keys.some((key) => patch[key] !== undefined && element[key] !== patch[key])
        if (!changed) return
        if (options.history) this.history.snapshot(this.document)
        for (const key of keys) {
            const value = patch[key]
            if (value === undefined) continue
            ;(element as unknown as Record<string, unknown>)[key] = value
        }
        this.afterElementChange()
    }

    startElementGesture(id: string, mode: 'move' | 'resize', event: PointerEvent, captureTarget: HTMLElement): void {
        const element = this.document.elements.find((item) => item.id === id)
        if (!element || element.locked || this.elementGesture) return
        event.preventDefault()
        event.stopPropagation()
        this.history.snapshot(this.document)
        captureTarget.setPointerCapture?.(event.pointerId)
        this.elementGesture = {
            id,
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startX: element.x,
            startY: element.y,
            startWidth: element.width,
            startHeight: element.height,
            mode,
        }
        const move = (moveEvent: PointerEvent): void => this.moveElementGesture(moveEvent)
        const end = (endEvent: PointerEvent): void => {
            if (endEvent.pointerId !== event.pointerId) return
            captureTarget.removeEventListener('pointermove', move)
            captureTarget.removeEventListener('pointerup', end)
            captureTarget.removeEventListener('pointercancel', end)
            this.elementGesture = null
            this.markDirty()
        }
        captureTarget.addEventListener('pointermove', move)
        captureTarget.addEventListener('pointerup', end)
        captureTarget.addEventListener('pointercancel', end)
    }

    moveElementBy(id: string, dx: number, dy: number): void {
        const element = this.document.elements.find((item) => item.id === id)
        if (!element || element.locked) return
        this.history.snapshot(this.document)
        element.x += dx
        element.y += dy
        this.layoutElements()
        this.markDirty()
    }

    resizeElementBy(id: string, dx: number, dy: number): void {
        const element = this.document.elements.find((item) => item.id === id)
        if (!element || element.locked) return
        this.history.snapshot(this.document)
        this.applyResize(element, element.width + dx, element.height + dy)
        this.layoutElements()
        this.markDirty()
    }

    exportSvgString(): string | null {
        if (!this.document.strokes.length && !this.document.shapes.length) return null
        return buildInkSvg(this.document, this.host.settings().pressureResponse)
    }

    exportPngBlob(): Promise<Blob | null> {
        return renderInkPng(this.document, this.host.settings().pressureResponse)
    }

    exportSelectionPngBlob(): Promise<Blob | null> {
        const bounds = this.selectionBoundsNow()
        if (!bounds) return Promise.resolve(null)
        return renderSelectionPng(
            this.document,
            bounds,
            this.selectedStrokeIds,
            this.selectedShapeIds,
            this.host.settings().pressureResponse,
        )
    }

    private viewportCenter(): InkPoint {
        const size = this.renderer?.logicalSize() ?? { width: 1, height: 1 }
        return {
            x: (size.width / 2 - this.transform.x) / this.transform.zoom,
            y: (size.height / 2 - this.transform.y) / this.transform.zoom,
            p: 0.5,
            t: 0,
        }
    }

    private insertElement(element: InkElement): void {
        this.history.snapshot(this.document)
        this.document.elements.push(element)
        this.afterElementChange()
    }

    private afterElementChange(): void {
        this.host.onElementsChange()
        this.layoutElements()
        this.markDirty()
    }

    private moveElementGesture(event: PointerEvent): void {
        const gesture = this.elementGesture
        if (!gesture || event.pointerId !== gesture.pointerId) return
        event.preventDefault()
        event.stopPropagation()
        const element = this.document.elements.find((item) => item.id === gesture.id)
        if (!element) return
        const dx = (event.clientX - gesture.startClientX) / this.transform.zoom
        const dy = (event.clientY - gesture.startClientY) / this.transform.zoom
        if (gesture.mode === 'move') {
            element.x = gesture.startX + dx
            element.y = gesture.startY + dy
        } else if (element.kind === 'image') {
            const aspect = element.aspectRatio ?? gesture.startWidth / gesture.startHeight
            const widthDelta = Math.abs(dx) >= Math.abs(dy * aspect) ? dx : dy * aspect
            this.applyResize(element, gesture.startWidth + widthDelta, gesture.startHeight, aspect)
        } else {
            this.applyResize(element, gesture.startWidth + dx, gesture.startHeight + dy)
        }
        this.layoutElements()
    }

    private applyResize(element: InkElement, width: number, height: number, fixedAspect?: number): void {
        if (element.kind === 'image') {
            const aspect = fixedAspect ?? element.aspectRatio ?? (element.height ? element.width / element.height : 1)
            element.width = Math.max(100, width)
            element.height = element.width / aspect
            return
        }
        element.width = Math.max(160, width)
        element.height = Math.max(120, height)
        element.fitPdfPages = false
    }

    private resize(): void {
        const host = this.hostEl
        const renderer = this.renderer
        if (!host || !renderer) return
        const rect = host.getBoundingClientRect()
        renderer.resize({ width: rect.width, height: rect.height }, navigator.userAgent.includes('Windows'))
        this.render()
    }

    private render(): void {
        const renderer = this.renderer
        if (!renderer) {
            this.layoutElements()
            return
        }
        const selection = this.selectionBoundsNow()
        renderer.render(
            this.document,
            this.transform,
            this.host.settings(),
            this.activeStroke,
            this.activeShape,
            this.lassoPoints,
            selection,
            this.selectionMove !== null,
        )
        this.layoutElements()
    }

    private requestNavigationRender(zoomChanged: boolean): void {
        this.navigationZoomChanged ||= zoomChanged
        if (this.navigationFrame !== null) return
        this.navigationFrame = requestAnimationFrame(() => {
            this.navigationFrame = null
            this.render()
            if (this.navigationZoomChanged) this.host.onViewportChange(this.transform.zoom)
            this.navigationZoomChanged = false
        })
    }

    private markDirty(): void {
        this.host.onDirty()
    }

    private markViewportDirty(): void {
        if (this.viewportDirtyTimer !== null) window.clearTimeout(this.viewportDirtyTimer)
        this.viewportDirtyTimer = window.setTimeout(() => {
            this.viewportDirtyTimer = null
            this.markDirty()
        }, VIEWPORT_DIRTY_DELAY_MS)
    }

    private clearSelection(): void {
        this.selectedStrokeIds.clear()
        this.selectedShapeIds.clear()
        this.host.onSelectionChange(0, false)
    }

    private notifySelection(): void {
        this.host.onSelectionChange(this.selectionCount(), this.hasSelectionLink())
    }

    private selectionBoundsNow(): InkBounds | null {
        if (!this.selectionCount()) return null
        return selectionBounds(this.document, this.selectedStrokeIds, this.selectedShapeIds)
    }

    private pointInSelection(point: InkPoint): boolean {
        const bounds = this.selectionBoundsNow()
        return Boolean(bounds
            && point.x >= bounds.left - 12
            && point.x <= bounds.right + 12
            && point.y >= bounds.top - 12
            && point.y <= bounds.bottom + 12)
    }

    private applyLasso(): void {
        const selected = selectLasso(this.document, this.lassoPoints)
        this.selectedStrokeIds = selected.strokeIds
        this.selectedShapeIds = selected.shapeIds
        this.lassoPoints = []
        this.notifySelection()
        this.render()
    }

    private pressure(): 'fixed' | 'subtle' | 'natural' {
        return this.host.settings().pressureResponse
    }

    private toPoint(event: PointerEvent | WheelEvent): InkPoint {
        const canvas = this.canvas!
        const rect = canvas.getBoundingClientRect()
        const world = toWorldPoint(event.clientX, event.clientY, rect, this.transform)
        return {
            x: world.x,
            y: world.y,
            p: 'pressure' in event && event.pressure > 0 ? event.pressure : 0.5,
            t: event.timeStamp,
        }
    }

    private appendPoint(stroke: InkStroke, point: InkPoint): boolean {
        const previous = lastOf(stroke.points)
        if (!canAcceptPoint(previous, point, this.transform.zoom)) return false
        point.p = filterPressure(previous?.p, point.p)
        stroke.points.push(point)
        return true
    }

    private handlePointerDown(event: PointerEvent): void {
        if (isPenBarrelPress(event) || (event.pointerType === 'mouse' && event.button === 2)) {
            event.preventDefault()
            this.host.onQuickMenu(event.clientX, event.clientY)
            return
        }
        event.preventDefault()
        this.canvas?.focus({ preventScroll: true })
        this.canvas?.setPointerCapture?.(event.pointerId)
        this.pointers.set(event.pointerId, event)
        if (isMiddleButton(event)) {
            this.activePointer = null
            this.panPointer = event.pointerId
            this.panStart = { x: event.clientX, y: event.clientY, transform: { ...this.transform } }
            return
        }
        if (this.pointers.size >= 2 || event.pointerType === 'touch') {
            this.activePointer = null
            if (this.pointers.size >= 2) this.beginPinch()
            else {
                this.panPointer = event.pointerId
                this.panStart = { x: event.clientX, y: event.clientY, transform: { ...this.transform } }
            }
            return
        }
        this.activePointer = event.pointerId
        const first = this.toPoint(event)
        if (this.tool === 'lasso') {
            if (this.pointInSelection(first)) {
                this.history.snapshot(this.document)
                this.selectionMove = {
                    start: first,
                    strokes: this.document.strokes.filter((stroke) => this.selectedStrokeIds.has(stroke.id)).map((stroke) => ({ ...stroke, points: stroke.points.map((point) => ({ ...point })) })),
                    shapes: this.document.shapes.filter((shape) => this.selectedShapeIds.has(shape.id)).map((shape) => ({ ...shape, start: { ...shape.start }, end: { ...shape.end } })),
                }
                return
            }
            this.clearSelection()
            this.lassoPoints = [first]
            this.render()
            return
        }
        if (SHAPE_TOOLS.has(this.tool)) {
            this.history.snapshotForAppend(this.document)
            this.activeShape = {
                id: newId(),
                type: this.tool as InkShape['type'],
                color: this.color,
                width: this.width,
                start: { x: first.x, y: first.y },
                end: { x: first.x, y: first.y },
            }
            this.document.shapes.push(this.activeShape)
            this.render()
            return
        }
        if (this.tool === 'eraser') {
            this.history.snapshot(this.document)
            this.eraseAt(first)
            return
        }
        if (!BRUSH_TOOLS.has(this.tool)) return
        this.history.snapshotForAppend(this.document)
        this.activeStroke = {
            id: newId(),
            tool: this.tool,
            color: this.color,
            width: this.width,
            points: [first],
        }
        this.document.strokes.push(this.activeStroke)
        this.render()
    }

    private handlePointerMove(event: PointerEvent): void {
        if (!this.pointers.has(event.pointerId)) return
        event.preventDefault()
        this.pointers.set(event.pointerId, event)
        if (this.pinchStart && this.pointers.size >= 2) {
            this.updatePinch()
            return
        }
        if (this.activePointer === event.pointerId && this.selectionMove) {
            const point = this.toPoint(event)
            const dx = point.x - this.selectionMove.start.x
            const dy = point.y - this.selectionMove.start.y
            for (const original of this.selectionMove.strokes) {
                const stroke = this.document.strokes.find((item) => item.id === original.id)
                if (stroke) stroke.points = original.points.map((item) => ({ ...item, x: item.x + dx, y: item.y + dy }))
            }
            for (const original of this.selectionMove.shapes) {
                const shape = this.document.shapes.find((item) => item.id === original.id)
                if (shape) {
                    shape.start = { x: original.start.x + dx, y: original.start.y + dy }
                    shape.end = { x: original.end.x + dx, y: original.end.y + dy }
                }
            }
            this.render()
            return
        }
        if (this.activePointer === event.pointerId && this.lassoPoints.length) {
            this.lassoPoints.push(this.toPoint(event))
            this.render()
            return
        }
        if (this.activePointer === event.pointerId && this.activeShape) {
            this.activeShape.end = this.toPoint(event)
            this.render()
            return
        }
        if (this.activePointer === event.pointerId && this.tool === 'eraser') {
            let changed = false
            for (const sample of coalescedPointerEvents(event)) changed = this.eraseAt(this.toPoint(sample), false) || changed
            if (changed) this.render()
            return
        }
        if (this.activePointer === event.pointerId && this.activeStroke) {
            let first: InkPoint | null = null
            const added: InkPoint[] = []
            for (const sample of coalescedPointerEvents(event)) {
                const before = lastOf(this.activeStroke.points)
                const point = this.toPoint(sample)
                if (this.appendPoint(this.activeStroke, point) && before) {
                    first ??= before
                    added.push(point)
                }
            }
            if (first && added.length) {
                if (event.pointerType === 'mouse') this.queueMouseInk(this.activeStroke, first, added)
                else this.renderer?.drawCoalescedSegment(this.activeStroke, first, added, this.transform, this.pressure())
            }
            return
        }
        if (this.panStart && this.panPointer === event.pointerId) {
            this.transform.x = this.panStart.transform.x + (event.clientX - this.panStart.x)
            this.transform.y = this.panStart.transform.y + (event.clientY - this.panStart.y)
            this.requestNavigationRender(false)
        }
    }

    private handlePointerUp(event: PointerEvent): void {
        if (!this.pointers.has(event.pointerId)) return
        event.preventDefault()
        const wasNavigating = event.pointerId === this.panPointer || this.pinchStart !== null
        this.pointers.delete(event.pointerId)
        if (event.pointerId === this.panPointer) this.panPointer = null
        if (event.pointerId === this.activePointer && this.selectionMove) {
            this.selectionMove = null
            this.activePointer = null
            this.renderer?.invalidate()
            this.render()
            this.markDirty()
        } else if (event.pointerId === this.activePointer && this.lassoPoints.length) {
            this.lassoPoints.push(this.toPoint(event))
            this.applyLasso()
            this.activePointer = null
        } else if (event.pointerId === this.activePointer && this.activeShape) {
            this.activeShape.end = this.toPoint(event)
            const completed = this.activeShape
            this.activeShape = null
            this.activePointer = null
            if (!this.renderer?.commitInk(undefined, completed, this.transform, this.pressure())) this.renderer?.invalidate()
            this.render()
            this.markDirty()
        } else if (event.pointerId === this.activePointer && this.tool === 'eraser') {
            this.eraseAt(this.toPoint(event))
            this.activePointer = null
            this.renderer?.invalidate()
            this.render()
            this.markDirty()
        } else if (event.pointerId === this.activePointer && this.activeStroke) {
            this.flushMouseInk()
            const before = lastOf(this.activeStroke.points)
            const point = this.toPoint(event)
            if (this.appendPoint(this.activeStroke, point) && before) this.renderer?.drawSegment(this.activeStroke, before, point, this.transform, this.pressure())
            const completed = this.activeStroke
            this.activeStroke = null
            this.activePointer = null
            if (!this.renderer?.commitInk(completed, undefined, this.transform, this.pressure())) this.renderer?.invalidate()
            this.render()
            this.markDirty()
        }
        if (this.pointers.size < 2) {
            this.pinchStart = null
            const remaining = this.pointers.values().next().value as PointerEvent | undefined
            if (remaining?.pointerType === 'touch') {
                this.panPointer = remaining.pointerId
                this.panStart = { x: remaining.clientX, y: remaining.clientY, transform: { ...this.transform } }
            } else {
                this.panStart = null
            }
        }
        if (wasNavigating) this.markViewportDirty()
    }

    private beginPinch(): void {
        const pair = [...this.pointers.values()].filter((pointer) => pointer.pointerType === 'touch').slice(0, 2)
        if (pair.length !== 2) return
        const first = pair[0]!
        const second = pair[1]!
        const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY)
        if (!distance) return
        this.panStart = null
        this.panPointer = null
        this.pinchStart = {
            distance,
            centerX: (first.clientX + second.clientX) / 2,
            centerY: (first.clientY + second.clientY) / 2,
            transform: { ...this.transform },
        }
    }

    private updatePinch(): void {
        const start = this.pinchStart
        const pair = [...this.pointers.values()].filter((pointer) => pointer.pointerType === 'touch').slice(0, 2)
        if (!start || pair.length !== 2) return
        const rect = this.canvas!.getBoundingClientRect()
        this.transform = pinchTransform(start, pair[0]!, pair[1]!, rect)
        this.requestNavigationRender(true)
    }

    private handleWheel(event: WheelEvent): void {
        event.preventDefault()
        const canvas = this.canvas
        if (!canvas) return
        const rect = canvas.getBoundingClientRect()
        const factor = Math.exp(-event.deltaY * 0.0015)
        this.transform = zoomAt(this.transform, { x: event.clientX, y: event.clientY }, factor, rect)
        this.requestNavigationRender(true)
        this.markViewportDirty()
    }

    private handleKeyDown(event: KeyboardEvent): void {
        if (event.metaKey || event.ctrlKey) {
            if (event.key.toLowerCase() === 'z') {
                event.preventDefault()
                if (event.shiftKey) this.redo()
                else this.undo()
            } else if (event.key.toLowerCase() === 'y') {
                event.preventDefault()
                this.redo()
            }
            return
        }
        const key = event.key.toLowerCase()
        const tools: Record<string, InkTool> = { p: 'pen', b: 'pencil', m: 'marker', h: 'highlighter', e: 'eraser', l: 'lasso' }
        const tool = tools[key]
        if (tool) {
            event.preventDefault()
            this.setTool(tool)
            return
        }
        if (key === 'f') {
            event.preventDefault()
            if (!this.frameContent()) this.host.onError('empty_content')
            return
        }
        if (key === '0') {
            event.preventDefault()
            this.resetZoom()
        }
    }

    private handleWindowBlur(): void {
        this.flushMouseInk()
        if (this.activeStroke) {
            this.activeStroke = null
            this.renderer?.invalidate()
        }
        if (this.activeShape) {
            this.activeShape = null
            this.renderer?.invalidate()
        }
        this.selectionMove = null
        this.activePointer = null
        this.pointers.clear()
        this.panStart = null
        this.pinchStart = null
        this.panPointer = null
        this.render()
        this.markDirty()
    }

    private queueMouseInk(stroke: InkStroke, first: InkPoint, points: InkPoint[]): void {
        const pending = this.pendingMouseInk
        if (pending && pending.stroke === stroke) pending.points.push(...points)
        else this.pendingMouseInk = { stroke, first, points: [...points] }
        if (this.mouseFrame !== null) return
        this.mouseFrame = requestAnimationFrame(() => {
            this.mouseFrame = null
            this.flushMouseInk()
        })
    }

    private flushMouseInk(): void {
        const pending = this.pendingMouseInk
        this.pendingMouseInk = null
        if (pending?.points.length) {
            this.renderer?.drawCoalescedSegment(pending.stroke, pending.first, pending.points, this.transform, this.pressure())
        }
    }

    private eraseAt(point: InkPoint, redraw = true): boolean {
        const radius = Math.max(10, this.width * 3)
        let changed = false
        const result: InkStroke[] = []
        for (const stroke of this.document.strokes) {
            let fragment: InkPoint[] = []
            for (const sample of stroke.points) {
                if (Math.hypot(sample.x - point.x, sample.y - point.y) > radius + stroke.width / 2) {
                    fragment.push(sample)
                } else {
                    if (fragment.length) result.push({ ...stroke, id: `${stroke.id}-${result.length}`, points: fragment })
                    fragment = []
                    changed = true
                }
            }
            if (fragment.length) result.push({ ...stroke, points: fragment })
        }
        if (changed) {
            this.document.strokes = result
            this.renderer?.invalidate()
            if (redraw) this.render()
        }
        return changed
    }
}


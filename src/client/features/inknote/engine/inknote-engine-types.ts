/**
 * The frozen boundary between the Inknote engine and its React host.
 *
 * The engine owns the canvas, pointer state and the one mutable page object; the host owns the page
 * stack, saving and history. Everything crossing this boundary is synchronous and already in display
 * or content units as documented below. This module contains types only.
 */
import type {
  InknotePageContent,
  InknotePaper,
  InknotePenStyle,
  InknoteShapeTool,
  InknoteTool,
} from '@shared/inknote/types'

export interface InknoteViewport {
  scale: number
  offsetX: number
  offsetY: number
}

/** Paper size and the content canvas it renders, both in page units. */
export interface InknotePageMetrics {
  width: number
  height: number
  contentWidth: number
  contentHeight: number
}

export interface InknoteToolState {
  tool: InknoteTool
  color: string
  width: number
  style: InknotePenStyle
  shape: InknoteShapeTool
  eraserSize: number
  eraserMode: 'stroke' | 'pixel'
}

export type InknoteContentChangeReason = 'stroke' | 'erase' | 'pixel-erase' | 'shape' | 'move' | 'scale' | 'text'
export type InknoteGestureAction = 'undo' | 'redo' | 'page-prev' | 'page-next'

export interface InknoteEngineHost {
  getPage(): InknotePageContent
  getPaper(): InknotePaper
  getPageMetrics(): InknotePageMetrics
  getFont(): string
  getTool(): InknoteToolState
  /** High frequency: bump a version and mark the page dirty; never await, serialize or setState here. */
  onContentChange(reason: InknoteContentChangeReason): void
  /** One atomic edit finished; both strings are serialized page snapshots for history. */
  onCommit(before: string, after: string, label: string): void
  onTextTap(world: { x: number; y: number }): void
  onSelectionChange(ids: string[]): void
  onGesture(action: InknoteGestureAction): void
  onAutoPage(): void
  onViewportChange(zoom: number): void
}

export interface InknoteEngine {
  mount(canvas: HTMLCanvasElement, host: InknoteEngineHost): void
  destroy(): void
  setPage(page: InknotePageContent, paper: InknotePaper, metrics: InknotePageMetrics): void
  setTool(tool: InknoteToolState): void
  setFont(font: string): void
  refreshPaper(): void
  invalidate(): void
  fitView(): void
  zoomAt(clientX: number, clientY: number, factor: number): void
  frameContent(): boolean
  selectionIds(): string[]
  clearSelection(): void
  applyContent(content: InknotePageContent): void
  /** Swap in a page object the host rebuilt; keeps the viewport and drops history tied to the old object. */
  loadContent(content: InknotePageContent): void
  /** Recording replay locks editing; only the host may still replace page content. */
  setPlaybackLock(locked: boolean): void
  destroyRecordingReplay(): void
}

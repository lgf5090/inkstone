/**
 * Canvas painting for the Inknote engine, thumbnails and exports.
 *
 * Everything here is pure canvas: no React, no engine state, no network. Callers pass a page, its
 * paper and metrics; strokes are converted from content units to the paper's display units at draw
 * time. The same functions therefore serve the live engine, page thumbnails and PDF/PNG export.
 */
import { paperSurfaceFor } from '@shared/inknote/color'
import {
  INKNOTE_PAGE_HEIGHT,
  INKNOTE_PAGE_WIDTH,
  type InknotePaperSurface,
} from '@shared/inknote/constants'
import type {
  InknotePageBackground,
  InknotePageContent,
  InknotePaper,
  InknoteShapeKind,
  InknoteStroke,
  InknoteTextBox,
} from '@shared/inknote/types'
import { fromContentPoint, type ContentMetrics, type Point } from '../../../lib/inknote/geometry'
import {
  PAPER_MARGIN_X,
  PAPER_MUSIC_STAFF_STEP,
  paperGridStep,
  paperLineStep,
} from '../../../lib/inknote/paper'
import {
  HIGHLIGHTER_ALPHA,
  HIGHLIGHTER_WIDTH_FACTOR,
  strokeBaseWidth,
  strokeWidthAt,
  traceHighlighterPath,
  traceSmoothPath,
} from '../../../lib/inknote/stroke-math'
import { layoutTextBox } from '../../../lib/inknote/text-layout'

export const RENDER_SCALE = 2.5
export const MAX_RASTER_PIXELS = 16_000_000
export const IMAGE_CACHE_LIMIT = 20

const NOISE_SIZE = 256
const NOISE_FIBERS = 5
const CORNELL_NOTES_WIDTH = 252
const CORNELL_SUMMARY_TOP = 824
const CHECK_BOX_X = 20
const CHECK_BOX_SIZE = 22
const CHECK_LINE_X = 58
const CHECK_BOX_OFFSET = 30
const CHECK_LINE_OFFSET = 19
const PLANNER_COLUMNS = 7
const PLANNER_HEADER_Y = 76
const STORY_ROWS = 3
const STORY_COLUMNS = 2
const STORY_MARGIN = 10
const STORY_CAPTION = 46
const MUSIC_TOP = 60
const MUSIC_LINES = 5
const MUSIC_LINE_STEP = 11
const LEGAL_NUMBER_X = 16
const TEXT_HIGHLIGHT_ALPHA = 0.45
const TEXT_LINE_BOX_FACTOR = 1.18

export interface InknoteCanvasBudget {
  /** Pixel scale that honours the requested ratio and the raster pixel ceiling. */
  scale: number
  width: number
  height: number
}

/**
 * Clamp an off-screen raster to a pixel budget, reducing its scale rather than allocating hundreds
 * of megabytes for a very large page on a high-DPR display.
 */
export function inknoteCanvasBudget(
  width: number,
  height: number,
  ratio: number = RENDER_SCALE,
  maxPixels: number = MAX_RASTER_PIXELS,
): InknoteCanvasBudget {
  const logicalWidth = Number.isFinite(width) && width > 0 ? width : 1
  const logicalHeight = Number.isFinite(height) && height > 0 ? height : 1
  const requested = Number.isFinite(ratio) && ratio > 0 ? ratio : 1
  const ceiling = Number.isFinite(maxPixels) && maxPixels > 0 ? maxPixels : MAX_RASTER_PIXELS
  const limit = Math.sqrt(ceiling / (logicalWidth * logicalHeight))
  const scale = Math.max(0.01, Math.min(requested, limit))
  return {
    scale,
    width: Math.max(1, Math.floor(logicalWidth * scale)),
    height: Math.max(1, Math.floor(logicalHeight * scale)),
  }
}

let noiseCanvas: HTMLCanvasElement | null = null
let noiseUnavailable = false

/** A 256 px tiled paper grain, built once per page-lifetime instead of once per raster. */
function paperNoise(): HTMLCanvasElement | null {
  if (noiseCanvas || noiseUnavailable) return noiseCanvas
  if (typeof document === 'undefined') {
    noiseUnavailable = true
    return null
  }
  const canvas = document.createElement('canvas')
  canvas.width = NOISE_SIZE
  canvas.height = NOISE_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    noiseUnavailable = true
    return null
  }
  // A test canvas or an unusual browser context may lack ImageData; grain is cosmetic and the
  // ruling below it is still complete, so the renderer continues without it.
  if (typeof ctx.createImageData === 'function' && typeof ctx.putImageData === 'function') {
    const image = ctx.createImageData(NOISE_SIZE, NOISE_SIZE)
    for (let index = 0; index < image.data.length; index += 4) {
      const value = 128 + (Math.random() * 44 - 22)
      image.data[index] = value
      image.data[index + 1] = value
      image.data[index + 2] = value
      image.data[index + 3] = Math.random() * 26
    }
    ctx.putImageData(image, 0, 0)
  }
  ctx.globalCompositeOperation = 'lighter'
  for (let fiber = 0; fiber < NOISE_FIBERS; fiber++) {
    ctx.strokeStyle = `rgba(200,190,170,${0.03 + Math.random() * 0.04})`
    ctx.lineWidth = 1
    ctx.beginPath()
    const startY = Math.random() * NOISE_SIZE
    ctx.moveTo(0, startY)
    ctx.bezierCurveTo(
      64,
      startY + (Math.random() * 10 - 5),
      192,
      startY + (Math.random() * 10 - 5),
      NOISE_SIZE,
      startY + (Math.random() * 8 - 4),
    )
    ctx.stroke()
  }
  ctx.globalCompositeOperation = 'source-over'
  noiseCanvas = canvas
  return canvas
}

/** Paint the paper surface and its ten ruling styles. Coordinates are display units. */
export function drawPaper(ctx: CanvasRenderingContext2D, paper: InknotePaper, width: number, height: number): InknotePaperSurface {
  const surface = paperSurfaceFor(paper.color)
  ctx.save()
  ctx.fillStyle = surface.bg
  ctx.fillRect(0, 0, width, height)

  const line = paperLineStep('line', paper.spacing)
  const grid = paperGridStep(paper.spacing)
  ctx.strokeStyle = surface.line
  ctx.lineWidth = 1

  switch (paper.style) {
    case 'blank':
      break
    case 'line': {
      ctx.beginPath()
      for (let y = line; y < height; y += line) {
        ctx.moveTo(0, y)
        ctx.lineTo(width, y)
      }
      ctx.stroke()
      if (PAPER_MARGIN_X < width) {
        ctx.lineWidth = 1.4
        ctx.beginPath()
        ctx.moveTo(PAPER_MARGIN_X, 0)
        ctx.lineTo(PAPER_MARGIN_X, height)
        ctx.stroke()
      }
      break
    }
    case 'grid': {
      ctx.strokeStyle = surface.grid
      ctx.beginPath()
      for (let y = grid; y < height; y += grid) {
        ctx.moveTo(0, y)
        ctx.lineTo(width, y)
      }
      for (let x = grid; x < width; x += grid) {
        ctx.moveTo(x, 0)
        ctx.lineTo(x, height)
      }
      ctx.stroke()
      break
    }
    case 'dot': {
      ctx.fillStyle = surface.dot
      for (let y = grid; y < height; y += grid) {
        for (let x = grid; x < width; x += grid) {
          ctx.beginPath()
          ctx.arc(x, y, 1.4, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      break
    }
    case 'cornell': {
      const divider = Math.min(CORNELL_NOTES_WIDTH, width / 2)
      const summaryTop = Math.min(CORNELL_SUMMARY_TOP, height - line)
      ctx.beginPath()
      for (let y = line; y < summaryTop; y += line) {
        ctx.moveTo(divider, y)
        ctx.lineTo(width, y)
      }
      for (let y = line; y < height; y += line) {
        ctx.moveTo(0, y)
        ctx.lineTo(divider, y)
      }
      ctx.stroke()
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.moveTo(divider, 0)
      ctx.lineTo(divider, height)
      ctx.moveTo(0, summaryTop)
      ctx.lineTo(width, summaryTop)
      ctx.stroke()
      break
    }
    case 'check': {
      for (let y = line; y < height; y += line) {
        ctx.strokeRect(CHECK_BOX_X, y - CHECK_BOX_OFFSET, CHECK_BOX_SIZE, CHECK_BOX_SIZE)
        ctx.beginPath()
        ctx.moveTo(CHECK_LINE_X, y - CHECK_LINE_OFFSET)
        ctx.lineTo(width, y - CHECK_LINE_OFFSET)
        ctx.stroke()
      }
      break
    }
    case 'planner': {
      const columnWidth = width / PLANNER_COLUMNS
      ctx.beginPath()
      for (let index = 0; index <= PLANNER_COLUMNS; index++) {
        ctx.moveTo(index * columnWidth, 0)
        ctx.lineTo(index * columnWidth, height)
      }
      for (let y = PLANNER_HEADER_Y; y < height; y += grid * 2) {
        ctx.moveTo(0, y)
        ctx.lineTo(width, y)
      }
      ctx.stroke()
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.moveTo(0, PLANNER_HEADER_Y)
      ctx.lineTo(width, PLANNER_HEADER_Y)
      ctx.stroke()
      break
    }
    case 'story': {
      const cellWidth = width / STORY_COLUMNS
      const cellHeight = height / STORY_ROWS
      ctx.lineWidth = 1.4
      ctx.beginPath()
      for (let row = 0; row < STORY_ROWS; row++) {
        for (let column = 0; column < STORY_COLUMNS; column++) {
          ctx.rect(
            column * cellWidth + STORY_MARGIN,
            row * cellHeight + STORY_MARGIN,
            Math.max(1, cellWidth - STORY_MARGIN * 2),
            Math.max(1, cellHeight - STORY_MARGIN - STORY_CAPTION),
          )
        }
      }
      ctx.stroke()
      break
    }
    case 'music': {
      for (let y = MUSIC_TOP; y < height - 20; y += PAPER_MUSIC_STAFF_STEP) {
        ctx.beginPath()
        for (let index = 0; index < MUSIC_LINES; index++) {
          const staffY = y + index * MUSIC_LINE_STEP
          ctx.moveTo(0, staffY)
          ctx.lineTo(width, staffY)
        }
        ctx.stroke()
      }
      break
    }
    case 'legal': {
      ctx.fillStyle = surface.dot
      ctx.font = '10px sans-serif'
      ctx.textBaseline = 'middle'
      let number = 1
      for (let y = line; y < height; y += line) {
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(width, y)
        ctx.stroke()
        ctx.fillText(String(number), LEGAL_NUMBER_X, y - line / 2)
        number += 1
      }
      break
    }
    default:
      break
  }
  ctx.restore()

  drawPaperNoise(ctx, width, height, surface.dark)
  return surface
}

function drawPaperNoise(ctx: CanvasRenderingContext2D, width: number, height: number, dark: boolean): void {
  const noise = paperNoise()
  if (!noise || width <= 0 || height <= 0) return
  ctx.save()
  ctx.globalAlpha = dark ? 0.16 : 0.05
  ctx.globalCompositeOperation = dark ? 'screen' : 'multiply'
  for (let y = 0; y < height; y += noise.height) {
    for (let x = 0; x < width; x += noise.width) ctx.drawImage(noise, x, y)
  }
  ctx.restore()
}

interface ImageCacheEntry {
  image: HTMLImageElement
  status: 'loading' | 'loaded' | 'error'
  listeners: Set<(image: HTMLImageElement | null) => void>
}

const imageCache = new Map<string, ImageCacheEntry>()

function touchImage(url: string, entry: ImageCacheEntry): void {
  imageCache.delete(url)
  imageCache.set(url, entry)
}

function settleImage(entry: ImageCacheEntry, status: 'loaded' | 'error'): void {
  entry.status = status
  const value = status === 'loaded' ? entry.image : null
  for (const listener of entry.listeners) listener(value)
  entry.listeners.clear()
}

function evictImage(): void {
  if (imageCache.size < IMAGE_CACHE_LIMIT) return
  for (const [url, entry] of imageCache) {
    if (entry.status !== 'loading') {
      imageCache.delete(url)
      return
    }
  }
  const oldest = imageCache.keys().next().value
  if (oldest !== undefined) imageCache.delete(oldest)
}

/**
 * Return a loaded image, or start loading it and register a one-shot listener.
 *
 * Assets are same-origin `/api/inknote/assets/:id` URLs; the browser HTTP cache still applies, this
 * map only avoids a second decode and keeps the LRU bounded.
 */
function requestImage(url: string, listener?: (image: HTMLImageElement | null) => void): ImageCacheEntry | null {
  if (!url || typeof Image === 'undefined') return null
  const existing = imageCache.get(url)
  if (existing) {
    touchImage(url, existing)
    if (listener) {
      if (existing.status === 'loading') existing.listeners.add(listener)
      else listener(existing.status === 'loaded' ? existing.image : null)
    }
    return existing
  }

  evictImage()
  const image = new Image()
  const entry: ImageCacheEntry = { image, status: 'loading', listeners: new Set() }
  if (listener) entry.listeners.add(listener)
  image.onload = () => settleImage(entry, 'loaded')
  image.onerror = () => settleImage(entry, 'error')
  image.src = url
  imageCache.set(url, entry)
  return entry
}

/** Test/export hook: drop decoded images and listeners without touching the DOM. */
export function clearImageCache(): void {
  for (const entry of imageCache.values()) entry.listeners.clear()
  imageCache.clear()
}

/** Draw a background and the page images under the ink, requesting anything not decoded yet. */
export function drawPageMedia(
  ctx: CanvasRenderingContext2D,
  page: InknotePageContent,
  width: number,
  height: number,
  onReady?: () => void,
): void {
  if (page.bg) drawBackground(ctx, page.bg, width, height, onReady)
  for (const item of page.images) {
    const entry = requestImage(item.url, onReady)
    if (entry?.status === 'loaded') drawImageItem(ctx, item, entry.image, width, height)
    else if (entry?.status === 'error') drawMissingImage(ctx, item, width, height)
  }
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  background: InknotePageBackground,
  width: number,
  height: number,
  onReady?: () => void,
): void {
  const entry = requestImage(background.url, onReady)
  if (entry?.status !== 'loaded') return
  const alpha = Number.isFinite(background.alpha) ? Math.min(1, Math.max(0.1, background.alpha)) : 1
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.drawImage(entry.image, 0, 0, width, height)
  ctx.restore()
}

function drawImageItem(
  ctx: CanvasRenderingContext2D,
  item: InknotePageContent['images'][number],
  image: HTMLImageElement,
  width: number,
  height: number,
): void {
  const boxWidth = item.w * width
  const boxHeight = item.h * height
  const naturalWidth = image.naturalWidth || image.width || 1
  const naturalHeight = image.naturalHeight || image.height || 1
  const contain = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight) || 1
  const drawWidth = naturalWidth * contain
  const drawHeight = naturalHeight * contain
  const drawX = item.x * width + (boxWidth - drawWidth) / 2
  const drawY = item.y * height + (boxHeight - drawHeight) / 2

  ctx.save()
  if (item.rot) {
    ctx.translate(drawX + drawWidth / 2, drawY + drawHeight / 2)
    ctx.rotate((item.rot * Math.PI) / 180)
    ctx.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)
  } else {
    ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight)
  }
  ctx.restore()
}

function drawMissingImage(
  ctx: CanvasRenderingContext2D,
  item: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
): void {
  ctx.save()
  ctx.fillStyle = 'rgba(120,130,150,.10)'
  ctx.strokeStyle = 'rgba(120,130,150,.55)'
  ctx.lineWidth = 1.5
  ctx.setLineDash([6, 5])
  ctx.fillRect(item.x * width, item.y * height, item.w * width, item.h * height)
  ctx.strokeRect(item.x * width, item.y * height, item.w * width, item.h * height)
  ctx.restore()
}

/**
 * Paint one committed stroke. Stroke points live in content units; the width stored beside them is
 * also in content units, so both are mapped back to the paper before canvas calls are made.
 */
export function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: InknoteStroke,
  metrics: ContentMetrics,
  paper: InknotePaper,
): void {
  if (!stroke.points.length && !stroke.shape) return
  const points = stroke.points.map((point) => fromContentPoint(point, metrics))
  const width = Math.max(1.4, stroke.width * displayRatio(metrics))
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (stroke.shape) {
    drawShape(ctx, stroke.shape, points, stroke.color, width)
    ctx.restore()
    return
  }
  if (points.length === 1) {
    if (stroke.tool === 'highlighter') {
      const surface = paperSurfaceFor(paper.color)
      ctx.globalAlpha = HIGHLIGHTER_ALPHA
      ctx.globalCompositeOperation = surface.dark ? 'source-over' : 'multiply'
      drawDot(ctx, points[0]!, stroke.color, width * HIGHLIGHTER_WIDTH_FACTOR)
    } else {
      drawDot(ctx, points[0]!, stroke.color, width)
    }
    ctx.restore()
    return
  }
  if (stroke.tool === 'highlighter') {
    const surface = paperSurfaceFor(paper.color)
    ctx.globalAlpha = HIGHLIGHTER_ALPHA
    ctx.globalCompositeOperation = surface.dark ? 'source-over' : 'multiply'
    ctx.strokeStyle = stroke.color
    ctx.lineWidth = width * HIGHLIGHTER_WIDTH_FACTOR
    traceHighlighterPath(ctx, points)
    ctx.stroke()
    ctx.restore()
    return
  }
  if (stroke.style !== 'normal') {
    drawStyledStroke(ctx, points, stroke.style, width, stroke.color)
    ctx.restore()
    return
  }
  if (stroke.tool === 'ballpen') {
    ctx.strokeStyle = stroke.color
    ctx.lineWidth = width
    traceSmoothPath(ctx, points)
    ctx.stroke()
    ctx.restore()
    return
  }

  let pressureSum = 0
  for (const point of points) pressureSum += point.p
  const averagePressure = Math.max(0.3, Math.min(1, pressureSum / points.length))
  const baseWidth = strokeBaseWidth(width, averagePressure)
  ctx.strokeStyle = stroke.color
  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index]!
    const end = points[index + 1]!
    const progress = (index + 0.5) / (points.length - 1)
    const pressure = ((start.p ?? 1) + (end.p ?? 1)) / 2
    ctx.lineWidth = strokeWidthAt(baseWidth, progress, pressure)
    ctx.beginPath()
    ctx.moveTo(start.x, start.y)
    ctx.lineTo(end.x, end.y)
    ctx.stroke()
  }
  ctx.restore()
}

function drawStyledStroke(
  ctx: CanvasRenderingContext2D,
  points: readonly Point[],
  style: InknoteStroke['style'],
  width: number,
  color: string,
): void {
  ctx.strokeStyle = color
  if (style === 'dashed') {
    ctx.setLineDash([14, 9])
    ctx.lineWidth = width
    traceSmoothPath(ctx, points)
    ctx.stroke()
  } else if (style === 'dotted') {
    ctx.setLineDash([0.4, 11])
    ctx.lineWidth = Math.max(1.8, width * 1.25)
    traceSmoothPath(ctx, points)
    ctx.stroke()
  } else if (style === 'pencil') {
    ctx.setLineDash([1.6, 2.1])
    ctx.globalAlpha = 0.5
    ctx.lineWidth = width * 1.15
    traceSmoothPath(ctx, points)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 0.85
    ctx.lineWidth = Math.max(1, width * 0.8)
    traceSmoothPath(ctx, points)
    ctx.stroke()
    ctx.globalAlpha = 1
  } else if (style === 'brush') {
    const passes: ReadonlyArray<readonly [number, number]> = [
      [width * 2.6, 0.1],
      [width * 1.8, 0.18],
      [width * 1.2, 0.42],
      [width, 0.92],
    ]
    for (const [passWidth, alpha] of passes) {
      ctx.globalAlpha = alpha
      ctx.lineWidth = passWidth
      traceSmoothPath(ctx, points)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }
  ctx.setLineDash([])
}

function drawDot(ctx: CanvasRenderingContext2D, point: Point, color: string, width: number): void {
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(point.x, point.y, Math.max(0.4, width / 2), 0, Math.PI * 2)
  ctx.fill()
}

/** Draw a shape primitive given display-coordinate points. */
export function drawShape(
  ctx: CanvasRenderingContext2D,
  kind: InknoteShapeKind,
  points: readonly Point[],
  color: string,
  width: number,
): void {
  if (points.length < 2) return
  const first = points[0]!
  const second = points[1]!
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(1, width)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()

  if (kind === 'line' || kind === 'arrow') {
    ctx.moveTo(first.x, first.y)
    ctx.lineTo(second.x, second.y)
    ctx.stroke()
    if (kind === 'arrow') {
      const angle = Math.atan2(second.y - first.y, second.x - first.x)
      const length = Math.min(26, Math.hypot(second.x - first.x, second.y - first.y) * 0.3)
      ctx.beginPath()
      ctx.moveTo(second.x, second.y)
      ctx.lineTo(second.x - length * Math.cos(angle - 0.5), second.y - length * Math.sin(angle - 0.5))
      ctx.moveTo(second.x, second.y)
      ctx.lineTo(second.x - length * Math.cos(angle + 0.5), second.y - length * Math.sin(angle + 0.5))
      ctx.stroke()
    }
  } else if (kind === 'rect' || kind === 'square') {
    ctx.rect(
      Math.min(first.x, second.x),
      Math.min(first.y, second.y),
      Math.abs(second.x - first.x),
      Math.abs(second.y - first.y),
    )
    ctx.stroke()
  } else if (kind === 'ellipse') {
    ctx.ellipse(
      (first.x + second.x) / 2,
      (first.y + second.y) / 2,
      Math.abs(second.x - first.x) / 2,
      Math.abs(second.y - first.y) / 2,
      0,
      0,
      Math.PI * 2,
    )
    ctx.stroke()
  } else if (kind === 'circle') {
    const radius = Math.max(Math.abs(second.x - first.x), Math.abs(second.y - first.y)) / 2
    ctx.ellipse((first.x + second.x) / 2, (first.y + second.y) / 2, radius, radius, 0, 0, Math.PI * 2)
    ctx.stroke()
  } else if (kind === 'polygon') {
    ctx.moveTo(points[0]!.x, points[0]!.y)
    for (let index = 1; index < points.length; index++) ctx.lineTo(points[index]!.x, points[index]!.y)
    ctx.closePath()
    ctx.stroke()
  } else if (kind === 'curve') {
    traceSmoothPath(ctx, points)
    ctx.stroke()
  }
  ctx.restore()
}

/** Paint one text box. Stored coordinates are normalized; layout is shared with export. */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: InknoteTextBox,
  metrics: ContentMetrics,
  font: string,
): void {
  if (!text.text) return
  const width = metrics.width || INKNOTE_PAGE_WIDTH
  const height = metrics.height || INKNOTE_PAGE_HEIGHT
  const measure = (value: string, spec: string): number => {
    ctx.font = spec
    return ctx.measureText(value).width
  }
  const layout = layoutTextBox(text.text, text, measure, { pageWidth: width, pageHeight: height, font })
  const originX = text.x * width
  const originY = text.y * height

  ctx.save()
  ctx.fillStyle = text.color
  ctx.textBaseline = 'top'
  for (const line of layout.lines) {
    const x = originX + line.x
    const y = originY + line.y
    if (text.hl) {
      ctx.save()
      ctx.globalAlpha = TEXT_HIGHLIGHT_ALPHA
      ctx.fillStyle = text.hl
      ctx.fillRect(x - 2, y - 1, line.width + 4, text.fontSize * TEXT_LINE_BOX_FACTOR)
      ctx.restore()
    }
    ctx.fillText(line.text, x, y)
    if (text.underline) {
      ctx.strokeStyle = text.color
      ctx.lineWidth = Math.max(1, text.fontSize * 0.06)
      ctx.beginPath()
      ctx.moveTo(x, y + text.fontSize * TEXT_LINE_BOX_FACTOR)
      ctx.lineTo(x + line.width, y + text.fontSize * TEXT_LINE_BOX_FACTOR)
      ctx.stroke()
    }
  }
  ctx.restore()
}

export interface RenderPageOptions {
  font: string
  /** Called when a media asset finishes decoding; the live engine redraws its raster. */
  onMediaReady?: () => void
}

/** Full page in the reference order: paper, media, ink, text. */
export function renderPage(
  ctx: CanvasRenderingContext2D,
  page: InknotePageContent,
  paper: InknotePaper,
  metrics: ContentMetrics,
  options: RenderPageOptions,
): void {
  const width = metrics.width || INKNOTE_PAGE_WIDTH
  const height = metrics.height || INKNOTE_PAGE_HEIGHT
  drawPaper(ctx, paper, width, height)
  drawPageMedia(ctx, page, width, height, options.onMediaReady)
  for (const stroke of page.strokes) drawStroke(ctx, stroke, metrics, paper)
  for (const text of page.texts) drawText(ctx, text, metrics, options.font)
}

/**
 * Render a page into a fresh canvas at a target CSS width. Used by page thumbnails, covers and
 * exports; the caller owns the returned canvas.
 */
export function renderPageToCanvas(
  page: InknotePageContent,
  paper: InknotePaper,
  metrics: ContentMetrics,
  targetWidth: number,
  font: string,
  onMediaReady?: () => void,
): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null
  const width = metrics.width || INKNOTE_PAGE_WIDTH
  const height = metrics.height || INKNOTE_PAGE_HEIGHT
  const ratio = Number.isFinite(targetWidth) && targetWidth > 0 ? targetWidth / width : 1
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * ratio))
  canvas.height = Math.max(1, Math.round(height * ratio))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  renderPage(ctx, page, paper, metrics, { font, onMediaReady })
  return canvas
}

function loadImage(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let target: ImageCacheEntry | null = null
    const listener = (image: HTMLImageElement | null): void => finish(Boolean(image))
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      target?.listeners.delete(listener)
      resolve(ok)
    }
    const timer = globalThis.setTimeout(() => finish(false), timeoutMs)
    target = requestImage(url, listener)
    if (!target) finish(false)
    else if (target.status !== 'loading') finish(target.status === 'loaded')
  })
}

/**
 * Wait for a page's background and images before exporting or snapshotting. Missing or timed-out
 * assets are reported so the caller can warn; they never block the export indefinitely.
 */
export async function preloadPageMedia(
  page: InknotePageContent,
  timeoutMs: number = 3_000,
): Promise<{ missing: string[] }> {
  const urls: string[] = []
  if (page.bg?.url) urls.push(page.bg.url)
  for (const image of page.images) if (image.url) urls.push(image.url)
  const unique = [...new Set(urls)]
  const results = await Promise.all(unique.map((url) => loadImage(url, timeoutMs)))
  return { missing: unique.filter((_url, index) => !results[index]) }
}

function displayRatio(metrics: ContentMetrics): number {
  return metrics.contentWidth > 0 && Number.isFinite(metrics.contentWidth)
    ? (metrics.width || INKNOTE_PAGE_WIDTH) / metrics.contentWidth
    : 1
}

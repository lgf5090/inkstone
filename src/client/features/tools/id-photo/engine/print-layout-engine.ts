import { PRINT_SHEET_PRESETS } from '@shared/tools/id-photo/presets'

const MM_PER_INCH = 25.4
const PAPER_COLOR = '#ffffff'
const PHOTO_EDGE_COLOR = '#e2e8f0'
const CROP_MARK_COLOR = '#94a3b8'
const CROP_MARK_LENGTH = 8
const MAX_CANVAS_PIXELS = 20_000_000
const MIN_PRINT_DPI = 72
import type { PrintSheetOptions } from '@shared/tools/id-photo/types'

export interface PrintLayoutGrid {
  rows: number
  cols: number
  totalCount: number
  itemWidthPx: number
  itemHeightPx: number
  startX: number
  startY: number
  gapXPx: number
  gapYPx: number
  paperWidthPx: number
  paperHeightPx: number
  fits: boolean
  dpi: number
  dpiReduced: boolean
}

export function fitPrintDpi(paperWidthMm: number, paperHeightMm: number, requestedDpi: number): number {
  const pixels = (paperWidthMm / MM_PER_INCH * requestedDpi) * (paperHeightMm / MM_PER_INCH * requestedDpi)
  if (pixels <= MAX_CANVAS_PIXELS) return requestedDpi
  const scaled = Math.floor(Math.sqrt(MAX_CANVAS_PIXELS / (paperWidthMm * paperHeightMm)) * MM_PER_INCH)
  return Math.max(MIN_PRINT_DPI, scaled)
}

/**
 * Calculates optimal grid layout for ID photos on photographic paper.
 */
export function calculatePrintLayout(
  photoWidthMm: number,
  photoHeightMm: number,
  options: PrintSheetOptions,
): PrintLayoutGrid {
  const paperPreset =
    PRINT_SHEET_PRESETS.find((p) => p.id === options.paperSize) ?? PRINT_SHEET_PRESETS[1]

  let paperWidthMm: number = paperPreset.widthMm
  let paperHeightMm: number = paperPreset.heightMm

  if (options.orientation === 'landscape') {
    const temp = paperWidthMm
    paperWidthMm = paperHeightMm
    paperHeightMm = temp
  }

  const dpi = fitPrintDpi(paperWidthMm, paperHeightMm, options.dpi)
  const mmToPx = dpi / MM_PER_INCH
  const paperWidthPx = Math.round(paperWidthMm * mmToPx)
  const paperHeightPx = Math.round(paperHeightMm * mmToPx)

  const itemWidthPx = Math.round(photoWidthMm * mmToPx)
  const itemHeightPx = Math.round(photoHeightMm * mmToPx)

  const marginPx = Math.round(options.marginMm * mmToPx)
  const gapPx = Math.round(options.gapMm * mmToPx)

  const availableWidth = paperWidthPx - 2 * marginPx
  const availableHeight = paperHeightPx - 2 * marginPx

  const cols = Math.floor((availableWidth + gapPx) / (itemWidthPx + gapPx))
  const rows = Math.floor((availableHeight + gapPx) / (itemHeightPx + gapPx))
  const fits = cols >= 1 && rows >= 1

  const totalGridWidth = cols * itemWidthPx + (cols - 1) * gapPx
  const totalGridHeight = rows * itemHeightPx + (rows - 1) * gapPx

  const startX = Math.round((paperWidthPx - totalGridWidth) / 2)
  const startY = Math.round((paperHeightPx - totalGridHeight) / 2)

  return {
    rows: Math.max(0, rows),
    cols: Math.max(0, cols),
    totalCount: Math.max(0, rows * cols),
    fits,
    dpi,
    dpiReduced: dpi !== options.dpi,
    itemWidthPx,
    itemHeightPx,
    startX: fits ? startX : 0,
    startY: fits ? startY : 0,
    gapXPx: gapPx,
    gapYPx: gapPx,
    paperWidthPx,
    paperHeightPx,
  }
}

/**
 * Renders complete multi-up photo print sheet with optional cut guides.
 */
export function renderPrintSheet(
  photoCanvas: HTMLCanvasElement | CanvasImageSource,
  options: PrintSheetOptions,
  photoWidthMm: number,
  photoHeightMm: number,
): HTMLCanvasElement {
  const layout = calculatePrintLayout(photoWidthMm, photoHeightMm, options)
  const canvas = document.createElement('canvas')
  canvas.width = layout.paperWidthPx
  canvas.height = layout.paperHeightPx

  if (!layout.fits) {
    throw new Error('The photo does not fit the selected paper')
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Canvas 2D context unavailable while rendering the print sheet')
  }

  // 1. Pure white photo paper background
  ctx.fillStyle = PAPER_COLOR
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // 2. Draw photo grid
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      const x = layout.startX + c * (layout.itemWidthPx + layout.gapXPx)
      const y = layout.startY + r * (layout.itemHeightPx + layout.gapYPx)

      ctx.drawImage(photoCanvas, x, y, layout.itemWidthPx, layout.itemHeightPx)

      ctx.strokeStyle = PHOTO_EDGE_COLOR
      ctx.lineWidth = 1
      ctx.strokeRect(x, y, layout.itemWidthPx, layout.itemHeightPx)

      if (options.showCropMarks) {
        drawCropMarks(ctx, x, y, layout.itemWidthPx, layout.itemHeightPx)
      }
    }
  }

  return canvas
}

function drawCropMarks(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const right = x + width
  const bottom = y + height
  const corners: Array<[number, number, number, number]> = [
    [x, y, -CROP_MARK_LENGTH, -CROP_MARK_LENGTH],
    [right, y, CROP_MARK_LENGTH, -CROP_MARK_LENGTH],
    [x, bottom, -CROP_MARK_LENGTH, CROP_MARK_LENGTH],
    [right, bottom, CROP_MARK_LENGTH, CROP_MARK_LENGTH],
  ]

  ctx.strokeStyle = CROP_MARK_COLOR
  ctx.lineWidth = 1
  ctx.setLineDash([4, 4])
  corners.forEach(([cornerX, cornerY, outwardX, outwardY]) => {
    ctx.beginPath()
    ctx.moveTo(cornerX + outwardX, cornerY)
    ctx.lineTo(cornerX, cornerY)
    ctx.moveTo(cornerX, cornerY + outwardY)
    ctx.lineTo(cornerX, cornerY)
    ctx.stroke()
  })
  ctx.setLineDash([])
}

import { PRINT_SHEET_PRESETS } from '@shared/tools/id-photo/presets'
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

  const mmToPx = options.dpi / 25.4
  const paperWidthPx = Math.round(paperWidthMm * mmToPx)
  const paperHeightPx = Math.round(paperHeightMm * mmToPx)

  const itemWidthPx = Math.round(photoWidthMm * mmToPx)
  const itemHeightPx = Math.round(photoHeightMm * mmToPx)

  const marginPx = Math.round(options.marginMm * mmToPx)
  const gapPx = Math.round(options.gapMm * mmToPx)

  const availableWidth = paperWidthPx - 2 * marginPx
  const availableHeight = paperHeightPx - 2 * marginPx

  const cols = Math.max(1, Math.floor((availableWidth + gapPx) / (itemWidthPx + gapPx)))
  const rows = Math.max(1, Math.floor((availableHeight + gapPx) / (itemHeightPx + gapPx)))

  const totalGridWidth = cols * itemWidthPx + (cols - 1) * gapPx
  const totalGridHeight = rows * itemHeightPx + (rows - 1) * gapPx

  const startX = Math.round((paperWidthPx - totalGridWidth) / 2)
  const startY = Math.round((paperHeightPx - totalGridHeight) / 2)

  return {
    rows,
    cols,
    totalCount: rows * cols,
    itemWidthPx,
    itemHeightPx,
    startX,
    startY,
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

  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas

  // 1. Pure white photo paper background
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // 2. Draw photo grid
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      const x = layout.startX + c * (layout.itemWidthPx + layout.gapXPx)
      const y = layout.startY + r * (layout.itemHeightPx + layout.gapYPx)

      ctx.drawImage(photoCanvas, x, y, layout.itemWidthPx, layout.itemHeightPx)

      // Light border to define photo edge
      ctx.strokeStyle = '#e2e8f0'
      ctx.lineWidth = 1
      ctx.strokeRect(x, y, layout.itemWidthPx, layout.itemHeightPx)

      // 3. Optional cut guides (dashed lines or corner marks)
      if (options.showCropMarks) {
        ctx.strokeStyle = '#94a3b8'
        ctx.lineWidth = 1
        ctx.setLineDash([4, 4])

        // Top & Bottom tick guides
        const markLen = 8
        // Top left
        ctx.beginPath()
        ctx.moveTo(x - markLen, y)
        ctx.lineTo(x, y)
        ctx.moveTo(x, y - markLen)
        ctx.lineTo(x, y)
        ctx.stroke()

        // Bottom right
        const rx = x + layout.itemWidthPx
        const by = y + layout.itemHeightPx
        ctx.beginPath()
        ctx.moveTo(rx + markLen, by)
        ctx.lineTo(rx, by)
        ctx.moveTo(rx, by + markLen)
        ctx.lineTo(rx, by)
        ctx.stroke()

        ctx.setLineDash([])
      }
    }
  }

  return canvas
}

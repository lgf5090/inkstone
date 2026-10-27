export const SNAPSHOT_MAX_ROWS = 40

export function computeColumnWidths(columns: string[], rows: string[][], min = 64, max = 320): number[] {
  return columns.map((column, index) => {
    const longest = rows.reduce((longest, row) => Math.max(longest, (row[index] ?? '').length), column.length)
    return Math.max(min, Math.min(max, longest * 7 + 20))
  })
}

function cssColor(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim()
  return value || fallback
}

function trimToWidth(context: CanvasRenderingContext2D, text: string, width: number): string {
  if (context.measureText(text).width <= width) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (context.measureText(`${text.slice(0, middle)}…`).width <= width) low = middle
    else high = middle - 1
  }
  return `${text.slice(0, low)}…`
}

export interface GridSnapshotParts {
  columns: string[]
  rows: string[][]
  title: string
  rowNumbers?: boolean
}

export function renderGridSnapshot({ columns, rows, title, rowNumbers = true }: GridSnapshotParts): HTMLCanvasElement {
  const styles = getComputedStyle(document.documentElement)
  const background = cssColor(styles, '--bg-base', '#ffffff')
  const headerBackground = cssColor(styles, '--bg-sunken', '#f3f4f6')
  const text = cssColor(styles, '--text-primary', '#111827')
  const muted = cssColor(styles, '--text-tertiary', '#6b7280')
  const grid = cssColor(styles, '--border-subtle', '#e5e7eb')
  const padding = 16
  const rowHeight = 26
  const titleHeight = title ? 34 : 0
  const numberWidth = rowNumbers ? 44 : 0
  const widths = computeColumnWidths(columns, rows)
  const width = padding * 2 + numberWidth + widths.reduce((total, value) => total + value, 0)
  const height = padding * 2 + titleHeight + 30 + Math.max(1, rows.length) * rowHeight
  const canvas = document.createElement('canvas')
  const ratio = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  const context = canvas.getContext('2d')
  if (!context) return canvas
  context.scale(ratio, ratio)
  context.fillStyle = background
  context.fillRect(0, 0, width, height)
  context.textBaseline = 'middle'
  let y = padding
  if (title) {
    context.fillStyle = text
    context.font = '600 13px system-ui, sans-serif'
    context.fillText(trimToWidth(context, title, width - padding * 2), padding, y + 12)
    y += titleHeight
  }
  context.fillStyle = headerBackground
  context.fillRect(padding, y, width - padding * 2, 30)
  context.font = '600 12px ui-monospace, monospace'
  let x = padding
  if (rowNumbers) {
    context.fillStyle = muted
    context.fillText('#', x + 12, y + 15)
    x += numberWidth
  }
  columns.forEach((column, index) => {
    context.fillStyle = text
    context.fillText(trimToWidth(context, column, widths[index]! - 12), x + 6, y + 15)
    x += widths[index]!
  })
  y += 30
  context.font = '12px ui-monospace, monospace'
  rows.forEach((row, rowIndex) => {
    if (rowIndex % 2 === 1) {
      context.fillStyle = grid
      context.globalAlpha = 0.18
      context.fillRect(padding, y, width - padding * 2, rowHeight)
      context.globalAlpha = 1
    }
    let cellX = padding
    if (rowNumbers) {
      context.fillStyle = muted
      context.fillText(String(rowIndex + 1), cellX + 12, y + rowHeight / 2)
      cellX += numberWidth
    }
    columns.forEach((_, index) => {
      context.fillStyle = text
      const raw = row[index] ?? ''
      context.fillText(trimToWidth(context, raw, widths[index]! - 12), cellX + 6, y + rowHeight / 2)
      cellX += widths[index]!
    })
    context.strokeStyle = grid
    context.lineWidth = 0.5
    context.beginPath()
    context.moveTo(padding, y + rowHeight)
    context.lineTo(width - padding, y + rowHeight)
    context.stroke()
    y += rowHeight
  })
  return canvas
}

export function renderCodeSnapshot(code: string, title: string): HTMLCanvasElement {
  const styles = getComputedStyle(document.documentElement)
  const background = cssColor(styles, '--bg-base', '#ffffff')
  const text = cssColor(styles, '--text-primary', '#111827')
  const muted = cssColor(styles, '--text-tertiary', '#6b7280')
  const lines = code.replace(/\r\n/g, '\n').split('\n').slice(0, 200)
  const padding = 16
  const lineHeight = 20
  const titleHeight = 32
  const canvas = document.createElement('canvas')
  const measure = document.createElement('canvas').getContext('2d')
  if (!measure) return canvas
  measure.font = '12px ui-monospace, monospace'
  const codeWidth = lines.reduce((longest, line) => Math.max(longest, measure.measureText(line).width), 0)
  const width = Math.min(1600, Math.ceil(codeWidth) + 92)
  const height = padding * 2 + titleHeight + lines.length * lineHeight
  const ratio = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  const context = canvas.getContext('2d')
  if (!context) return canvas
  context.scale(ratio, ratio)
  context.fillStyle = background
  context.fillRect(0, 0, width, height)
  context.font = '600 12px system-ui, sans-serif'
  context.fillStyle = muted
  context.textBaseline = 'middle'
  if (title) context.fillText(trimToWidth(context, title, width - padding * 2), padding, padding + 10)
  context.font = '12px ui-monospace, monospace'
  lines.forEach((line, index) => {
    const y = padding + titleHeight + index * lineHeight + lineHeight / 2
    context.fillStyle = muted
    context.fillText(String(index + 1).padStart(3, ' '), padding, y)
    context.fillStyle = text
    context.fillText(trimToWidth(context, line, width - padding * 2 - 44), padding + 44, y)
  })
  return canvas
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'))
}

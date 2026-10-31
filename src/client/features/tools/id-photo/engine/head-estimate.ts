import { isSkinTone } from './retouch-pipeline'

export interface HeadBox {
  x: number
  y: number
  width: number
  height: number
}

interface RowRun {
  row: number
  start: number
  end: number
  width: number
}

const MAX_GRID_EDGE_CELLS = 160
const MIN_AREA_RATIO = 0.004
const MAX_AREA_RATIO = 0.45
const MIN_ASPECT = 0.35
const MAX_ASPECT = 2.2
const CROWN_KEEP_RATIO = 0.5
const SIDE_KEEP_RATIO = 0.3
const MIN_FACE_ROWS = 3

function skinMask(data: Uint8ClampedArray, width: number, height: number): { mask: Uint8Array; cols: number; rows: number; cell: number } | null {
  if (!(width > 3) || !(height > 3) || data.length < width * height * 4) return null
  const cell = Math.max(1, Math.ceil(Math.max(width / MAX_GRID_EDGE_CELLS, height / MAX_GRID_EDGE_CELLS)))
  const cols = Math.floor(width / cell)
  const rows = Math.floor(height / cell)
  if (cols < 4 || rows < 4) return null

  const mask = new Uint8Array(cols * rows)
  const offset = Math.floor(cell / 2)
  for (let row = 0; row < rows; row++) {
    const y = row * cell + offset
    for (let col = 0; col < cols; col++) {
      const i = (y * width + col * cell + offset) * 4
      if (data[i + 3] < 128) continue
      if (isSkinTone(data[i], data[i + 1], data[i + 2])) mask[row * cols + col] = 1
    }
  }
  return { mask, cols, rows, cell }
}

function largestComponent(mask: Uint8Array, cols: number, rows: number): Uint8Array | null {
  const seen = new Uint8Array(mask.length)
  const queue: number[] = []
  let best: Uint8Array | null = null
  let bestSize = 0

  for (let seed = 0; seed < mask.length; seed++) {
    if (mask[seed] !== 1 || seen[seed] === 1) continue
    const current = new Uint8Array(mask.length)
    queue.length = 0
    queue.push(seed)
    seen[seed] = 1
    current[seed] = 1
    let size = 0
    for (let head = 0; head < queue.length; head++) {
      const cell = queue[head]
      size++
      const col = cell % cols
      const row = (cell - col) / cols
      const neighbours = [
        col > 0 ? cell - 1 : -1,
        col < cols - 1 ? cell + 1 : -1,
        row > 0 ? cell - cols : -1,
        row < rows - 1 ? cell + cols : -1,
      ]
      for (const next of neighbours) {
        if (next < 0 || mask[next] !== 1 || seen[next] === 1) continue
        seen[next] = 1
        current[next] = 1
        queue.push(next)
      }
    }
    if (size > bestSize) {
      bestSize = size
      best = current
    }
  }

  return bestSize >= 4 ? best : null
}

function widestRunPerRow(component: Uint8Array, cols: number, rows: number): RowRun[] {
  const runs: RowRun[] = []
  for (let row = 0; row < rows; row++) {
    const offset = row * cols
    let start = -1
    let best: RowRun | null = null
    for (let col = 0; col <= cols; col++) {
      const on = col < cols && component[offset + col] === 1
      if (on && start < 0) start = col
      if (on || start < 0) continue
      const width = col - start
      if (!best || width > best.width) best = { row, start, end: col - 1, width }
      start = -1
    }
    if (best) runs.push(best)
  }
  return runs
}

export function estimateHeadBox(data: Uint8ClampedArray, width: number, height: number): HeadBox | null {
  const grid = skinMask(data, width, height)
  if (!grid) return null

  const component = largestComponent(grid.mask, grid.cols, grid.rows)
  if (!component) return null

  let cells = 0
  for (let i = 0; i < component.length; i++) cells += component[i]
  const areaRatio = cells / (grid.cols * grid.rows)
  if (areaRatio < MIN_AREA_RATIO || areaRatio > MAX_AREA_RATIO) return null

  const runs = widestRunPerRow(component, grid.cols, grid.rows)
  if (runs.length < MIN_FACE_ROWS) return null
  const widest = runs.reduce((max, run) => Math.max(max, run.width), 0)
  if (widest < 2) return null

  const crownRows = runs.filter((run) => run.width >= widest * CROWN_KEEP_RATIO)
  if (crownRows.length < MIN_FACE_ROWS) return null
  const top = crownRows[0].row
  const bottom = crownRows[crownRows.length - 1].row

  let minX = grid.cols
  let maxX = -1
  for (let row = top; row <= bottom; row++) {
    const run = runs.find((entry) => entry.row === row)
    if (!run || run.width < widest * SIDE_KEEP_RATIO) continue
    const offset = row * grid.cols
    // The full row extent, not just the widest run: an ear sits beside it.
    for (let col = 0; col < grid.cols; col++) {
      if (component[offset + col] !== 1) continue
      if (col < minX) minX = col
      if (col > maxX) maxX = col
    }
  }
  if (maxX < minX) return null

  const boxWidth = (maxX - minX + 1) * grid.cell
  const boxHeight = (bottom - top + 1) * grid.cell
  const aspect = boxWidth / boxHeight
  if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) return null

  return { x: minX * grid.cell, y: top * grid.cell, width: boxWidth, height: boxHeight }
}

/** Normalises a pixel box to the frame it came from, so any later size can redraw it. */
export function toHeadBoxRatios(box: HeadBox | null, width: number, height: number): HeadBox | null {
  if (!box || !(width > 0) || !(height > 0)) return null
  return {
    x: box.x / width,
    y: box.y / height,
    width: box.width / width,
    height: box.height / height,
  }
}

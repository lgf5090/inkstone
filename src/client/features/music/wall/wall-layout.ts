/**
 * The wall's geometry: how many covers fit, where each one sits, and how far the plane may move.
 *
 * Everything here is pure. The pane measures its viewport once per resize and asks these functions
 * for an answer; the drag hook only moves the plane within the bounds they return. The numbers are
 * the reference project's (`ui_wall.go`), converted from its DIP coordinates: a 112px cover with a
 * 14px gap, 48px of breathing room at the sides, and a column count that grows with the queue so a
 * long queue reads as a wall rather than a single tall strip.
 */

export const WALL_TILE = 112
export const WALL_GAP = 14
export const WALL_PITCH = WALL_TILE + WALL_GAP
export const WALL_PAD = 48

/** The most covers the pane mounts at once; a longer queue is windowed around the current track. */
export const WALL_MAX_TILES = 200

export interface WallPoint {
  x: number
  y: number
}

/**
 * The offsets the plane may take: `x`/`y` are the smallest allowed offset, `width`/`height` the
 * travel from there. A short wall has no travel on an axis and rests at the centred offset.
 */
export interface WallBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WallLayout {
  cols: number
  rows: number
  bounds: WallBounds
}

/** The slice of a queue that is mounted, as a half-open range of queue indices. */
export interface WallRange {
  start: number
  end: number
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback
}

/**
 * Lay `count` covers out in a `width`×`height` area.
 *
 * `top` and `foot` are the parts of the area the covers must stay out of, such as a heading above
 * the wall and the shell's transport below it. The first row rests below `top` and the last one
 * above `height - foot` when the wall is taller than that space; a wall that fits is centred. A wall
 * wider than the area rests with its first column inset by `WALL_PAD` and may be dragged until its
 * last column is inset by the same amount.
 */
export function layWall(
  count: number,
  width: number,
  height: number,
  top = 0,
  foot = 0,
): WallLayout {
  const tiles = Math.max(0, Math.trunc(finite(count)))
  const areaWidth = Math.max(0, finite(width))
  const areaHeight = Math.max(0, finite(height))
  const topInset = Math.max(0, finite(top))
  const footInset = Math.max(0, finite(foot))

  if (tiles === 0) {
    return { cols: 0, rows: 0, bounds: { x: 0, y: topInset, width: 0, height: 0 } }
  }

  const fit = Math.max(1, Math.floor((areaWidth - 2 * WALL_PAD + WALL_GAP) / WALL_PITCH))
  // The square-root term keeps a long queue from becoming one narrow column, while the fit term
  // keeps it from spilling past the area more than dragging has to repair.
  let cols = Math.max(Math.min(tiles, fit), Math.ceil(Math.sqrt(tiles * 2.5)))
  cols = Math.max(1, Math.min(cols, tiles))
  const rows = Math.ceil(tiles / cols)

  const contentWidth = cols * WALL_PITCH - WALL_GAP
  const contentHeight = rows * WALL_PITCH - WALL_GAP
  const availableWidth = areaWidth - 2 * WALL_PAD
  const availableHeight = areaHeight - topInset - footInset

  let x: number
  let travelX: number
  if (contentWidth > availableWidth) {
    x = areaWidth - WALL_PAD - contentWidth
    travelX = contentWidth - availableWidth
  } else {
    x = (areaWidth - contentWidth) / 2
    travelX = 0
  }

  let y: number
  let travelY: number
  if (contentHeight > availableHeight) {
    y = areaHeight - footInset - contentHeight
    travelY = contentHeight - availableHeight
  } else {
    y = topInset + (availableHeight - contentHeight) / 2
    travelY = 0
  }

  return { cols, rows, bounds: { x, y, width: travelX, height: travelY } }
}

/** Hold `point` within the offsets the layout rests at. */
export function clamp(layout: WallLayout, point: WallPoint): WallPoint {
  const bounds = layout.bounds
  return {
    x: Math.max(bounds.x, Math.min(finite(point.x), bounds.x + bounds.width)),
    y: Math.max(bounds.y, Math.min(finite(point.y), bounds.y + bounds.height)),
  }
}

/** Where the i-th cover sits on the plane, before the plane's own offset. */
export function cell(layout: WallLayout, index: number): WallPoint {
  if (layout.cols <= 0) return { x: 0, y: 0 }
  const i = Math.max(0, Math.trunc(finite(index)))
  return {
    x: (i % layout.cols) * WALL_PITCH,
    y: Math.floor(i / layout.cols) * WALL_PITCH,
  }
}

/**
 * The plane offset that brings the i-th cover to the middle of the area, as near as the bounds go.
 * The middle is measured between `top` and `height - foot`, so the cover centres in the part of the
 * area that is actually visible rather than under the heading or the transport.
 */
export function centre(
  layout: WallLayout,
  index: number,
  width: number,
  height: number,
  top = 0,
  foot = 0,
): WallPoint {
  const at = cell(layout, index)
  return clamp(layout, {
    x: finite(width) / 2 - at.x - WALL_TILE / 2,
    y: (finite(top) + finite(height) - finite(foot)) / 2 - at.y - WALL_TILE / 2,
  })
}

/** Whether the i-th cover is wholly inside the visible area with the plane at `offset`. */
export function shows(
  layout: WallLayout,
  index: number,
  offset: WallPoint,
  width: number,
  height: number,
  top = 0,
  foot = 0,
): boolean {
  const at = cell(layout, index)
  const x = finite(offset.x) + at.x
  const y = finite(offset.y) + at.y
  return x >= 0
    && x + WALL_TILE <= finite(width)
    && y >= finite(top)
    && y + WALL_TILE <= finite(height) - finite(foot)
}

/**
 * The mount window for a queue: everything when it is no longer than `limit`, otherwise `limit`
 * covers around the current one, nudged to the queue's edges rather than past them.
 */
export function visibleRange(
  count: number,
  current: number,
  limit = WALL_MAX_TILES,
): WallRange {
  const total = Math.max(0, Math.trunc(finite(count)))
  const size = Math.max(1, Math.trunc(finite(limit, WALL_MAX_TILES)))
  if (total <= size) return { start: 0, end: total }
  const at = Math.min(Math.max(0, Math.trunc(finite(current))), total - 1)
  const start = Math.min(Math.max(0, at - Math.floor(size / 2)), total - size)
  return { start, end: start + size }
}

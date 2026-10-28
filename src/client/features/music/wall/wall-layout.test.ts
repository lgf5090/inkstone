/**
 * The wall's geometry, without a browser: column count, resting offsets, travel and the mount window.
 */
import { describe, expect, it } from 'vitest'
import {
  WALL_GAP,
  WALL_MAX_TILES,
  WALL_PAD,
  WALL_PITCH,
  WALL_TILE,
  cell,
  centre,
  clamp,
  layWall,
  shows,
  visibleRange,
} from './wall-layout'

describe('layWall', () => {
  it('centres a wall that fits and leaves it no travel', () => {
    const layout = layWall(4, 800, 600)
    expect(layout.cols).toBe(4)
    expect(layout.rows).toBe(1)
    const contentWidth = 4 * WALL_PITCH - WALL_GAP
    const contentHeight = WALL_TILE
    expect(layout.bounds).toEqual({
      x: (800 - contentWidth) / 2,
      y: (600 - contentHeight) / 2,
      width: 0,
      height: 0,
    })
  })

  it('grows the column count with the queue instead of making one tall strip', () => {
    const layout = layWall(20, 300, 400)
    expect(layout.cols).toBe(8)
    expect(layout.rows).toBe(3)
    expect(layout.bounds).toEqual({ x: -742, y: 18, width: 790, height: 0 })
  })

  it('rests a taller wall at its bottom edge and reports the vertical travel', () => {
    const layout = layWall(40, 800, 300)
    expect(layout.cols).toBe(10)
    expect(layout.rows).toBe(4)
    expect(layout.bounds).toEqual({ x: -494, y: -190, width: 542, height: 190 })
  })

  it('leaves a zero queue empty, with the heading inset as its origin', () => {
    expect(layWall(0, 800, 600, 80)).toEqual({
      cols: 0,
      rows: 0,
      bounds: { x: 0, y: 80, width: 0, height: 0 },
    })
  })

  it('keeps the first column at the pad on a wall wider than the area', () => {
    const layout = layWall(20, 300, 400)
    expect(layout.bounds.x + layout.bounds.width).toBe(WALL_PAD)
  })
})

describe('cell', () => {
  it('walks a row by pitch and starts a new row after the last column', () => {
    const layout = layWall(20, 300, 400)
    expect(cell(layout, 0)).toEqual({ x: 0, y: 0 })
    expect(cell(layout, 7)).toEqual({ x: 7 * WALL_PITCH, y: 0 })
    expect(cell(layout, 8)).toEqual({ x: 0, y: WALL_PITCH })
    expect(cell(layout, 19)).toEqual({ x: 3 * WALL_PITCH, y: 2 * WALL_PITCH })
  })

  it('answers the origin for an empty layout', () => {
    expect(cell(layWall(0, 800, 600), 3)).toEqual({ x: 0, y: 0 })
  })
})

describe('clamp', () => {
  it('holds a point inside both axes', () => {
    const layout = layWall(40, 800, 300)
    expect(clamp(layout, { x: 10_000, y: -10_000 })).toEqual({ x: 48, y: -190 })
    expect(clamp(layout, { x: -10_000, y: 10_000 })).toEqual({ x: -494, y: 0 })
  })
})

describe('centre', () => {
  it('puts a cover in the middle of the area below the heading', () => {
    const layout = layWall(20, 300, 400)
    expect(centre(layout, 19, 300, 400)).toEqual({ x: -284, y: 18 })
  })

  it('stops at the bounds when the cover cannot reach the middle', () => {
    const layout = layWall(40, 800, 300)
    expect(centre(layout, 30, 800, 300)).toEqual({ x: 48, y: -190 })
  })
})

describe('shows', () => {
  it('counts only covers wholly inside the visible box', () => {
    const layout = layWall(20, 300, 400)
    const offset = { x: -284, y: 18 }
    expect(shows(layout, 0, offset, 300, 400)).toBe(false)
    expect(shows(layout, 19, offset, 300, 400)).toBe(true)
  })
})

describe('visibleRange', () => {
  it('mounts the whole queue when it fits the limit', () => {
    expect(visibleRange(40, 12)).toEqual({ start: 0, end: 40 })
  })

  it('windows a long queue around the current track', () => {
    const range = visibleRange(500, 250)
    expect(range).toEqual({ start: 150, end: 350 })
    expect(range.end - range.start).toBe(WALL_MAX_TILES)
  })

  it('nudges the window to the queue edges instead of past them', () => {
    expect(visibleRange(500, 0)).toEqual({ start: 0, end: 200 })
    expect(visibleRange(500, 499)).toEqual({ start: 300, end: 500 })
  })

  it('normalises a missing or out-of-range current track', () => {
    expect(visibleRange(500, Number.NaN)).toEqual({ start: 0, end: 200 })
    expect(visibleRange(500, -10)).toEqual({ start: 0, end: 200 })
  })
})

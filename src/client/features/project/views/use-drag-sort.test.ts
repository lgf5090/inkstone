import { describe, expect, it } from 'vitest'
import { resolveDragTarget, type DragGeometry } from './use-drag-sort'

const zones = [
  { key: 'left', left: 0, right: 280, top: 0, bottom: 600 },
  { key: 'right', left: 300, right: 580, top: 0, bottom: 600 },
]

const items = new Map<string, { id: string, top: number, height: number }[]>([
  ['left', [{ id: 'a', top: 0, height: 100 }, { id: 'b', top: 100, height: 100 }, { id: 'c', top: 200, height: 100 }]],
  ['right', [{ id: 'd', top: 0, height: 100 }]],
])

const geometry: DragGeometry = { zones, items }

describe('drag hit testing', () => {
  it('finds the column under the pointer and counts the midlines above it', () => {
    expect(resolveDragTarget(geometry, { x: 10, y: 150, scrollX: 0, scrollY: 0 }, new Set(), null))
      .toEqual({ zone: 'left', index: 1 })
    expect(resolveDragTarget(geometry, { x: 320, y: 10, scrollX: 0, scrollY: 0 }, new Set(), null))
      .toEqual({ zone: 'right', index: 0 })
  })

  it('keeps the geometry fixed while the column scrolls, so the pointer carries the offset', () => {
    expect(resolveDragTarget(geometry, { x: 10, y: 50, scrollX: 0, scrollY: 0 }, new Set(), null))
      .toEqual({ zone: 'left', index: 0 })
    expect(resolveDragTarget(geometry, { x: 10, y: 50, scrollX: 0, scrollY: 100 }, new Set(), null))
      .toEqual({ zone: 'left', index: 1 })
  })

  it('excludes the travelling group from the index it reports', () => {
    expect(resolveDragTarget(geometry, { x: 10, y: 250, scrollX: 0, scrollY: 0 }, new Set(['a']), null))
      .toEqual({ zone: 'left', index: 1 })
  })

  it('falls back to the last target when the pointer leaves every column', () => {
    expect(resolveDragTarget(geometry, { x: 900, y: 900, scrollX: 0, scrollY: 0 }, new Set(), { zone: 'left', index: 1 }))
      .toEqual({ zone: 'left', index: 1 })
  })

  it('takes the first column in the band when the pointer is below its cards', () => {
    expect(resolveDragTarget(geometry, { x: 10, y: 900, scrollX: 0, scrollY: 0 }, new Set(), null))
      .toEqual({ zone: 'left', index: 3 })
  })
})

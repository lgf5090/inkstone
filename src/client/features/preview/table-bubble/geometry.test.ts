import { describe, expect, it } from 'vitest'
import { bodyRowIndex, dropIndex, geometryIsStale, measureTable, nearestEdge, slotAt, trackedEdge, type Box } from './geometry'

function box(left: number, top: number, right: number, bottom: number): Box {
  return { top, left, right, bottom }
}

/** A 3-column, 2-row table at (100, 50): columns 60px wide, rows 20px and 30px tall. */
const TABLE = box(100, 50, 280, 100)
const COLUMNS = [box(100, 50, 160, 70), box(160, 50, 220, 70), box(220, 50, 280, 70)]
const ROWS = [box(100, 50, 280, 70), box(100, 70, 280, 100)]

function shape() {
  return measureTable(TABLE, COLUMNS, ROWS)
}

describe('measureTable', () => {
  it('reports column centres relative to the table, not the viewport', () => {
    expect(shape().columnCenters).toEqual([30, 90, 150])
  })

  it('reports row centres relative to the table', () => {
    expect(shape().rowCenters).toEqual([10, 35])
  })

  it('reports one more edge than there are cells, closing each span', () => {
    expect(shape().columnEdges).toEqual([0, 60, 120, 180])
    expect(shape().rowEdges).toEqual([0, 20, 50])
  })

  it('keeps the table box so a scroll can move it without re-measuring the cells', () => {
    expect(shape().table).toEqual(TABLE)
  })
})

describe('nearestEdge', () => {
  it('finds the edge within the threshold', () => {
    expect(nearestEdge([0, 60, 120, 180], 62, 7)).toBe(1)
  })

  it('returns null a little way off every edge', () => {
    expect(nearestEdge([0, 60, 120, 180], 40, 7)).toBeNull()
  })

  it('takes the nearer of two edges a pointer sits between', () => {
    expect(nearestEdge([0, 60, 70], 57, 7)).toBe(1)
    expect(nearestEdge([0, 60, 70], 66, 7)).toBe(2)
  })

  it('gives a dead-even tie to the earlier edge', () => {
    expect(nearestEdge([0, 60, 66], 63, 7)).toBe(1)
  })

  it('counts the outer edges, so a column can be inserted before the first and after the last', () => {
    expect(nearestEdge([0, 60, 120], -4, 7)).toBe(0)
    expect(nearestEdge([0, 60, 120], 124, 7)).toBe(2)
  })
})

describe('slotAt', () => {
  it('names the slot a pointer is inside', () => {
    expect(slotAt([0, 60, 120, 180], 90)).toBe(1)
    expect(slotAt([0, 60, 120, 180], 10)).toBe(0)
    expect(slotAt([0, 60, 120, 180], 179)).toBe(2)
  })

  it('never returns a slot past the last one', () => {
    expect(slotAt([0, 60, 120], 9999)).toBe(1)
  })
})

describe('dropIndex', () => {
  it('shifts a drop that was past the item down by the slot the item vacated', () => {
    expect(dropIndex(3, 1)).toBe(2)
  })

  it('leaves a drop before the item alone', () => {
    expect(dropIndex(0, 2)).toBe(0)
  })

  it('turns a drop onto the item own edges into a no-op', () => {
    expect(dropIndex(1, 1)).toBe(1)
    expect(dropIndex(2, 1)).toBe(1)
  })
})

describe('geometryIsStale', () => {
  it('is fresh for the same box and the same counts', () => {
    expect(geometryIsStale(shape(), TABLE, 2, 3)).toBe(false)
  })

  it('notices a row or a column appearing', () => {
    expect(geometryIsStale(shape(), TABLE, 3, 3)).toBe(true)
    expect(geometryIsStale(shape(), TABLE, 2, 4)).toBe(true)
  })

  it('notices the table changing size', () => {
    expect(geometryIsStale(shape(), box(100, 50, 300, 100), 2, 3)).toBe(true)
  })

  it('ignores a scroll, which moves the box without moving anything inside it', () => {
    expect(geometryIsStale(shape(), box(100, -400, 280, -350), 2, 3)).toBe(false)
  })
})

describe('trackedEdge', () => {
  const EDGES = [0, 60, 120, 180]

  it('acquires the edge the pointer came near', () => {
    expect(trackedEdge(EDGES, 62, 7, 26, null)).toBe(1)
  })

  it('holds an edge already offered while the pointer travels past it', () => {
    expect(trackedEdge(EDGES, 74, 7, 26, 1)).toBe(1)
    expect(trackedEdge(EDGES, 85, 7, 26, 1)).toBe(1)
  })

  it('lets go once the pointer is clear of the release distance', () => {
    expect(trackedEdge(EDGES, 100, 7, 26, 1)).toBeNull()
    expect(trackedEdge(EDGES, 45, 7, 26, 0)).toBeNull()
  })

  it('prefers a newly approached edge over the one it was holding', () => {
    expect(trackedEdge(EDGES, 118, 7, 26, 1)).toBe(2)
  })

  it('drops a held edge the geometry no longer has', () => {
    expect(trackedEdge([0, 60], 999, 7, 26, 9)).toBeNull()
  })

  it('is the reason a marker outside the table can still be clicked', () => {
    const pointerBelowTheLastEdge = 180 + 11
    expect(nearestEdge(EDGES, pointerBelowTheLastEdge, 7)).toBeNull()
    expect(trackedEdge(EDGES, pointerBelowTheLastEdge, 7, 26, 3)).toBe(3)
  })
})

describe('bodyRowIndex', () => {
  it('steps one up, because the rendered table counts the header as row zero', () => {
    expect(bodyRowIndex(1, 3)).toBe(0)
    expect(bodyRowIndex(2, 3)).toBe(1)
    expect(bodyRowIndex(4, 3)).toBe(3)
  })

  it('clamps an edge above the header to the top of the body', () => {
    expect(bodyRowIndex(0, 3)).toBe(0)
  })

  it('clamps an edge past the last row to the bottom of the body', () => {
    expect(bodyRowIndex(9, 3)).toBe(3)
  })
})

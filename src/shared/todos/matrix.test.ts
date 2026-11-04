import { describe, expect, it } from 'vitest'
import {
  MATRIX_QUADRANTS,
  MATRIX_URGENT_WINDOW_MS,
  matrixAxesOf,
  matrixQuadrant,
  matrixQuadrantOf,
  quadrantCell,
} from './matrix'

const NOW = Date.UTC(2026, 10, 5, 3, 0, 0)

function task(patch: Partial<Parameters<typeof matrixAxesOf>[0]> = {}): Parameters<typeof matrixAxesOf>[0] {
  return { priority: 'medium', dueAt: null, important: null, urgent: null, ...patch }
}

describe('the Eisenhower matrix classification', () => {
  it('derives importance from the priority ladder', () => {
    expect(matrixAxesOf(task({ priority: 'low' }), NOW)).toEqual({ important: false, urgent: false })
    expect(matrixAxesOf(task({ priority: 'medium' }), NOW)).toEqual({ important: false, urgent: false })
    expect(matrixAxesOf(task({ priority: 'high' }), NOW)).toEqual({ important: true, urgent: false })
    expect(matrixAxesOf(task({ priority: 'urgent' }), NOW)).toEqual({ important: true, urgent: true })
  })

  it('derives urgency from the due date inside the window', () => {
    expect(matrixAxesOf(task({ dueAt: NOW + MATRIX_URGENT_WINDOW_MS + 1 }), NOW)).toEqual({ important: false, urgent: false })
    expect(matrixAxesOf(task({ dueAt: NOW + MATRIX_URGENT_WINDOW_MS }), NOW)).toEqual({ important: false, urgent: true })
    expect(matrixAxesOf(task({ dueAt: NOW - 86_400_000 }), NOW)).toEqual({ important: false, urgent: true })
  })

  it('lets an explicit answer win over the derivation', () => {
    expect(matrixAxesOf(task({ priority: 'urgent', important: false, urgent: false }), NOW)).toEqual({ important: false, urgent: false })
    expect(matrixAxesOf(task({ priority: 'low', dueAt: NOW, important: true, urgent: false }), NOW)).toEqual({ important: true, urgent: false })
    expect(matrixAxesOf(task({ priority: 'low', dueAt: NOW, important: true, urgent: null }), NOW)).toEqual({ important: true, urgent: true })
  })

  it('maps every pair to one cell and back', () => {
    for (const quadrant of MATRIX_QUADRANTS) {
      const cell = quadrantCell(quadrant)
      expect(matrixQuadrant(cell)).toBe(quadrant)
      expect(matrixQuadrantOf(task({ important: cell.important, urgent: cell.urgent }), NOW)).toBe(quadrant)
    }
  })
})

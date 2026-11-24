// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseA1Range } from '../src/shared/office/a1'
import type { OfficeEditPlan } from '../src/shared/office/ai'
import { PlanApplyError, applyPlanToSheetsSnapshot } from '../src/worker/office/plan-apply'

/**
 * The editor-free applier: pure JSON edits on a workbook, so a plan can land without a browser.
 */

const FILE = '0123456789abcdefghjkmnpqrs'

function workbook(): Record<string, unknown> {
  return {
    sheets: {
      s1: { name: 'Sheet1', cellData: { 0: { 0: { v: 'keep' } } } },
      s2: { name: 'Second', cellData: {} },
    },
    sheetOrder: ['s1', 's2'],
  }
}

function plan(ops: OfficeEditPlan['ops']): OfficeEditPlan {
  return { type: 'sheets', fileId: FILE, summary: 'Scheduled write', ops }
}

function cells(snapshot: unknown, sheet = 's1'): unknown {
  return (snapshot as { sheets: Record<string, { cellData: unknown }> }).sheets[sheet]!.cellData
}

describe('parseA1Range', () => {
  it('reads a cell and a rectangle', () => {
    expect(parseA1Range('B2')).toEqual({ startRow: 1, startCol: 1, endRow: 1, endCol: 1 })
    expect(parseA1Range('A1:C3')).toEqual({ startRow: 0, startCol: 0, endRow: 2, endCol: 2 })
  })

  it('rejects text that is not a range', () => {
    expect(parseA1Range('Sheet1!A1')).toBeNull()
    expect(parseA1Range('A')).toBeNull()
  })
})

describe('applyPlanToSheetsSnapshot', () => {
  it('writes values into the range, leaving other cells alone', () => {
    const next = applyPlanToSheetsSnapshot(workbook(), plan([
      { kind: 'sheets.set-values', sheet: 'Sheet1', range: 'B2:C3', values: [['a', 'b'], ['c', 'd']] },
    ]))
    expect(cells(next)).toEqual({
      0: { 0: { v: 'keep' } },
      1: { 1: { v: 'a' }, 2: { v: 'b' } },
      2: { 1: { v: 'c' }, 2: { v: 'd' } },
    })
  })

  it('writes a formula into one cell', () => {
    const next = applyPlanToSheetsSnapshot(workbook(), plan([
      { kind: 'sheets.set-formula', sheet: 's2', range: 'A1', formula: '=SUM(1,2)' },
    ]))
    expect(cells(next, 's2')).toEqual({ 0: { 0: { f: '=SUM(1,2)' } } })
  })

  it('clears a cell when the value is null', () => {
    const next = applyPlanToSheetsSnapshot(workbook(), plan([
      { kind: 'sheets.set-values', range: 'A1', values: [[null]] },
    ]))
    expect(cells(next)).toEqual({})
  })

  it('refuses an operation that needs the editor, naming it', () => {
    expect(() => applyPlanToSheetsSnapshot(workbook(), plan([
      { kind: 'sheets.set-style', range: 'A1', bold: true },
    ]))).toThrow(PlanApplyError)
  })

  it('refuses values that do not fit the range', () => {
    expect(() => applyPlanToSheetsSnapshot(workbook(), plan([
      { kind: 'sheets.set-values', range: 'A1', values: [['a', 'b']] },
    ]))).toThrow(/holds 1x1/)
  })

  it('does not mutate the snapshot it was given', () => {
    const original = workbook()
    applyPlanToSheetsSnapshot(original, plan([{ kind: 'sheets.set-values', range: 'B2', values: [[1]] }]))
    expect(cells(original)).toEqual({ 0: { 0: { v: 'keep' } } })
  })
})

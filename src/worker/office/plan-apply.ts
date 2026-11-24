import type { OfficeAiOp, OfficeEditPlan } from '@shared/office/ai'
import { parseA1Range, rangeCellCount } from '@shared/office/a1'

/**
 * Applies an edit plan to a stored Sheets snapshot, without an editor.
 *
 * This exists for the writes nobody is watching: a scheduled automation has no browser, and the editor
 * Facade that normally applies a plan only lives in one. The supported set is deliberately narrow —
 * cell values and formulas on the sheets product — because those are pure JSON edits. Anything else is
 * refused by name rather than half-applied.
 */

interface SheetLike {
  name?: string
  cellData?: Record<string, Record<string, Record<string, unknown>>>
}

interface WorkbookLike {
  sheets?: Record<string, SheetLike>
  sheetOrder?: string[]
}

export class PlanApplyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanApplyError'
  }
}

function resolveSheet(workbook: WorkbookLike, sheetRef?: string): { id: string; sheet: SheetLike } {
  const sheets = workbook.sheets ?? {}
  const order = workbook.sheetOrder ?? Object.keys(sheets)
  if (!sheetRef) {
    const firstId = order[0]
    const first = firstId ? sheets[firstId] : undefined
    if (!firstId || !first) throw new PlanApplyError('The workbook has no sheet to write to')
    return { id: firstId, sheet: first }
  }
  if (sheets[sheetRef]) return { id: sheetRef, sheet: sheets[sheetRef]! }
  for (const id of order) {
    if (sheets[id]?.name === sheetRef) return { id, sheet: sheets[id]! }
  }
  throw new PlanApplyError(`No sheet named ${sheetRef} in this workbook`)
}

function cellDataOf(sheet: SheetLike): Record<string, Record<string, Record<string, unknown>>> {
  if (!sheet.cellData) sheet.cellData = {}
  return sheet.cellData
}

function writeCell(sheet: SheetLike, row: number, col: number, value: Record<string, unknown> | null): void {
  const cells = cellDataOf(sheet)
  const rowKey = String(row)
  const colKey = String(col)
  if (value === null) {
    const rowCells = cells[rowKey]
    if (!rowCells) return
    delete rowCells[colKey]
    if (Object.keys(rowCells).length === 0) delete cells[rowKey]
    return
  }
  cells[rowKey] = cells[rowKey] ?? {}
  cells[rowKey]![colKey] = value
}

function applyOp(workbook: WorkbookLike, op: OfficeAiOp): void {
  if (op.kind !== 'sheets.set-values' && op.kind !== 'sheets.set-formula') {
    throw new PlanApplyError(`A plan applied without an editor cannot run ${op.kind}`)
  }
  const { sheet } = resolveSheet(workbook, op.sheet)
  const rect = parseA1Range(op.range)
  if (!rect) throw new PlanApplyError(`${op.range} is not a cell range`)

  if (op.kind === 'sheets.set-formula') {
    if (rangeCellCount(rect) !== 1) throw new PlanApplyError('A formula is written to one cell at a time')
    writeCell(sheet, rect.startRow, rect.startCol, { f: op.formula })
    return
  }

  const rows = op.values.length
  const columns = op.values.reduce((widest, row) => Math.max(widest, row.length), 0)
  const height = rect.endRow - rect.startRow + 1
  const width = rect.endCol - rect.startCol + 1
  if (rows > height || columns > width) {
    throw new PlanApplyError(`${op.range} holds ${height}x${width} cells but the values need ${rows}x${columns}`)
  }
  for (let row = 0; row < rows; row += 1) {
    const cells = op.values[row] ?? []
    for (let column = 0; column < cells.length; column += 1) {
      const value = cells[column]
      writeCell(sheet, rect.startRow + row, rect.startCol + column, value === null || value === undefined ? null : { v: value })
    }
  }
}

/**
 * Returns a new snapshot; the input is never mutated, so a failed plan leaves the stored one untouched.
 */
export function applyPlanToSheetsSnapshot(snapshot: unknown, plan: OfficeEditPlan): unknown {
  const workbook = structuredClone(snapshot) as WorkbookLike
  if (!workbook || typeof workbook !== 'object' || !workbook.sheets) {
    throw new PlanApplyError('The stored snapshot is not a workbook')
  }
  for (const op of plan.ops) applyOp(workbook, op)
  return workbook
}

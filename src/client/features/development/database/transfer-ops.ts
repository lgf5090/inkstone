import { sqlLiteral } from './export-utils'
import { quoteIdent } from '@shared/development/database/sql-utils'
import type { StudioDriver } from './drivers'

const MAX_ROWS_PER_CHUNK = 50
const MAX_CHARS_PER_CHUNK = 120_000
const MAX_REPORTED_ERRORS = 5

export function buildRowInsert(table: string, columns: string[], row: unknown[]): string {
  return `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES (${columns.map((_, index) => sqlLiteral(row[index])).join(', ')})`
}

export function buildInsertManySql(table: string, columns: string[], rows: unknown[][]): string {
  return `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES ${rows.map((row) => `(${columns.map((_, index) => sqlLiteral(row[index])).join(', ')})`).join(', ')}`
}

function rowSize(columns: number, row: unknown[]): number {
  let size = 3
  for (let index = 0; index < columns; index++) {
    const value = row[index]
    if (value === null || value === undefined) size += 5
    else if (typeof value === 'string') size += value.length + 4
    else if (typeof value === 'number' || typeof value === 'boolean') size += 16
    else size += 64
  }
  return size
}

export function chunkInsertRows(columns: string[], rows: unknown[][]): unknown[][][] {
  const chunks: unknown[][][] = []
  let current: unknown[][] = []
  let chars = 0
  for (const row of rows) {
    const size = rowSize(columns.length, row)
    if (current.length > 0 && (current.length >= MAX_ROWS_PER_CHUNK || chars + size > MAX_CHARS_PER_CHUNK)) {
      chunks.push(current)
      current = []
      chars = 0
    }
    current.push(row)
    chars += size
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export interface InsertOutcome {
  inserted: number
  failed: number
  errors: string[]
}

export async function insertRowsInChunks(
  driver: Pick<StudioDriver, 'query'>,
  table: string,
  columns: string[],
  rows: unknown[][],
  onProgress?: (done: number) => void,
): Promise<InsertOutcome> {
  const outcome: InsertOutcome = { inserted: 0, failed: 0, errors: [] }
  if (rows.length === 0 || columns.length === 0) return outcome
  for (const chunk of chunkInsertRows(columns, rows)) {
    try {
      await driver.query(buildInsertManySql(table, columns, chunk))
      outcome.inserted += chunk.length
    } catch {
      for (const row of chunk) {
        try {
          await driver.query(buildRowInsert(table, columns, row))
          outcome.inserted += 1
        } catch (error) {
          outcome.failed += 1
          if (outcome.errors.length < MAX_REPORTED_ERRORS) {
            outcome.errors.push(error instanceof Error ? error.message : String(error))
          }
        }
      }
    }
    onProgress?.(outcome.inserted + outcome.failed)
  }
  return outcome
}

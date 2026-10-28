// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  DEVELOPMENT_GITHUB_REQUIRED_COLUMNS,
  DEVELOPMENT_GITHUB_REQUIRED_INDEXES,
  DEVELOPMENT_GITHUB_REQUIRED_TABLES,
  DEVELOPMENT_GITHUB_SCHEMA_STATEMENTS,
} from '../src/worker/development/github/schema'

describe('development github schema', () => {
  it('creates every required table, index and column', () => {
    const sqlite = new DatabaseSync(':memory:')
    for (const statement of DEVELOPMENT_GITHUB_SCHEMA_STATEMENTS) sqlite.exec(statement)

    const tables = new Set((sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((row) => row.name))
    for (const table of DEVELOPMENT_GITHUB_REQUIRED_TABLES) expect(tables.has(table), table).toBe(true)

    const indexes = new Set((sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>).map((row) => row.name))
    for (const index of DEVELOPMENT_GITHUB_REQUIRED_INDEXES) expect(indexes.has(index), index).toBe(true)

    for (const [table, columns] of Object.entries(DEVELOPMENT_GITHUB_REQUIRED_COLUMNS)) {
      const actual = new Set((sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name))
      for (const column of columns) expect(actual.has(column), `${table}.${column}`).toBe(true)
    }
    sqlite.close()
  })

  it('is idempotent', () => {
    const sqlite = new DatabaseSync(':memory:')
    for (const statement of DEVELOPMENT_GITHUB_SCHEMA_STATEMENTS) sqlite.exec(statement)
    for (const statement of DEVELOPMENT_GITHUB_SCHEMA_STATEMENTS) sqlite.exec(statement)
    sqlite.close()
  })
})

// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { isXgetProxyPath } from '../src/worker/development/xget/paths'
import {
  DEVELOPMENT_XGET_REQUIRED_COLUMNS,
  DEVELOPMENT_XGET_REQUIRED_TABLES,
  DEVELOPMENT_XGET_SCHEMA_STATEMENTS,
} from '../src/worker/development/xget/schema'

describe('the Xget proxy path boundary', () => {
  it('takes every public proxy address, including the bare root', () => {
    expect(isXgetProxyPath('/api/development/xget')).toBe(true)
    expect(isXgetProxyPath('/api/development/xget/')).toBe(true)
    expect(isXgetProxyPath('/api/development/xget/gh/x/y')).toBe(true)
    expect(isXgetProxyPath('/api/development/xget/settingsfoo')).toBe(true)
    expect(isXgetProxyPath('/api/development/xget/statsbar')).toBe(true)
  })

  it('keeps the management prefixes out of the proxy', () => {
    expect(isXgetProxyPath('/api/development/xget/settings')).toBe(false)
    expect(isXgetProxyPath('/api/development/xget/settings/')).toBe(false)
    expect(isXgetProxyPath('/api/development/xget/settings/token')).toBe(false)
    expect(isXgetProxyPath('/api/development/xget/stats/summary')).toBe(false)
    expect(isXgetProxyPath('/api/development/other/xget')).toBe(false)
    expect(isXgetProxyPath('/development/xget')).toBe(false)
  })
})

describe('the Xget tables', () => {
  it('are created by their own statements with the required columns', () => {
    const db = new DatabaseSync(':memory:')
    for (const statement of DEVELOPMENT_XGET_SCHEMA_STATEMENTS) db.exec(statement)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    const names = new Set(tables.map((table) => table.name))
    for (const table of DEVELOPMENT_XGET_REQUIRED_TABLES) {
      expect(names.has(table)).toBe(true)
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      const actual = new Set(columns.map((column) => column.name))
      for (const column of DEVELOPMENT_XGET_REQUIRED_COLUMNS[table] ?? []) {
        expect(actual.has(column)).toBe(true)
      }
    }
    db.exec(`INSERT INTO development_xget_settings (id, config_json, proxy_token_hash, updated_at)
             VALUES (1, '{}', '', 1)`)
    expect(() => db.exec(`INSERT INTO development_xget_settings (id, config_json, proxy_token_hash, updated_at)
                          VALUES (2, '{}', '', 1)`)).toThrow()
    db.close()
  })
})

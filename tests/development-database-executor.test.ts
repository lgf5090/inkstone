// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  queries: [] as Array<{ sql: string; params: unknown[] }>,
}))

vi.mock('../src/worker/development/database/query', () => ({
  executeQuery: async (_env: unknown, _db: unknown, _userId: string, _connectionId: string, sql: string, params: unknown[] = []) => {
    state.queries.push({ sql, params })
    return { columns: ['a'], rows: [[1]], durationMs: 1 }
  },
}))

vi.mock('../src/worker/development/database/store', () => ({
  listConnections: async () => [{ id: '0123456789abcdefghjkmnpqrs', name: 'One', type: 'd1', d1DatabaseName: 'db' }],
}))

import { executeDatabaseTool, formatToolResult } from '../src/worker/development/database/executor'
import type { Env } from '../src/worker/env'

const env = { DB: {} } as Env

beforeEach(() => {
  state.queries = []
})

describe('database tool executor', () => {
  it('formats rows and truncates cell text', () => {
    const formatted = formatToolResult({ columns: ['a', 'b'], rows: [[1, 'x'.repeat(600)]], durationMs: 1 })
    expect(formatted.rows[0]?.a).toBe(1)
    expect(String(formatted.rows[0]?.b).endsWith('…')).toBe(true)
    expect(formatted.truncated).toBe(false)
  })

  it('lists tables by name', async () => {
    const result = await executeDatabaseTool(env, 'u1', 'list_tables', { connectionId: '0123456789abcdefghjkmnpqrs' }) as { rows: unknown[] }
    expect(result.rows).toHaveLength(1)
    expect(state.queries[0]?.sql).toContain('sqlite_master')
  })

  it('requires confirm for writes and accepts reads', async () => {
    await expect(executeDatabaseTool(env, 'u1', 'run_query', {
      connectionId: '0123456789abcdefghjkmnpqrs',
      sql: 'delete from t',
    })).rejects.toThrow('confirm')
    expect(state.queries).toHaveLength(0)

    await executeDatabaseTool(env, 'u1', 'run_query', {
      connectionId: '0123456789abcdefghjkmnpqrs',
      sql: 'delete from t',
      confirm: true,
    })
    expect(state.queries).toHaveLength(1)

    await executeDatabaseTool(env, 'u1', 'run_query', {
      connectionId: '0123456789abcdefghjkmnpqrs',
      sql: 'select * from t',
    })
    expect(state.queries).toHaveLength(2)
  })

  it('quotes a preview table and clamps its limit', async () => {
    await executeDatabaseTool(env, 'u1', 'preview_table', { connectionId: '0123456789abcdefghjkmnpqrs', table: 't', limit: 150 })
    expect(state.queries[0]?.sql).toBe('SELECT * FROM "t" LIMIT ?')
    expect(state.queries[0]?.params).toEqual([150])
  })

  it('prefixes explain queries', async () => {
    await executeDatabaseTool(env, 'u1', 'explain_query', { connectionId: '0123456789abcdefghjkmnpqrs', sql: 'select 1' })
    expect(state.queries[0]?.sql).toBe('EXPLAIN QUERY PLAN select 1')
  })
})

import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { organizeMcpNote, trashMcpNote, type McpWriteContext } from '../src/worker/mcp/writes'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'

let sqlite: DatabaseSync
let context: McpWriteContext
let bodyReads: number

function seedNote(id: string, rev: number, content: string) {
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, title, title_key, content, excerpt, rev, word_count, char_count,
       is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, '', ?, 1, 4, 0, 0, 0, 0, 'hash', 1, 1, NULL)`,
  ).run(id, USER, `Note ${id}`, `note ${id}`, content, rev)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  seedNote('n1', 3, 'body')
  const raw = makeD1(sqlite)
  bodyReads = 0
  const prepare = raw.prepare.bind(raw)
  // Counts the statements that pull the note body: the whole point of the read-back merge.
  const db = Object.assign({}, raw, {
    prepare: (sql: string) => {
      if (/n\.content(?!_)/.test(sql)) bodyReads++
      return prepare(sql)
    },
  }) as unknown as D1Database
  context = {
    env: { DB: db } as unknown as Env,
    userId: USER,
    ftsEnabled: false,
    executionCtx: { waitUntil: () => {} } as ExecutionContext,
  }
})

const storedResponse = (operationId: string) => JSON.parse(
  String(sqlite.prepare('SELECT response_json FROM mcp_operations WHERE operation_id = ?').get(operationId)?.response_json),
) as Record<string, unknown>

const row = () => sqlite.prepare('SELECT rev, is_starred, deleted_at, content FROM notes WHERE id = ?').get('n1')

describe('MCP organize/trash read-back', () => {
  it('returns the updated note with its body while reading the body once', async () => {
    const note = await organizeMcpNote(context, {
      operationId: 'op-star-0001',
      noteId: 'n1',
      expectedRev: 3,
      starred: true,
    })
    // The cached/returned note carries no body: the tool response never exposed one.
    expect(note).toMatchObject({ id: 'n1', rev: 4, isStarred: true, content: '' })
    expect(storedResponse('op-star-0001')).toMatchObject({ id: 'n1', rev: 4, content: '' })
    expect(bodyReads).toBe(1)
    expect(row()).toMatchObject({ rev: 4, is_starred: 1, deleted_at: null })
  })

  it('replays the stored response for a repeated operation id', async () => {
    const input = { operationId: 'op-twice-0002', noteId: 'n1', expectedRev: 3, pinned: true }
    await organizeMcpNote(context, input)
    const replay = await organizeMcpNote(context, input)
    expect(replay).toMatchObject({ rev: 4, isPinned: true })
    expect(bodyReads).toBe(1)
  })

  it('reports a stale revision with the current server note, without a third read', async () => {
    seedNote('n2', 1, 'other')
    await organizeMcpNote(context, { operationId: 'op-meta-0003', noteId: 'n2', expectedRev: 1, starred: true })
    const before = bodyReads
    sqlite.prepare('UPDATE notes SET is_archived = 1 WHERE id = ?').run('n2')
    await expect(organizeMcpNote(context, {
      operationId: 'op-meta-0004',
      noteId: 'n2',
      expectedRev: 1,
      archived: true,
    })).rejects.toMatchObject({ status: 409, details: { server: { rev: 2, content: 'other' } } })
    // The conflict payload is built from a fresh full read, so it still carries the body.
    expect(bodyReads - before).toBe(1)
  })

  it('trashes with a metadata-only pre-read and one body read', async () => {
    const note = await trashMcpNote(context, { operationId: 'op-trash-0005', noteId: 'n1', expectedRev: 3 })
    expect(note).toMatchObject({ id: 'n1', rev: 4, content: '' })
    expect(row()?.deleted_at).not.toBeNull()
    expect(bodyReads).toBe(1)
  })
})

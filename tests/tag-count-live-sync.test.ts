import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { syncRoutes } from '../src/worker/routes/sync'
import type { AppBindings } from '../src/worker/env'
import type { SyncResponse } from '../src/shared/types'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'
const OTHER = 'user-b'

let sqlite: DatabaseSync
let db: D1Database
let app: Hono<AppBindings>

function note(id: string, userId = USER) {
  sqlite.prepare(
    'INSERT INTO notes (id, user_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)',
  ).run(id, userId, id, `body of ${id}`)
}

function tag(id: string, name: string, userId = USER) {
  sqlite.prepare('INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, 1)')
    .run(id, userId, name)
}

function link(noteId: string, tagId: string) {
  sqlite.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(noteId, tagId)
}

function unlink(noteId: string, tagId: string) {
  sqlite.prepare('DELETE FROM note_tags WHERE note_id = ? AND tag_id = ?').run(noteId, tagId)
}

function change(entity: string, entityId: string, op: string, userId = USER) {
  sqlite.prepare('INSERT INTO changes (user_id, entity, entity_id, op, at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, entity, entityId, op, Date.now())
}

function lastSeq(): number {
  const row = sqlite.prepare('SELECT MAX(seq) AS seq FROM changes').get() as { seq: number | null }
  return row.seq ?? 0
}

// `since <= 0` makes the route answer with a full snapshot, which always carries full facets.
// Every delta assertion therefore needs a change row behind it to stay on the delta branch.
function deltaFloor(): number {
  change('settings', 'settings', 'upsert')
  return lastSeq()
}

async function delta(since: number): Promise<SyncResponse> {
  const response = await app.fetch(
    new Request(`http://localhost/api/sync?since=${since}`),
    { DB: db } as never,
  )
  return await response.json() as SyncResponse
}

function countOf(body: SyncResponse, name: string): number | undefined {
  return body.tags.find((item) => item.name === name)?.count
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  app = new Hono<AppBindings>()
  app.use('*', async (c, next) => {
    c.set('userId', USER)
    await next()
  })
  app.route('/api/sync', syncRoutes)
})

describe('a note change recomputes the sidebar tag counts', () => {
  it('drops the count when a note stops carrying the tag', async () => {
    tag('t-red', 'red')
    note('n1')
    note('n2')
    link('n1', 't-red')
    link('n2', 't-red')
    const floor = deltaFloor()
    change('note', 'n1', 'upsert')
    const baseline = await delta(floor)
    expect(baseline.full).toBe(false)
    expect(countOf(baseline, 'red')).toBe(2)
    expect(baseline.cursor).toBe(lastSeq())

    unlink('n1', 't-red')
    change('note', 'n1', 'upsert')
    const after = await delta(baseline.cursor)
    expect(after.full).toBe(false)
    expect(after.facetsFull).toBe(true)
    expect(countOf(after, 'red')).toBe(1)
  })

  it('drops the count when the only tagged note is deleted', async () => {
    tag('t-blue', 'blue')
    note('n1')
    note('n2')
    link('n1', 't-blue')
    const cursor = deltaFloor()

    unlink('n1', 't-blue')
    sqlite.prepare('DELETE FROM notes WHERE id = ?').run('n1')
    change('note', 'n1', 'delete')
    const after = await delta(cursor)
    expect(after.notes).toEqual([])
    expect(after.deletions).toEqual([{ entity: 'note', id: 'n1' }])
    expect(after.facetsFull).toBe(true)
    expect(countOf(after, 'blue')).toBe(0)
  })

  it('leaves the counts alone when only a tag row changed', async () => {
    tag('t-red', 'red')
    note('n1')
    link('n1', 't-red')
    const floor = deltaFloor()
    change('tag', 't-red', 'upsert')
    const after = await delta(floor)
    expect(after.full).toBe(false)
    expect(after.facetsFull).toBe(false)
    expect(after.tags.map((item) => [item.id, item.count])).toEqual([['t-red', 1]])
  })

  it('never counts another account or an archived note', async () => {
    tag('t-red', 'red')
    tag('t-red-other', 'red', OTHER)
    note('mine')
    note('mine-archived')
    note('theirs', OTHER)
    sqlite.prepare('UPDATE notes SET is_archived = 1 WHERE id = ?').run('mine-archived')
    link('mine', 't-red')
    link('mine-archived', 't-red')
    link('theirs', 't-red-other')
    const floor = deltaFloor()
    change('note', 'mine', 'upsert')
    const after = await delta(floor)
    expect(after.full).toBe(false)
    expect(countOf(after, 'red')).toBe(1)
    expect(after.tags.map((item) => item.id)).toEqual(['t-red'])
  })
})

import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { notesRoutes } from '../src/worker/routes/notes'
import type { AppBindings } from '../src/worker/env'
import type { ListNotesResponse } from '../src/shared/types'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'
const OTHER = 'user-b'

let sqlite: DatabaseSync
let app: Hono<AppBindings>
let env: { DB: D1Database }
const ctx = { waitUntil: () => {} } as ExecutionContext

function note(id: string, userId = USER, flags: { archived?: boolean; deleted?: number } = {}) {
  sqlite.prepare(
    'INSERT INTO notes (id, user_id, title, content, created_at, updated_at, is_archived, deleted_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?)',
  ).run(id, userId, id, `body ${id}`, flags.archived ? 1 : 0, flags.deleted ?? null)
}

function tag(id: string, name: string, userId = USER) {
  sqlite.prepare('INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, 1)').run(id, userId, name)
}

function link(noteId: string, tagId: string) {
  sqlite.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(noteId, tagId)
}

async function list(query: string): Promise<ListNotesResponse> {
  const response = await app.fetch(new Request(`http://localhost/api/notes?${query}`), env as never, ctx)
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return await response.json() as ListNotesResponse
}

const ids = (response: ListNotesResponse) => response.notes.map((item) => item.id).sort()

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = { DB: makeD1(sqlite) }
  app = new Hono<AppBindings>()
  app.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  app.route('/api/notes', notesRoutes)
})

describe('the untagged view', () => {
  beforeEach(() => {
    tag('t-work', 'work')
    tag('t-fun', 'fun')
    note('bare')
    note('one-tag')
    note('two-tags')
    note('archived-bare', USER, { archived: true })
    note('trashed-tag', USER, { deleted: 1_700_000_000_000 })
    note('theirs', OTHER)
    link('one-tag', 't-work')
    link('two-tags', 't-work')
    link('two-tags', 't-fun')
    link('trashed-tag', 't-work')
  })

  it('lists only live notes that carry no tag', async () => {
    expect(ids(await list('view=untagged'))).toEqual(['bare'])
  })

  it('agrees with the all view minus the tagged ones', async () => {
    const all = ids(await list('view=all'))
    const untagged = ids(await list('view=untagged'))
    const tagged = ids(await list('view=tag&tag=work'))
    expect(all).toEqual(['bare', 'one-tag', 'two-tags'])
    expect(untagged.concat(tagged).sort()).toEqual(all)
  })

  it('still paginates and reports a total', async () => {
    const response = await list('view=untagged&limit=1')
    expect(response.notes).toHaveLength(1)
    expect(response.total).toBe(1)
    expect(response.nextCursor).toBeNull()
  })
})

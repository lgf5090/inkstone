import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { errorResponse } from '../src/worker/lib/errors'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { notesRoutes } from '../src/worker/routes/notes'
import type { AppBindings, Env } from '../src/worker/env'
import type { ListNotesResponse } from '../src/shared/types'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = 'user-a'

let sqlite: DatabaseSync
let app: Hono<AppBindings>
let env: Env
// Typed as the context `app.fetch` actually declares, so every field the route may read has to be
// there: the ambient Workers interface is wider than hono needs and cannot be faked outside a Worker.
const ctx: ExecutionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
}

function note(id: string, flags: { pinned?: boolean; archived?: boolean; deleted?: number } = {}) {
  sqlite.prepare(
    'INSERT INTO notes (id, user_id, title, content, created_at, updated_at, is_pinned, is_archived, deleted_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)',
  ).run(id, USER, id, `body ${id}`, flags.pinned ? 1 : 0, flags.archived ? 1 : 0, flags.deleted ?? null)
}

async function list(query: string): Promise<string[]> {
  const response = await app.fetch(new Request(`http://localhost/api/notes?${query}`), env, ctx)
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return (await response.json() as ListNotesResponse).notes.map((item) => item.id).sort()
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite))
  app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  app.route('/api/notes', notesRoutes)
})

describe('the pinned view', () => {
  beforeEach(() => {
    note('pinned', { pinned: true })
    note('plain')
    note('pinned-archived', { pinned: true, archived: true })
    note('pinned-trashed', { pinned: true, deleted: 2 })
  })

  it('keeps the pinned notes that are still live, and only those', async () => {
    expect(await list('view=pinned')).toEqual(['pinned'])
    // The other views answer for their own state, so neither of the two above is lost to the pin.
    expect(await list('view=archived')).toEqual(['pinned-archived'])
    expect(await list('view=trash')).toEqual(['pinned-trashed'])
  })

  it('leaves every other view as it was', async () => {
    expect(await list('view=all')).toEqual(['pinned', 'plain'])
    expect(await list('view=starred')).toEqual([])
  })
})

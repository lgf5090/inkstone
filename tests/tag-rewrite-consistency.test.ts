// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { tagsRoutes } from '../src/worker/routes/tags'
import { rewriteTagInNotes } from '../src/worker/tags/store'
import { drainRewriteQueues } from '../src/worker/lib/rewrite-drain'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'
const TAG = 'tag-old'
const ctx: ExecutionContext = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} }
let sqlite: DatabaseSync
let env: { DB: D1Database }
let app: Hono<AppBindings>

function seed(count: number): void {
  sqlite.prepare('INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, 1)').run(TAG, USER, 'old')
  for (let index = 0; index < count; index++) {
    const id = `n-${index}`
    sqlite.prepare('INSERT INTO notes (id, user_id, title, content, rev, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, 1)')
      .run(id, USER, id, 'body #old tail')
    sqlite.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(id, TAG)
  }
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = { DB: makeD1(sqlite) }
  app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  app.route('/api/tags', tagsRoutes)
})

describe('tag rewrite consistency', () => {
  it('finds deferred delete candidates after the source memberships are gone', async () => {
    seed(21)
    const response = await app.fetch(new Request('http://localhost/api/tags/tag-old', { method: 'DELETE' }), env as never, ctx)
    expect(response.status).toBe(200)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM note_tags WHERE tag_id = ?').get(TAG)).toMatchObject({ n: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM rewrite_queue').get()).toMatchObject({ n: 1 })

    await drainRewriteQueues(env as unknown as Env, false, 5, 60)

    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM rewrite_queue').get()).toMatchObject({ n: 0 })
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM notes WHERE instr(content, '#old') > 0").get()).toMatchObject({ n: 0 })
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM notes WHERE instr(content, '#new') > 0").get()).toMatchObject({ n: 0 })
  })

  it('rolls back with a newer revision and removes the rewrite snapshot', async () => {
    seed(1)
    const rewrite = await rewriteTagInNotes(env, false, USER, TAG, 'old', 'new')
    expect(rewrite.rewritten).toBe(1)
    expect(sqlite.prepare("SELECT rev, content FROM notes WHERE id = 'n-0'").get()).toMatchObject({ rev: 2, content: 'body #new tail' })

    await rewrite.rollback()

    expect(sqlite.prepare("SELECT rev, content FROM notes WHERE id = 'n-0'").get()).toMatchObject({ rev: 3, content: 'body #old tail' })
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = 'n-0'").get()).toMatchObject({ n: 0 })
  })
})

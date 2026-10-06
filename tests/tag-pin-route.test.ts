import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { tagsRoutes } from '../src/worker/routes/tags'
import type { AppBindings } from '../src/worker/env'
import type { Tag } from '../src/shared/types'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'

let sqlite: DatabaseSync
let app: Hono<AppBindings>
let env: { DB: D1Database }
const ctx = { waitUntil: () => {} } as ExecutionContext

function call(method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env as never,
    ctx,
  )
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return await response.json() as T
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  const db = makeD1(sqlite)
  env = { DB: db }
  app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  app.route('/api/tags', tagsRoutes)
})

async function createNoteWithTags(id: string, tags: string[]): Promise<void> {
  const body = ['---', `tags: [${tags.join(', ')}]`, '---', '', `body ${id}`].join('\n')
  sqlite.prepare(
    'INSERT INTO notes (id, user_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)',
  ).run(id, USER, id, body)
  for (const name of tags) {
    const tagId = `tag-${name.replace(/\W/g, '_')}`
    const seen = sqlite.prepare('SELECT id FROM tags WHERE id = ?').get(tagId)
    if (!seen) {
      sqlite.prepare('INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, 1)')
        .run(tagId, USER, name)
    }
    sqlite.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(id, tagId)
  }
}

describe('tag pinning', () => {
  it('round-trips the pinned flag through the list and patch endpoints', async () => {
    await createNoteWithTags('n1', ['demo'])
    const created = await json<Tag>(await call('POST', '/api/tags', { name: 'pinned', color: null }))
    expect(created.isPinned).toBe(false)

    const patched = await json<Tag>(await call('PATCH', `/api/tags/${created.id}`, { isPinned: true }))
    expect(patched.isPinned).toBe(true)

    const listed = await json<{ tags: Tag[] }>(await call('GET', '/api/tags'))
    expect(listed.tags.find((tag) => tag.name === 'pinned')?.isPinned).toBe(true)
    expect(listed.tags.find((tag) => tag.name === 'demo')?.isPinned).toBe(false)
    expect(listed.tags.find((tag) => tag.name === 'pinned')?.count).toBe(0)
  })

  it('emits a tag change row so every client re-reads the flag', async () => {
    const created = await json<Tag>(await call('POST', '/api/tags', { name: 'demo' }))
    await call('PATCH', `/api/tags/${created.id}`, { isPinned: true })
    const rows = sqlite.prepare(
      "SELECT entity, op FROM changes WHERE user_id = ? AND entity = 'tag'",
    ).all(USER) as { entity: string; op: string }[]
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.at(-1)).toEqual({ entity: 'tag', op: 'upsert' })
  })

  it('refuses a non-boolean flag and a rename sent together', async () => {
    const created = await json<Tag>(await call('POST', '/api/tags', { name: 'demo' }))
    expect((await call('PATCH', `/api/tags/${created.id}`, { isPinned: 'yes' })).status).toBe(400)
    expect((await call('PATCH', `/api/tags/${created.id}`, { isPinned: true, name: 'other' })).status).toBe(400)
    const listed = await json<{ tags: Tag[] }>(await call('GET', '/api/tags'))
    expect(listed.tags.map((tag) => [tag.name, Boolean(tag.isPinned)])).toEqual([['demo', false]])
  })

  it('keeps the flag off tags that were never pinned after a rename', async () => {
    const created = await json<Tag>(await call('POST', '/api/tags', { name: 'demo' }))
    await call('PATCH', `/api/tags/${created.id}`, { isPinned: true })
    await call('PATCH', `/api/tags/${created.id}`, { name: 'renamed' })
    const listed = await json<{ tags: Tag[] }>(await call('GET', '/api/tags'))
    expect(listed.tags.map((tag) => [tag.name, Boolean(tag.isPinned)])).toEqual([['renamed', true]])
  })
})

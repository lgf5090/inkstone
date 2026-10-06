import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { errorResponse } from '../src/worker/lib/errors'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { tagsRoutes } from '../src/worker/routes/tags'
import type { AppBindings } from '../src/worker/env'
import type { Tag } from '../src/shared/types'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'

let sqlite: DatabaseSync
let app: Hono<AppBindings>
let env: { DB: D1Database }
const ctx = { waitUntil: () => {} } as ExecutionContext

function note(id: string, content: string) {
  sqlite.prepare(
    'INSERT INTO notes (id, user_id, title, content, rev, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, 1)',
  ).run(id, USER, id, content)
}

function tag(name: string): string {
  const id = `t-${name.replace(/\W/g, '_')}`
  sqlite.prepare('INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, 1)').run(id, USER, name)
  return id
}

function link(noteId: string, tagId: string) {
  sqlite.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(noteId, tagId)
}

async function call(method: string, path: string, body?: unknown) {
  return app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env as never, ctx)
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return await response.json() as T
}

async function names(): Promise<string[]> {
  const listed = await json<{ tags: Tag[] }>(await call('GET', '/api/tags'))
  return listed.tags.map((tag) => tag.name).sort()
}

function content(id: string): string {
  const row = sqlite.prepare('SELECT content FROM notes WHERE id = ?').get(id) as { content: string }
  return row.content
}

async function move(id: string, parent: string | null) {
  return call('POST', `/api/tags/${id}/move`, { parent })
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

describe('moving a tag between levels', () => {
  it('re-hangs a leaf under another tag and rewrites the note body', async () => {
    const meeting = tag('meeting')
    tag('work')
    note('n1', '---\ntags: [meeting, work]\n---\n\u6b63\u6587')
    link('n1', meeting)

    const response = await json<{ ok: true; moved: number }>(await move(meeting, 'work'))
    expect(response.moved).toBe(1)
    expect(await names()).toEqual(['work', 'work/meeting'])
    expect(content('n1')).toContain('work/meeting')
    expect(content('n1')).not.toContain('[meeting')
  })

  it('carries every descendant along with the parent', async () => {
    const root = tag('topic')
    const child = tag('topic/deep')
    const grand = tag('topic/deep/deeper')
    tag('inbox')
    note('a', '---\ntags: [topic]\n---\n')
    note('b', '---\ntags: [topic/deep]\n---\n')
    note('c', '---\ntags: [topic/deep/deeper]\n---\n')
    link('a', root)
    link('b', child)
    link('c', grand)

    const response = await json<{ ok: true; moved: number }>(await move(root, 'inbox'))
    expect(response.moved).toBe(3)
    expect(await names()).toEqual([
      'inbox', 'inbox/topic', 'inbox/topic/deep', 'inbox/topic/deep/deeper',
    ])
    expect(content('a')).toContain('inbox/topic')
    expect(content('b')).toContain('inbox/topic/deep')
    expect(content('c')).toContain('inbox/topic/deep/deeper')
    expect(content('b')).not.toContain('topic/deep]')
  })

  it('lifts a nested tag back to the top level', async () => {
    const nested = tag('work/meeting')
    tag('work')
    note('n1', '---\ntags: [work/meeting]\n---\n')
    link('n1', nested)

    expect((await json<{ moved: number }>(await move(nested, null))).moved).toBe(1)
    expect(await names()).toContain('meeting')
    expect(content('n1')).toContain('meeting')
  })

  it('leaves an unrelated tag that merely shares a prefix alone', async () => {
    const root = tag('a')
    const sibling = tag('ab')
    tag('a/x')
    tag('p')
    note('n1', '---\ntags: [ab]\n---\nbody #ab here')
    link('n1', sibling)

    const moved = await json<{ ok: true; moved: number }>(await move(root, 'p'))
    expect(moved.moved).toBe(2)
    expect(await names()).toEqual(['ab', 'p', 'p/a', 'p/a/x'])
    expect(content('n1')).toContain('tags: [ab]')
    expect(content('n1')).toContain('body #ab here')
    expect(content('n1')).not.toContain('p/ab')
    void root
  })

  it('refuses to drop a tag inside its own subtree', async () => {
    const root = tag('work')
    tag('work/deep')
    expect((await move(root, 'work/deep')).status).toBe(400)
    expect((await move(root, 'work')).status).toBe(400)
  })

  it('refuses a target name another branch already owns and changes nothing', async () => {
    const root = tag('topic')
    tag('topic/child')
    tag('inbox/topic/child')
    note('n1', '---\ntags: [topic, topic/child]\n---\n')
    link('n1', root)

    const response = await move(root, 'inbox')
    expect(response.status).toBe(409)
    expect(await names()).toEqual(['inbox/topic/child', 'topic', 'topic/child'])
    expect(content('n1')).toContain('tags: [topic, topic/child]')
  })

  it('emits an upsert and a delete change row per moved member so clients re-read the tree', async () => {
    const root = tag('topic')
    tag('topic/child')
    tag('inbox')
    void root
    const before = sqlite.prepare('SELECT COUNT(*) AS n FROM changes WHERE entity = ?')
      .get('tag') as { n: number }
    await move(root, 'inbox')
    const after = sqlite.prepare('SELECT COUNT(*) AS n FROM changes WHERE entity = ?')
      .get('tag') as { n: number }
    expect(after.n - before.n).toBe(4)
  })

  it('rejects a malformed parent', async () => {
    const leaf = tag('topic')
    expect((await move(leaf, 'a b')).status).toBe(400)
    expect((await call('POST', `/api/tags/${leaf}/move`, { parent: '' })).status).toBe(400)
    expect((await call('POST', `/api/tags/${leaf}/move`, {})).status).toBe(400)
    expect((await call('POST', '/api/tags/nope/move', { parent: 'x' })).status).toBe(404)
  })
})

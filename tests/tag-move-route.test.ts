import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { LIMITS } from '../src/shared/constants'
import { extractTags } from '../src/shared/markdown-utils'
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

describe('renaming a parent carries its subtree', () => {
  async function rename(id: string, name: string) {
    return json<{ ok: true; renamed: number; moved?: number }>(
      await call('PATCH', `/api/tags/${id}`, { name }))
  }

  let work: string
  let meeting: string
  let eu: string

  beforeEach(() => {
    work = tag('work')
    meeting = tag('work/meeting')
    eu = tag('work/meeting/eu')
    note('a', '---\ntags: [work]\n---\n')
    note('b', '---\ntags: [work/meeting]\n---\nbody #work/meeting tail')
    note('c', '---\ntags: [work/meeting/eu]\n---\n')
    link('a', work)
    link('b', meeting)
    link('c', eu)
  })

  it('renames every descendant, not just the row that was clicked', async () => {
    const result = await rename(work, 'job')
    expect(result.moved).toBe(3)
    expect(await names()).toEqual(['job', 'job/meeting', 'job/meeting/eu'])
    expect(content('a')).toContain('tags: [job]')
    expect(content('b')).toContain('job/meeting')
    expect(content('c')).toContain('job/meeting/eu')
  })

  it('leaves an unrelated prefix sibling alone', async () => {
    const workflow = tag('workflow')
    note('w', '---\ntags: [workflow]\n---\nsee #workflow')
    link('w', workflow)
    await rename(work, 'job')
    expect(await names()).toContain('workflow')
    expect(content('w')).toContain('#workflow')
    expect(content('w')).not.toContain('#job')
  })

  it('a leaf rename takes the single-row path and does the literal thing asked', async () => {
    const result = await rename(eu, 'emea')
    expect(result.moved).toBeUndefined()
    expect(await names()).toEqual(['emea', 'work', 'work/meeting'])
    expect(content('c')).toContain('emea')
  })

  it('merges into a tag that already owns the target subtree name', async () => {
    const existing = tag('job/meeting')
    note('d', '---\ntags: [job/meeting]\n---\n')
    link('d', existing)
    const result = await rename(work, 'job')
    expect(result.moved).toBe(3)
    const listed = await json<{ tags: Tag[] }>(await call('GET', '/api/tags'))
    const meetings = listed.tags.filter((tagged) => tagged.name === 'job/meeting')
    expect(meetings).toHaveLength(1)
    expect(meetings[0]!.count).toBe(2)
  })
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
    expect(extractTags(content('b'))).toEqual(['inbox/topic/deep'])
  })

  it('splits a long family into batches no bigger than the ceiling used elsewhere', async () => {
    // Six statements per family member, so fifteen of them are ninety. node:sqlite runs a batch
    // of any size, so only counting the calls here can catch an unchunked one.
    let deepest = 0
    let total = 0
    const inner = env.DB
    env = {
      DB: {
        ...inner,
        batch: async (statements: unknown[]) => {
          deepest = Math.max(deepest, statements.length)
          total += statements.length
          return inner.batch(statements as never[])
        },
      } as unknown as D1Database,
    }
    let chain = 'topic'
    const chainNames = [chain]
    const root = tag(chain)
    for (let level = 2; level <= 15; level++) {
      chain = `${chain}/n${level}`
      chainNames.push(chain)
      tag(chain)
    }
    tag('inbox')

    const response = await json<{ ok: true; moved: number }>(await move(root, 'inbox'))
    expect(response.moved).toBe(15)
    expect(total).toBe(15 * 6)
    expect(deepest).toBeLessThanOrEqual(80)
    expect(deepest).toBeGreaterThan(0)
    expect(await names()).toEqual(['inbox', ...chainNames.map((name) => `inbox/${name}`)].sort())
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

  it('refuses a case-variant of a name outside the family', async () => {
    const root = tag('topic')
    tag('topic/deep')
    tag('Inbox')
    tag('Inbox/Topic')
    const response = await move(root, 'inbox')
    expect(response.status).toBe(409)
    expect(await names()).toEqual(['Inbox', 'Inbox/Topic', 'topic', 'topic/deep'])
  })

  it('refuses a move whose cascade would outgrow the name cap', async () => {
    const root = tag('topic')
    tag('topic/deep')
    const response = await move(root, 'p'.repeat(LIMITS.tagNameMaxLength - 4))
    expect(response.status).toBe(400)
    expect(await names()).toEqual(['topic', 'topic/deep'])
  })

  it('rejects a malformed parent', async () => {
    const leaf = tag('topic')
    expect((await move(leaf, 'a b')).status).toBe(400)
    expect((await call('POST', `/api/tags/${leaf}/move`, { parent: '' })).status).toBe(400)
    expect((await call('POST', `/api/tags/${leaf}/move`, {})).status).toBe(400)
    expect((await call('POST', '/api/tags/nope/move', { parent: 'x' })).status).toBe(404)
  })
})

describe('refusing names the library cannot carry', () => {
  it('stops a rename whose cascade would outgrow the name cap', async () => {
    const root = tag('work')
    tag('work/meeting')
    const response = await call('PATCH', `/api/tags/${root}`, { name: 'j'.repeat(LIMITS.tagNameMaxLength) })
    expect(response.status).toBe(400)
    expect(await names()).toEqual(['work', 'work/meeting'])
  })

  it('rejects a separator in a created or renamed name', async () => {
    const root = tag('work')
    expect((await call('POST', '/api/tags', { name: 'a\uFF0Cb' })).status).toBe(400)
    expect((await call('PATCH', `/api/tags/${root}`, { name: 'a;b' })).status).toBe(400)
    expect(await names()).toEqual(['work'])
  })
})

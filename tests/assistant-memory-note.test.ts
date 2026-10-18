// @vitest-environment node
/**
 * The facts one note is the source of, read from the note's own side.
 *
 * `chat_memories.note_id` already says which page a fact was written out as, and the memory page shows it.
 * The note never answered back: standing on the page there was no way to see what the assistant had
 * remembered about it, even though the row that would answer is one column away. This reads that column
 * from the other end, and the four things worth pinning are all about what a *refusal* must not look like.
 *
 *  - A foreign note id and a malformed one both answer with nothing. Either one answered with the whole
 *    library instead, and the note's backlink panel would print every fact the reader has ever saved.
 *  - Another account's fact filed under the same note id stays invisible: every row here is keyed by
 *    `(user_id, id)`, and the note id is not the tenant.
 *  - The counts come back for the same set as the rows. A header that says "12 saved" beside three rows is
 *    a claim the answer does not support.
 *  - The read reaches an index that starts with `user_id`. The account's facts are few and the vault's are
 *    not, so an unindexed note filter is a scan of every row on every keystroke of the panel's refresh.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { AssistantStore } from '../src/worker/assistant/store'
import type { AppBindings, Env } from '../src/worker/env'
import type { AssistantMemory } from '../src/shared/assistant'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER_USER = '0123456789abcdefghjkmnpqrst'
const NOTE = '01hzzzzzzzzzzzzzzzzzzzzz11'
const OTHER_NOTE = '01hzzzzzzzzzzzzzzzzzzzzz22'

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore
let app: Hono<AppBindings>
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext

function buildApp(userId: string): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  instance.route('/api/assistant', assistantRoutes)
  return instance
}

async function call<T>(path: string, userId = USER): Promise<T> {
  const response = await buildApp(userId).fetch(new Request(`http://localhost/api/assistant${path}`, {
    method: 'GET',
  }), env, ctx)
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${text}`)
  return JSON.parse(text) as T
}

interface MemoryList {
  memories: AssistantMemory[]
  total: number
  counts: { active: number, historical: number, review: number }
}

/** A fact filed as one note, written the way the memory page writes it: saved, then linked. */
async function filed(s: AssistantStore, content: string, noteId: string, updatedAt: number): Promise<AssistantMemory> {
  const memory = await s.insertMemory({ content, category: 'fact', source: 'assistant' })
  const linked = await s.setMemoryNote(memory.id, noteId)
  sqlite.prepare('UPDATE chat_memories SET updated_at = ? WHERE id = ?').run(updatedAt, memory.id)
  return { ...(linked ?? memory), updatedAt }
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
  app = buildApp(USER)
})

describe('the memories one note is the source of', () => {
  it('answers with that note’s facts and nothing else', async () => {
    await filed(store, 'About this page', NOTE, 2_000)
    await filed(store, 'The newer one about this page', NOTE, 3_000)
    await filed(store, 'About another page', OTHER_NOTE, 1_000)
    await store.insertMemory({ content: 'Belongs to the account, not to a page', category: 'preference', source: 'manual' })
    const listed = await call<MemoryList>(`/memories?noteId=${NOTE}`)
    expect(listed.memories.map((entry) => entry.content)).toEqual([
      'The newer one about this page',
      'About this page',
    ])
    expect(listed.memories.every((entry) => entry.noteId === NOTE)).toBe(true)
  })

  it('counts the same set it returns', async () => {
    await filed(store, 'One fact here', NOTE, 2_000)
    await filed(store, 'A fact somewhere else', OTHER_NOTE, 1_000)
    const past = await filed(store, 'A past fact here', NOTE, 1_500)
    await store.setMemoryLifecycle(past.id, { status: 'historical' })
    // Retiring a fact restamps its row, which is right for the memory page's own order and would otherwise
    // decide this test by the clock rather than by the fixture.
    sqlite.prepare('UPDATE chat_memories SET updated_at = ? WHERE id = ?').run(1_500, past.id)
    const listed = await call<MemoryList>(`/memories?noteId=${NOTE}`)
    // Three rows name this note in the table, two of them are current: the header numbers describe the
    // two the reader is looking at, not the account's whole library.
    expect(listed.memories.map((entry) => entry.content)).toEqual(['One fact here', 'A past fact here'])
    expect(listed.total).toBe(2)
    expect(listed.counts.active).toBe(1)
    expect(listed.counts.historical).toBe(1)
  })

  it('answers nothing for a note id this account does not have', async () => {
    await filed(store, 'About this page', NOTE, 2_000)
    const listed = await call<MemoryList>(`/memories?noteId=${OTHER_NOTE}`)
    expect(listed.memories).toEqual([])
    expect(listed.total).toBe(0)
  })

  it('answers nothing for a note id of the wrong shape, rather than everything', async () => {
    await filed(store, 'About this page', NOTE, 2_000)
    for (const wrong of ['not-an-id', '', '..%']) {
      const listed = await call<MemoryList>(`/memories?noteId=${encodeURIComponent(wrong)}`)
      expect(listed.memories, `a malformed note id answered with ${listed.memories.length} rows`).toEqual([])
      expect(listed.total).toBe(0)
    }
    // The parameter being present at all is what narrows: absent still means the whole library.
    const everything = await call<MemoryList>('/memories')
    expect(everything.memories).toHaveLength(1)
  })

  it('keeps another account’s fact out of the answer', async () => {
    const other = new AssistantStore(env.DB as D1Database, OTHER_USER, env)
    await filed(store, 'Mine about this page', NOTE, 2_000)
    await filed(other, 'Theirs about the same page id', NOTE, 3_000)
    const listed = await call<MemoryList>(`/memories?noteId=${NOTE}`, OTHER_USER)
    expect(listed.memories.map((entry) => entry.content)).toEqual(['Theirs about the same page id'])
    const mine = await call<MemoryList>(`/memories?noteId=${NOTE}`, USER)
    expect(mine.memories.map((entry) => entry.content)).toEqual(['Mine about this page'])
  })

  it('lists a fact filed under a project too, because the note is the question here', async () => {
    const project = await store.createProject({ name: 'Client A', description: '' })
    const memory = await store.insertMemory({ content: 'The client pays monthly', category: 'fact', source: 'assistant', projectId: project.id })
    await store.setMemoryNote(memory.id, NOTE)
    const listed = await call<MemoryList>(`/memories?noteId=${NOTE}`)
    expect(listed.memories.map((entry) => entry.content)).toEqual(['The client pays monthly'])
    expect(listed.memories[0]!.projectId).toBe(project.id)
  })
})

describe('the note filter runs on an index the account can start from', () => {
  it('seeks (user_id, note_id) rather than scanning the vault', async () => {
    const plan = sqlite
      .prepare(`EXPLAIN QUERY PLAN SELECT id, note_id FROM chat_memories
        WHERE user_id = ? AND note_id = ? ORDER BY updated_at DESC LIMIT ?`)
      .all(USER, NOTE, 20)
      .map((row) => String(row.detail))
      .join(' | ')
    expect(plan).toContain('idx_chat_memories_note (user_id=? AND note_id=?)')
    expect(plan).not.toMatch(/SCAN chat_memories\b/)
  })
})

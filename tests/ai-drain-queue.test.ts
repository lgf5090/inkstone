import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { drainAiIndexQueue } from '../src/worker/mcp/ai-search'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-1'
const DIMS = 4

interface Fixture {
  env: Env
  sqlite: DatabaseSync
  calls: string[][]
  failFor: Set<string>
}

function makeVector(): number[] {
  return Array.from({ length: DIMS }, (_, index) => 0.1 * (index + 1))
}

function seed(noteCount: number, options: { poison?: string } = {}): Fixture {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE notes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL, deleted_at INTEGER);
    CREATE TABLE ai_note_embeddings (user_id TEXT NOT NULL, note_id TEXT NOT NULL, model TEXT NOT NULL,
      vector BLOB NOT NULL, indexed_at INTEGER NOT NULL, norm REAL, PRIMARY KEY (user_id, note_id));
    CREATE TABLE ai_index_queue (user_id TEXT NOT NULL, note_id TEXT NOT NULL, kind TEXT NOT NULL,
      created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER,
      PRIMARY KEY (user_id, note_id));
    INSERT INTO app_meta (key, value) VALUES ('ai-search-enabled:${USER}', '1');
  `)
  const calls: string[][] = []
  const failFor = new Set<string>(options.poison ? [options.poison] : [])
  for (let index = 0; index < noteCount; index++) {
    const id = `note-${index}`
    sqlite.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, NULL)')
      .run(id, USER, id, `body of ${id}${options.poison === id ? ' POISON' : ''}`)
    sqlite.prepare('INSERT INTO ai_index_queue (user_id, note_id, kind, created_at) VALUES (?, ?, ?, ?)')
      .run(USER, id, 'embed', 1_700_000_000_000 + index)
  }
  const ai = {
    async run(_model: string, input: { text: string[] }) {
      calls.push(input.text)
      if (input.text.some((text) => text.includes('POISON'))) throw new Error('model rejected the text')
      return { data: input.text.map((text) => ({ embedding: makeVector(), note: text })) }
    },
  }
  return { env: { DB: makeD1(sqlite), AI: ai } as unknown as Env, sqlite, calls, failFor }
}

const queueRow = (sqlite: DatabaseSync, id: string) => sqlite.prepare(
  'SELECT attempts, next_retry_at, created_at FROM ai_index_queue WHERE note_id = ?',
).get(id) as { attempts: number; next_retry_at: number | null } | undefined

const indexedCount = (sqlite: DatabaseSync) => Number(
  (sqlite.prepare('SELECT COUNT(*) AS n FROM ai_note_embeddings').get() as { n: number }).n,
)

const queueRowCount = (sqlite: DatabaseSync) => Number(
  (sqlite.prepare('SELECT COUNT(*) AS n FROM ai_index_queue').get() as { n: number }).n,
)

describe('drainAiIndexQueue', () => {
  let fixture: Fixture
  beforeEach(() => {
    fixture = seed(20)
  })

  it('lets one account spend the whole budget instead of a 25-item per-user ceiling', async () => {
    const big = seed(60)
    const { processed } = await drainAiIndexQueue(big.env, 60)
    expect(processed).toBe(60)
    expect(indexedCount(big.sqlite)).toBe(60)
    expect(queueRowCount(big.sqlite)).toBe(0)
  })

  it('still respects an explicit small budget', async () => {
    const { processed } = await drainAiIndexQueue(fixture.env, 5)
    expect(processed).toBe(5)
    expect(indexedCount(fixture.sqlite)).toBe(5)
  })

  it('batches up to 16 notes into a single model call', async () => {
    await drainAiIndexQueue(fixture.env, 20)
    expect(fixture.calls.map((call) => call.length)).toEqual([16, 4])
  })

  it('indexes the healthy notes of a failing chunk instead of freezing the queue', async () => {
    const poisoned = seed(4, { poison: 'note-1' })
    const { processed } = await drainAiIndexQueue(poisoned.env, 16)
    // The batch call fails, then every item is retried on its own.
    expect(processed).toBe(3)
    expect(indexedCount(poisoned.sqlite)).toBe(3)
    const stuck = queueRow(poisoned.sqlite, 'note-1')
    expect(stuck?.attempts).toBe(1)
    expect(stuck?.next_retry_at).toBeTypeOf('number')
  })

  it('skips backed-off items and still drains what became due', async () => {
    const poisoned = seed(4, { poison: 'note-1' })
    await drainAiIndexQueue(poisoned.env, 16)
    const before = poisoned.calls.length
    const second = await drainAiIndexQueue(poisoned.env, 16)
    expect(second.processed).toBe(0)
    expect(poisoned.calls.length).toBe(before)
    // Clear the backoff and the item is attempted again, incrementing attempts.
    poisoned.sqlite.prepare('UPDATE ai_index_queue SET next_retry_at = NULL').run()
    await drainAiIndexQueue(poisoned.env, 16)
    expect(queueRow(poisoned.sqlite, 'note-1')?.attempts).toBe(2)
  })

  it('drops a permanently failing item after five attempts so the head advances', async () => {
    const poisoned = seed(2, { poison: 'note-0' })
    for (let round = 0; round < 6; round++) {
      poisoned.sqlite.prepare('UPDATE ai_index_queue SET next_retry_at = NULL').run()
      await drainAiIndexQueue(poisoned.env, 16)
    }
    expect(queueRow(poisoned.sqlite, 'note-0')).toBeUndefined()
    expect(indexedCount(poisoned.sqlite)).toBe(1)
  })

  it('does nothing while another isolate holds the account drain lease', async () => {
    fixture.sqlite.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(
      `ai-drain:${USER}`,
      JSON.stringify({ token: 'other', expiresAt: Date.now() + 60_000 }),
    )
    const { processed } = await drainAiIndexQueue(fixture.env, 20)
    expect(processed).toBe(0)
    expect(fixture.calls.length).toBe(0)
  })
})

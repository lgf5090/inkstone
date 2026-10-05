import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { encodeVector, searchSemanticNotes } from '../src/worker/mcp/ai-search'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-1'
const QUERY = 'quantum gardening'
const TOTAL = 1200

/** The query embedding the stub always returns; a match scores 1, everything else 0. */
const target = new Float32Array([1, 0, 0, 0])
const orthogonal = new Float32Array([0, 1, 0, 0])

let sqlite: DatabaseSync
let env: Env

const idOf = (index: number) => `note-${String(index).padStart(5, '0')}`

function seed(count: number, matches: string[] = []) {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE notes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL, excerpt TEXT NOT NULL DEFAULT '', rev INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER,
      is_starred INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE ai_note_embeddings (user_id TEXT NOT NULL, note_id TEXT NOT NULL, model TEXT NOT NULL,
      vector BLOB NOT NULL, indexed_at INTEGER NOT NULL, norm REAL, PRIMARY KEY (user_id, note_id));
    CREATE INDEX idx_embeddings_user_indexed ON ai_note_embeddings(user_id, indexed_at);
    INSERT INTO app_meta (key, value) VALUES ('ai-search-enabled:${USER}', '1');
  `)
  const note = sqlite.prepare(
    'INSERT INTO notes (id, user_id, title, content, rev, updated_at, deleted_at) VALUES (?, ?, ?, ?, 1, ?, NULL)',
  )
  const vector = sqlite.prepare(
    'INSERT INTO ai_note_embeddings (user_id, note_id, model, vector, indexed_at, norm) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const base = 1_700_000_000_000
  for (let index = 0; index < count; index++) {
    const id = idOf(index)
    note.run(id, USER, `Note ${index}`, 'body', index)
    vector.run(USER, id, '@cf/baai/bge-m3',
      encodeVector(matches.includes(id) ? target : orthogonal), base + index, 1)
  }
  env = {
    DB: makeD1(sqlite),
    AI: {
      async run(_model: string, input: { text: string[] }) {
        return { data: input.text.map(() => ({ embedding: Array.from(target) })) }
      },
    },
  } as unknown as Env
}

const matched = async () => (await searchSemanticNotes(env, env.DB, USER, QUERY, {}))
  .filter((hit) => hit.score > 0.5)
  .map((hit) => hit.id)

describe('searchSemanticNotes scan window', () => {
  beforeEach(() => seed(TOTAL, [idOf(500)]))

  // The scan is newest-first, so index 500 of 1200 sits at row 700 of the window: reachable
  // now, invisible while the window was a fixed 200 rows.
  it('recalls a match far outside the old 200-row freshness window', async () => {
    expect(await matched()).toEqual([idOf(500)])
  })

  it('holds a hard budget: older than the scan window stays unreachable', async () => {
    seed(TOTAL, [idOf(50)])
    expect(await matched()).toEqual([])
  })

  it('joins the second page without dropping or duplicating rows', async () => {
    seed(TOTAL, [idOf(500), idOf(300), idOf(1100)])
    const hits = await searchSemanticNotes(env, env.DB, USER, QUERY, {})
    expect(new Set(hits.map((hit) => hit.id)).size).toBe(hits.length)
    expect(await matched()).toEqual([idOf(1100), idOf(500), idOf(300)])
  })

  it('stops paging once the account runs out of vectors', async () => {
    seed(7, [idOf(0)])
    const hits = await searchSemanticNotes(env, env.DB, USER, QUERY, {})
    expect(hits).toHaveLength(7)
    expect(hits[0]).toMatchObject({ id: idOf(0), score: 1 })
  })

  // A chunk of notes indexed inside the same millisecond shares indexed_at, so the page
  // boundary has to be resolved by note_id alone: no row may repeat, none may be skipped.
  it('pages a single-valued indexed_at by note_id at the boundary', async () => {
    seed(TOTAL, [idOf(499), idOf(500)])
    sqlite.exec('UPDATE ai_note_embeddings SET indexed_at = 1700000000000')
    const hits = await searchSemanticNotes(env, env.DB, USER, QUERY, {})
    expect(new Set(hits.map((hit) => hit.id)).size).toBe(hits.length)
    expect(hits.filter((hit) => hit.score > 0.5).map((hit) => hit.id).sort())
      .toEqual([idOf(499), idOf(500)])
  })
})

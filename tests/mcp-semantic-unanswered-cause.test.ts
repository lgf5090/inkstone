import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { searchMcpNotes } from '../src/worker/mcp/retrieval'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * Each reason the meaning index refuses a search says its own sentence.
 *
 * `unanswered` is one state because all three of its causes mean the same thing to the page: nothing was
 * embedded, so the hits below are keyword-only. It used to carry one notice for all three as well — "this
 * deployment has no AI binding, the reader switched the note index off, or the embedding call failed" — and
 * that sentence is true whatever happened and actionable for none of it. The three causes have three
 * different next moves (tell the operator, open the AI settings, wait and retry), so the notice now names
 * the one that occurred.
 *
 * The state value deliberately does not split: `tests/mcp-semantic-score-floor.test.ts` guards the line
 * between *refused* and *searched, found nothing*, and a cause per state value would blur exactly the
 * distinction that test exists to keep. Nothing here changes what `searchSemanticNotes` answers either —
 * `null` still means "the index declined" and a throw still means "the call failed"; the retriever only
 * stops folding the two together when it writes the sentence.
 *
 * No note needs a stored vector for these cases: every refusal happens before the scan, so the vault below
 * is a keyword vault, and the keyword page coming back is part of what each case asserts.
 */

const USER = 'user-1'
/** The one note the keyword half can find: it carries the words of every query below. */
const HARBOUR_NOTE = '01hzzzzzzzzzzzzzzzzzzzzz01'
const PREF_KEY = `ai-search-enabled:${USER}`

let sqlite: DatabaseSync
/** A deployment with an AI binding and the reader's index switched on. */
let env: Env
/** The same vault where the binding is simply absent. */
let noAiEnv: Env

function seed() {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, title, title_key, content, excerpt, rev, word_count, char_count,
       is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 4, 4, 0, 0, 0, 0, 'hash', 1, 1700000000100, NULL)`,
  ).run(HARBOUR_NOTE, USER, 'Tide gates', 'tide gates', 'The tide gates at the harbour mouth were rebuilt in spring.', 'The tide gates at the harbour mouth were rebuilt in spring.')
  sqlite.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(PREF_KEY, '1')
  env = {
    DB: makeD1(sqlite),
    AI: { run: async () => { throw new Error('never reached: every case below refuses before embedding') } },
  } as unknown as Env
  noAiEnv = { DB: env.DB } as unknown as Env
}

/** The reader's own switch, thrown off — the index then refuses before it embeds anything. */
function switchIndexOff() {
  sqlite.prepare('UPDATE app_meta SET value = ? WHERE key = ?').run('0', PREF_KEY)
}

/** A binding that is there and answers badly, so the call goes out and comes back as a failure. */
function failingAiEnv(): Env {
  return { DB: env.DB, AI: { run: async () => { throw new Error('upstream 503') } } } as unknown as Env
}

const search = (onEnv: Env, query: string) => searchMcpNotes(
  onEnv, USER, 'https://notes.test', false, { query, mode: 'semantic' },
)

beforeEach(() => seed())

describe('the three reasons the meaning index refused, told apart', () => {
  // Each case asks in its own words: `embedQueryText` caches a query embedding by its text, so a phrasing
  // reused from another case could be answered out of that cache instead of by the stub under test.
  it('names a deployment with no AI binding as that', async () => {
    const page = await search(noAiEnv, 'harbour gates rebuilt')
    expect(page.semantic_status).toBe('unanswered')
    expect(page.notice ?? '').toMatch(/no AI binding/i)
    expect(page.notice ?? '').not.toMatch(/switched|failed/i)
  })

  it('names an index the reader switched off as theirs, not as an outage', async () => {
    switchIndexOff()
    const page = await search(env, 'tide gates rebuilt in spring')
    expect(page.semantic_status).toBe('unanswered')
    expect(page.notice ?? '').toMatch(/switched the note index off/i)
    expect(page.notice ?? '').not.toMatch(/no AI binding|failed/i)
  })

  it('names a failed embedding call as a failure, and still hands over the keyword page', async () => {
    const page = await search(failingAiEnv(), 'the harbour mouth in spring')
    expect(page.semantic_status).toBe('unanswered')
    expect(page.notice ?? '').toMatch(/embedding call failed/i)
    expect(page.notice ?? '').not.toMatch(/no AI binding|switched the note index off/i)
    // A refusal is not an empty answer: the keyword half still answers, and the page says which half did.
    expect(page.mode).toBe('lexical')
    expect(page.results.map((hit) => hit.id)).toEqual([HARBOUR_NOTE])
  })

  // The fold-proof: the three refusals have to be tellable apart by what the reader is handed, or the split
  // exists only in the code that produced it. Ordered so the failing call is asked while the index is still
  // on, because `searchSemanticNotes` reads the reader's switch before it embeds and would refuse first.
  it('keeps the three refusal sentences apart from one another', async () => {
    const failed = await search(failingAiEnv(), 'a rope rinsed once a month at the dock')
    switchIndexOff()
    const switchedOff = await search(env, 'a lamp drawn as a projection of the tide')
    const noBinding = await search(noAiEnv, 'keys kept in the shed beside the water')
    expect(new Set([switchedOff.notice, noBinding.notice, failed.notice]).size).toBe(3)
  })
})

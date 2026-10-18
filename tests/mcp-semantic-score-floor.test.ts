import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { searchMcpNotes } from '../src/worker/mcp/retrieval'
import {
  encodeVector,
  searchSemanticNotes,
  SEMANTIC_SCORE_FLOOR,
} from '../src/worker/mcp/ai-search'
import { SEMANTIC_FLOOR } from '../src/worker/assistant/semantic'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * The note index refuses a vector that is not close, on both sides of its door.
 *
 * The scan returns the best forty notes it walked past, however far down the cosine list they sit, and the
 * MCP retriever merges that list with its keyword list by rank. Rank fusion cannot see distance, so a note
 * at cosine 0.3 used to claim an ordinal a keyword hit had earned and be handed to a caller as a meaning
 * match. The assistant's own read put a bar on this in the previous round; the MCP path never did, so one
 * vault answered its two callers differently.
 *
 * The bar is now the index's own number (`SEMANTIC_SCORE_FLOOR`), which is the measurement the assistant's
 * memory recall already uses, so a threshold change cannot land on one path and be forgotten on the other.
 */

const USER = 'user-1'
/** The embedding every stubbed call returns, so a stored vector's first component is its cosine. */
const QUERY_VECTOR = [1, 0, 0, 0]
const unitAt = (cosine: number) => [cosine, Math.sqrt(1 - cosine * cosine), 0, 0]

/** The only note the keyword half can find: it carries the words of the query. */
const KEYWORD_NOTE = '01hzzzzzzzzzzzzzzzzzzzzz01'
/** Shares no word with any query here, and its vector sits below the bar. */
const FAR_NOTE = '01hzzzzzzzzzzzzzzzzzzzzz02'
/** Shares no word with any query here, but its vector clears the bar. */
const CLOSE_NOTE = '01hzzzzzzzzzzzzzzzzzzzzz03'

const PREF_KEY = `ai-search-enabled:${USER}`
const NEAR_SCORES: Array<readonly [string, number]> = [[KEYWORD_NOTE, 0.9], [FAR_NOTE, 0.3], [CLOSE_NOTE, 0.8]]

let sqlite: DatabaseSync
let env: Env

function seedNote(id: string, title: string, content: string, updatedAt: number) {
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, title, title_key, content, excerpt, rev, word_count, char_count,
       is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 4, 4, 0, 0, 0, 0, 'hash', 1, ?, NULL)`,
  ).run(id, USER, title, title.toLowerCase(), content, content, updatedAt)
}

/**
 * The three notes, each with a vector of its own.
 *
 * `scores` is per case because the query embedding is fixed: the only way to move a note across the bar is
 * to move its stored vector, and the distance a case names in its own title is the number written here.
 */
function seed(scores: readonly (readonly [string, number])[] = NEAR_SCORES) {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  seedNote(KEYWORD_NOTE, 'Tide gates', 'The tide gates at the harbour mouth were rebuilt in spring.', 1_700_000_000_100)
  seedNote(FAR_NOTE, 'Sofa care', 'Dust the cushions and turn the memory foam once a week.', 1_700_000_000_200)
  seedNote(CLOSE_NOTE, 'Sea locks', 'Sea locks keep the water out of the dock.', 1_700_000_000_300)
  sqlite.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(PREF_KEY, '1')
  const vector = sqlite.prepare(
    'INSERT INTO ai_note_embeddings (user_id, note_id, model, vector, indexed_at, norm) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (const [id, cosine] of scores) {
    // Written through raw node:sqlite, so the BLOB goes over as a byte view. `norm` is 1 because every
    // vector is unit length, which makes the stored cosine exactly the number the case names.
    vector.run(USER, id, '@cf/baai/bge-m3', new Uint8Array(encodeVector(new Float32Array(unitAt(cosine)))), 1_700_000_000_000, 1)
  }
  env = {
    DB: makeD1(sqlite),
    AI: {
      run: async (_model: string, call: { text: string[] }) => ({
        data: call.text.map(() => ({ embedding: QUERY_VECTOR })),
      }),
    },
  } as unknown as Env
}

const idsOf = (hits: readonly { id: string }[] | null) => (hits ?? []).map((hit) => hit.id)

beforeEach(() => seed())

describe('the index\'s own similarity bar', () => {
  // Each case asks in its own words: `embedQueryText` caches a query embedding by its text for ten minutes
  // per isolate, so a case reusing another's phrasing would read that cache back instead of the stub.
  it('drops a note whose vector is nowhere near the query', async () => {
    const hits = await searchSemanticNotes(env, env.DB, USER, 'which gates were rebuilt', {})
    expect(idsOf(hits)).toEqual([KEYWORD_NOTE, CLOSE_NOTE])
  })

  // The control that makes the case above a test of the bar rather than of the seeding: take the bar away
  // and the cosine-0.3 note comes back, so it was the threshold that removed it.
  it('hands the far note back once the bar is set to zero', async () => {
    const hits = await searchSemanticNotes(env, env.DB, USER, 'memory foam turned weekly', {}, 0)
    expect(idsOf(hits)).toEqual([KEYWORD_NOTE, CLOSE_NOTE, FAR_NOTE])
  })

  it('keeps a bar the caller raises above the default', async () => {
    const hits = await searchSemanticNotes(env, env.DB, USER, 'rebuilt at the harbour mouth', {}, 0.85)
    expect(idsOf(hits)).toEqual([KEYWORD_NOTE])
  })

  it('answers empty, not absent, when no note clears it', async () => {
    seed([[KEYWORD_NOTE, 0.2], [FAR_NOTE, 0.3], [CLOSE_NOTE, 0.1]])
    const hits = await searchSemanticNotes(env, env.DB, USER, 'cushions and foam only', {})
    // `null` is the index refusing to answer and is what tells a caller to say "meaning was not searched";
    // an empty list is a completed search and must stay distinguishable from it.
    expect(hits).toStrictEqual([])
  })
})

describe('the MCP hybrid page over that index', () => {
  it('will not hand a distant note to the caller as a meaning match', async () => {
    const page = await searchMcpNotes(env, USER, 'https://notes.test', false, {
      query: 'tide gates rebuilt',
      mode: 'auto',
    })
    expect(idsOf(page.results)).toEqual([KEYWORD_NOTE, CLOSE_NOTE])
    expect(page.results.some((hit) => hit.id === FAR_NOTE)).toBe(false)
    expect(page.mode).toBe('hybrid')
  })

  it('says keyword-only when the meaning half found nothing close', async () => {
    seed([[KEYWORD_NOTE, 0.4], [FAR_NOTE, 0.2], [CLOSE_NOTE, 0.3]])
    const page = await searchMcpNotes(env, USER, 'https://notes.test', false, {
      query: 'harbour mouth rebuilt in spring',
      mode: 'auto',
    })
    // The reader gets the keyword page and the truth about it: the index was read, nothing was close, and
    // nothing below the bar is presented as a match.
    expect(page.mode).toBe('lexical')
    expect(idsOf(page.results)).toEqual([KEYWORD_NOTE])
  })

  it('lists only the neighbours above the bar when asked for pure meaning', async () => {
    const page = await searchMcpNotes(env, USER, 'https://notes.test', false, {
      query: 'locks that hold the water back',
      mode: 'semantic',
    })
    expect(idsOf(page.results)).toEqual([KEYWORD_NOTE, CLOSE_NOTE])
  })
})

describe('one threshold for both readers of the index', () => {
  it('is the same number the assistant measures a memory against', () => {
    expect(SEMANTIC_FLOOR.absolute).toBe(SEMANTIC_SCORE_FLOOR)
  })
})

describe('the mode a page reports about itself', () => {
  // A bar on the index leaves two tails, and both are about what a page is allowed to *say*: the mode a
  // reader or MCP client is handed has to name the half that actually produced the hits, and an index that
  // refused to answer must not be reported as an index that answered "nothing".
  it('calls a searched-but-empty semantic page semantic rather than lexical', async () => {
    seed([[KEYWORD_NOTE, 0.4], [FAR_NOTE, 0.2], [CLOSE_NOTE, 0.3]])
    const page = await searchMcpNotes(env, USER, 'https://notes.test', false, {
      query: 'locks holding water back from a dock',
      mode: 'semantic',
    })
    // The reader asked for meaning, the index was read, and its answer was "none of these are close".
    // Labelling that page `lexical` describes a keyword search whose keyword hits nobody asked for.
    expect(page.mode).toBe('semantic')
    expect(page.results).toEqual([])
    expect(page.semantic_status).toBe('searched_no_match')
    expect(page.notice ?? '').toMatch(/close enough/i)
  })

  // Control for the case above: the same vault, asked the ordinary way, still hands the reader their
  // keyword page. So the empty list is about what was requested, not about the notes having disappeared.
  it('still gives auto the keyword page when the bar empties the vector half', async () => {
    seed([[KEYWORD_NOTE, 0.4], [FAR_NOTE, 0.2], [CLOSE_NOTE, 0.3]])
    const page = await searchMcpNotes(env, USER, 'https://notes.test', false, {
      query: 'gates rebuilt at the mouth in spring',
      mode: 'auto',
    })
    expect(page.mode).toBe('lexical')
    expect(idsOf(page.results)).toEqual([KEYWORD_NOTE])
    // and it says which of the two reasons the vector half is missing, instead of leaving the label to hint
    expect(page.semantic_status).toBe('searched_no_match')
    expect(page.notice ?? '').toMatch(/close enough/i)
  })

  it('names a refusal as a refusal when a semantic request gets no index at all', async () => {
    seed()
    const noAi = { DB: env.DB } as unknown as Env
    const page = await searchMcpNotes(noAi, USER, 'https://notes.test', false, {
      query: 'harbour tide gates rebuilt in spring',
      mode: 'semantic',
    })
    // Nothing was embedded here, so the hits really did come from keywords: the honest label is `lexical`,
    // and the honest sentence beside it is "the index never answered", not "it found nothing".
    expect(page.mode).toBe('lexical')
    expect(idsOf(page.results)).toEqual([KEYWORD_NOTE])
    expect(page.semantic_status).toBe('unanswered')
    expect(page.notice ?? '').toMatch(/never searched|could not be searched/i)
  })

  it('keeps the refusal and the empty answer apart in what the client reads', async () => {
    seed([[KEYWORD_NOTE, 0.4], [FAR_NOTE, 0.2], [CLOSE_NOTE, 0.3]])
    const options = { query: 'water kept out of the harbour dock', mode: 'semantic' as const }
    const searched = await searchMcpNotes(env, USER, 'https://notes.test', false, options)
    const refused = await searchMcpNotes({ DB: env.DB } as unknown as Env, USER, 'https://notes.test', false, options)
    // One reader's "no note of yours is close" and another's "this deployment cannot embed" are different
    // next moves, so no field of the answer may fold them together.
    expect(searched.semantic_status).toBe('searched_no_match')
    expect(refused.semantic_status).toBe('unanswered')
    expect(refused.notice).not.toBe(searched.notice)
  })
})

import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS } from '../src/shared/assistant'
import type { NoteScope } from '../src/worker/assistant/note-scope'
import { ToolExecutor, type ToolContext } from '../src/worker/assistant/tools'
import type { AssistantStore } from '../src/worker/assistant/store'
import { encodeVector } from '../src/worker/mcp/ai-search'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * The assistant's note search, asked what it actually looked in (GAP-19).
 *
 * The reader's complaint is the one this deployment cannot answer without a vector: "find the note about
 * keeping the dock dry" holds no word that the note, titled *Sea locks*, uses. The embedding index and the
 * rank fusion already exist for the MCP server (`ai-search.ts`), and `assistant/semantic.ts` imports them
 * for memories for exactly that reason — two encoders would stop recognising each other's vectors. What
 * was missing is the note tool reaching for the second list, and saying which list an answer came from:
 * a keyword-only page that reads like a complete answer is a silent failure the reader cannot work around.
 *
 * So four things are pinned here: both lists take part when the index is on, an off index says "keyword
 * only" instead of pretending nothing exists, a failed embedding still returns the keyword page *and*
 * names the failure, and the day's embedding allowance stops the vector half rather than the turn.
 */

const USER = 'user-1'
/** Contains both query words: the keyword list finds it. */
const KEYWORD_NOTE = '01hzzzzzzzzzzzzzzzzzzzzz01'
/** Shares no word with the query; only its vector is close. */
const MEANING_NOTE = '01hzzzzzzzzzzzzzzzzzzzzz02'
/** Neither a word nor a vector matches: must never surface. */
const NEITHER_NOTE = '01hzzzzzzzzzzzzzzzzzzzzz03'
const QUERY = 'tide gates'

/** The query embedding the stub hands back, and the two stored vectors it is compared against. */
const QUERY_VECTOR = [1, 0, 0, 0]
const CLOSE_VECTOR = [0.8, 0.6, 0, 0]
const FAR_VECTOR = [0, 1, 0, 0]

const PREF_KEY = `ai-search-enabled:${USER}`

let sqlite: DatabaseSync
let env: Env
let aiRun: Mock
let scope: NoteScope
let embeddingsToday: number
let cap: number
let spent: Array<Record<string, number>>

function seedNote(id: string, title: string, content: string, updatedAt: number) {
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, title, title_key, content, excerpt, rev, word_count, char_count,
       is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 4, 4, 0, 0, 0, 0, 'hash', 1, ?, NULL)`,
  ).run(id, USER, title, title.toLowerCase(), content, content, updatedAt)
}

/**
 * The account, its index and its AI binding.
 *
 * `indexed` decides which notes carry a vector at all, so a keyword hit with no row of its own is the
 * usual case rather than a special one.
 */
function seed(input: { enabled: boolean, aiThrows?: string, indexed?: boolean, far?: boolean } = { enabled: true }) {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  seedNote(KEYWORD_NOTE, 'Tide gates', 'The tide gates at the harbour mouth were rebuilt in spring.', 1_700_000_000_100)
  seedNote(MEANING_NOTE, 'Sea locks', 'Sea locks keep the water out of the dock.', 1_700_000_000_200)
  seedNote(NEITHER_NOTE, 'Sofa care', 'Dust the cushions once a week.', 1_700_000_000_300)
  sqlite.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(PREF_KEY, input.enabled ? '1' : '0')
  const vector = sqlite.prepare(
    'INSERT INTO ai_note_embeddings (user_id, note_id, model, vector, indexed_at, norm) VALUES (?, ?, ?, ?, ?, ?)',
  )
  if (input.indexed !== false) {
    const rows: Array<readonly [string, readonly number[]]> = [
      [KEYWORD_NOTE, input.far ? FAR_VECTOR : QUERY_VECTOR],
      [MEANING_NOTE, input.far ? FAR_VECTOR : CLOSE_VECTOR],
      [NEITHER_NOTE, FAR_VECTOR],
    ]
    for (const [id, values] of rows) {
      // Written through raw node:sqlite, so the BLOB has to be handed over as a byte view.
      vector.run(USER, id, '@cf/baai/bge-m3', new Uint8Array(encodeVector(new Float32Array(values))), 1_700_000_000_000, 1)
    }
  }
  aiRun = vi.fn(async (_model: string, call: { text: string[] }) => {
    if (input.aiThrows) throw new Error(input.aiThrows)
    return { data: call.text.map(() => ({ embedding: QUERY_VECTOR })) }
  })
  env = { DB: makeD1(sqlite), AI: { run: aiRun } } as unknown as Env
  scope = { restricted: false, folderIds: new Set(), tagIds: new Set(), noteIds: new Set() }
  embeddingsToday = 0
  cap = DEFAULT_ASSISTANT_SETTINGS.limits.maxEmbeddingsPerDay
  spent = []
}

function context(): ToolContext {
  const store = {
    userId: USER,
    todayUsage: async () => ({ embeddings: embeddingsToday }),
    incrementUsage: async (counters: Record<string, number>) => {
      spent.push(counters)
      embeddingsToday += counters.embeddings ?? 0
    },
  }
  return {
    store: store as unknown as AssistantStore,
    env,
    ftsEnabled: false,
    origin: 'https://notes.test',
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, limits: { ...DEFAULT_ASSISTANT_SETTINGS.limits, maxEmbeddingsPerDay: cap } },
    timezone: 'Asia/Shanghai',
    dayEnd: 1_700_000_000_000,
    mode: 'chat',
    memoryHistory: {} as ToolContext['memoryHistory'],
    memoryScope: { projectId: null },
    automations: {} as ToolContext['automations'],
    noteScope: async () => scope,
  }
}

const search = async (query = QUERY) => await new ToolExecutor(context(), { maxToolCalls: 8 })
  .execute('search_notes', { query }, 'call-1') as Record<string, unknown>

const idsOf = (payload: Record<string, unknown>) => ((payload.results ?? []) as Array<Record<string, unknown>>).map((hit) => hit.id)
const noteOf = (payload: Record<string, unknown>) => String(payload.retrieval_note ?? '')

beforeEach(() => seed())

// Each case asks in its own words on purpose: the index caches a query embedding by its text for ten
// minutes per isolate, so a second test reusing the first's phrasing would read the first's vector back
// and never touch the stub it was written to fail.
describe('searching notes by word and by meaning', () => {
  it('returns a note the reader cannot have typed, and says both indexes took part', async () => {
    const payload = await search()
    expect(payload.retrieval).toBe('hybrid')
    expect(idsOf(payload)).toContain(MEANING_NOTE)
    expect(idsOf(payload)).not.toContain(NEITHER_NOTE)
    // The keyword hit ranks first in both lists, so fusion keeps it at the top rather than letting a
    // single-index note push it down.
    const hits = payload.results as Array<Record<string, unknown>>
    expect(hits[0]).toMatchObject({ id: KEYWORD_NOTE, source: 'both' })
    expect(hits[1]).toMatchObject({ id: MEANING_NOTE, source: 'meaning' })
    expect(noteOf(payload)).toMatch(/keyword/i)
    expect(noteOf(payload)).toMatch(/meaning/i)
  })

  it('charges the reader\'s daily embedding allowance for the query it embedded', async () => {
    expect(spent).toEqual([])
    await search('harbour rebuilt')
    expect(spent).toEqual([{ embeddings: 1 }])
  })

  it('searches keywords alone when the index is off, and says which one ran', async () => {
    seed({ enabled: false })
    const payload = await search('spring tide')
    expect(payload.retrieval).toBe('lexical')
    expect(idsOf(payload)).toEqual([KEYWORD_NOTE])
    expect(noteOf(payload)).toMatch(/keyword/i)
    // Said out loud rather than left for the model to assume: a page of keyword hits is not the whole
    // answer, and the reader has to be able to tell why.
    expect(noteOf(payload)).toMatch(/meaning|semantic/i)
    expect(noteOf(payload)).toMatch(/not|no|off|without|disabl/i)
    expect(aiRun).not.toHaveBeenCalled()
    expect(spent).toEqual([])
  })

  it('keeps the keyword page when the embedding call fails, and names the failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seed({ enabled: true, aiThrows: 'Workers AI is rate-limiting this account' })
    const payload = await search('mouth rebuilt')
    expect(payload.retrieval).toBe('lexical')
    expect(idsOf(payload)).toEqual([KEYWORD_NOTE])
    expect(noteOf(payload)).toMatch(/meaning|semantic/i)
    expect(noteOf(payload)).toMatch(/fail|unavailable|error/i)
    // The outage must not be reported as the same page an off index gives: "nothing matched" and
    // "nothing was searched" are different answers for the reader's next question.
    expect(noteOf(payload)).not.toMatch(/nothing close/i)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[inkstone]'), expect.anything())
    // A call that never answered spent nothing.
    expect(spent).toEqual([])
    warn.mockRestore()
  })

  it('stops embedding once the day\'s allowance is gone, and says that is why', async () => {
    seed({ enabled: true })
    cap = 3
    embeddingsToday = 3
    const payload = await search('harbour mouth')
    expect(payload.retrieval).toBe('lexical')
    expect(idsOf(payload)).toEqual([KEYWORD_NOTE])
    expect(noteOf(payload)).toMatch(/allowance|quota|limit/i)
    expect(aiRun).not.toHaveBeenCalled()
    expect(spent).toEqual([])
  })

  it('says the meaning index was searched when it found nothing close, and still charges it', async () => {
    seed({ enabled: true, far: true })
    const payload = await search('rebuilt spring')
    // Distinct from an off index: this one was asked and answered nothing, which is a fact about the
    // reader's notes rather than about their settings — and the embedding behind it was really spent.
    expect(payload.retrieval).toBe('lexical')
    expect(idsOf(payload)).toEqual([KEYWORD_NOTE])
    expect(noteOf(payload)).toMatch(/nothing close/i)
    expect(aiRun).toHaveBeenCalled()
    expect(spent).toEqual([{ embeddings: 1 }])
  })

  it('keeps the reader\'s excluded notes out of the fused page', async () => {
    // The vector list is a second way into a note, so the permission check has to sit on the merged page
    // rather than on the keyword half alone: a meaning match the reader excluded is still excluded.
    scope = { restricted: true, folderIds: new Set(), tagIds: new Set(), noteIds: new Set([KEYWORD_NOTE]) }
    const payload = await search('harbour rebuilt')
    expect(idsOf(payload)).toEqual([KEYWORD_NOTE])
    expect(payload.scope).toBeTruthy()
  })

  it('tells the model in the tool description that the answer says which retrieval ran', async () => {
    const description = await import('../src/worker/assistant/tools').then(({ NOTE_TOOLS }) =>
      NOTE_TOOLS.find((definition) => definition.name === 'search_notes')?.description ?? '')
    expect(description).toMatch(/keyword/i)
    expect(description).toMatch(/meaning|semantic/i)
  })
})

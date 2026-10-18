import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { searchMcpNotes } from '../src/worker/mcp/retrieval'
import { encodeVector, searchSemanticNotes } from '../src/worker/mcp/ai-search'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * Both halves of a note search narrow a `#tag` the same way, or fusion is comparing two questions.
 *
 * `search_notes` answers by fusing a keyword list and a vector list by rank, and rank fusion only means
 * something when both lists are rankings over candidates the caller actually asked for. The keyword half
 * reads a tag as its whole subtree — `tagScopePredicate()` in `db/rows.ts`, the one spelling shared with
 * the sidebar count, the note list and the graph filter — while the vector half filtered on `t.name` alone.
 * A reader pinning `#project` therefore fused "the notes tagged project or anything under it" with "the
 * notes carrying a tag spelled exactly `project`": every `project/sea-lock` hit arrived on one list and not
 * the other, and no reader could tell from the merged page which half had been asked what.
 *
 * These cases pin the two halves to one candidate set over the same vault, so the rule cannot be written
 * twice again without a test going red.
 */

const USER = 'user-1'
/** Carries the parent tag itself. */
const PARENT_TAGGED = '01hzzzzzzzzzzzzzzzzzzzzz01'
/** Carries `project/sea-lock`: only inside the parent's subtree, never under an exact-name filter. */
const CHILD_TAGGED = '01hzzzzzzzzzzzzzzzzzzzzz02'
/** Carries `projection`: an unrelated sibling the subtree rule must not swallow. */
const SIBLING_TAGGED = '01hzzzzzzzzzzzzzzzzzzzzz03'
/** Carries no tag at all. */
const UNTAGGED = '01hzzzzzzzzzzzzzzzzzzzzz04'

const PARENT_TAG = 'project'
const CHILD_TAG = 'project/sea-lock'
const SIBLING_TAG = 'projection'

/** One word in every note, so the keyword half can rank all four and only the tag filter separates them. */
const QUERY = 'harbour'

/** The embedding every stubbed call returns, and the vector every note is stored with: cosine 1. */
const UNIT_VECTOR = [1, 0, 0, 0]

const PREF_KEY = `ai-search-enabled:${USER}`

let sqlite: DatabaseSync
let env: Env

function seedNote(id: string, title: string, content: string, updatedAt: number) {
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, title, title_key, content, excerpt, rev, word_count, char_count,
       is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 4, 4, 0, 0, 0, 0, 'hash', 1, ?, NULL)`,
  ).run(id, USER, title, title.toLowerCase(), content, content, updatedAt)
}

function seedTag(id: string, name: string, noteId: string) {
  sqlite.prepare('INSERT INTO tags (id, user_id, name, is_manual, is_pinned, created_at) VALUES (?, ?, ?, 1, 0, 1)')
    .run(id, USER, name)
  sqlite.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(noteId, id)
}

function seed() {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  seedNote(PARENT_TAGGED, 'Project plan', 'The harbour plan sits in the project folder.', 1_700_000_000_100)
  seedNote(CHILD_TAGGED, 'Sea locks', 'The harbour sea locks were drawn by the project office.', 1_700_000_000_200)
  seedNote(SIBLING_TAGGED, 'Projection lamp', 'A harbour lamp drawn as a projection, not a plan.', 1_700_000_000_300)
  seedNote(UNTAGGED, 'Boat care', 'Rinse the harbour ropes once a month.', 1_700_000_000_400)
  seedTag('01hzzzzzzzzzzzzzzzzzzzzz91', PARENT_TAG, PARENT_TAGGED)
  seedTag('01hzzzzzzzzzzzzzzzzzzzzz92', CHILD_TAG, CHILD_TAGGED)
  seedTag('01hzzzzzzzzzzzzzzzzzzzzz93', SIBLING_TAG, SIBLING_TAGGED)
  sqlite.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(PREF_KEY, '1')
  const vector = sqlite.prepare(
    'INSERT INTO ai_note_embeddings (user_id, note_id, model, vector, indexed_at, norm) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (const id of [PARENT_TAGGED, CHILD_TAGGED, SIBLING_TAGGED, UNTAGGED]) {
    // Every note is stored at cosine 1 with the query: nothing here can be explained by distance or by the
    // similarity bar, so the only thing left deciding the vector half is its tag filter.
    vector.run(USER, id, '@cf/baai/bge-m3', new Uint8Array(encodeVector(new Float32Array(UNIT_VECTOR))), 1_700_000_000_000, 1)
  }
  env = {
    DB: makeD1(sqlite),
    AI: {
      run: async (_model: string, call: { text: string[] }) => ({
        data: call.text.map(() => ({ embedding: UNIT_VECTOR })),
      }),
    },
  } as unknown as Env
}

const idsOf = (hits: readonly { id: string }[] | null) => (hits ?? []).map((hit) => hit.id).sort()

/** The keyword half over the same vault and the same pin, asked through the retriever the MCP tool uses. */
async function keywordIds(tags: string[]) {
  const page = await searchMcpNotes(env, USER, 'https://notes.test', false, {
    query: QUERY,
    limit: 10,
    mode: 'lexical',
    tags,
  })
  return page.results.map((hit) => hit.id).sort()
}

async function vectorIds(tags: string[]) {
  return idsOf(await searchSemanticNotes(env, env.DB, USER, 'which harbour papers belong to the set', { tags }))
}

beforeEach(() => seed())

describe('narrowing both halves by one tag', () => {
  it('takes the subtree in the vector half, not only the exact tag name', async () => {
    const hits = await searchSemanticNotes(env, env.DB, USER, 'which harbour papers sit under a plan', {
      tags: [PARENT_TAG],
    })
    // Equal cosine and a cleared bar on every note, so this is the filter alone deciding: `project` means
    // `project` and everything under it, exactly as it does in the keyword half and in the sidebar count.
    expect(idsOf(hits)).toEqual([CHILD_TAGGED, PARENT_TAGGED].sort())
  })

  it('hands the fused page one candidate set, so the two lists rank the same notes', async () => {
    const vector = await vectorIds([PARENT_TAG])
    const keyword = await keywordIds([PARENT_TAG])
    expect(vector).toEqual([CHILD_TAGGED, PARENT_TAGGED].sort())
    expect(new Set(vector)).toEqual(new Set(keyword))
  })

  it('does not let the parent claim the unrelated sibling tag', async () => {
    // The `/` in the subtree pattern is what keeps `project` from swallowing `projection`; the vector half
    // inherits that guard by using the same predicate, so it is checked here rather than assumed.
    expect(await vectorIds([SIBLING_TAG])).toEqual([SIBLING_TAGGED])
    const nested = await vectorIds([PARENT_TAG])
    expect(nested).not.toContain(SIBLING_TAGGED)
    expect(nested).not.toContain(UNTAGGED)
  })

  // Control for every case above: with no tag pinned, all four notes are candidates for both halves, so a
  // narrowed page says something about the narrowing and nothing about the seeding.
  it('keeps all four notes as candidates when no tag is pinned', async () => {
    const all = [PARENT_TAGGED, CHILD_TAGGED, SIBLING_TAGGED, UNTAGGED].sort()
    expect(await vectorIds([])).toEqual(all)
    expect(await keywordIds([])).toEqual(all)
  })
})

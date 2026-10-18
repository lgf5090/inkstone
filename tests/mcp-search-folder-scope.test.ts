import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { searchMcpNotes } from '../src/worker/mcp/retrieval'
import { encodeVector, searchSemanticNotes } from '../src/worker/mcp/ai-search'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * Both halves of a note search narrow a folder the same way, or fusion is comparing two questions.
 *
 * `search_notes` answers by fusing a keyword list and a vector list by rank, and rank fusion only means
 * something when both lists are rankings over the candidates the caller asked for. The keyword half reads
 * `folder:"Project"` as the folder *and everything under it* — the `WITH RECURSIVE folder_subtree` clause
 * `applyFilters()` in `search/store.ts` appends — while the vector half matched `folders.name` exactly. A
 * reader who pinned `Project` therefore fused "the notes filed in Project or any of its subfolders" with
 * "the notes filed in a folder spelled exactly `Project`": every note in a subfolder arrived on one list and
 * not the other, and the merged page reported a rank nobody had computed over the same set.
 *
 * This is the same defect `tests/mcp-search-tag-scope.test.ts` closed for tags, one filter earlier — and the
 * two are guarded differently for one reason. Tags already had an app-wide subtree spelling to call,
 * `tagScopePredicate()` in `db/rows.ts`, so the vector half could simply call it. Folders have no such
 * public spelling: the keyword half's clause sits inside a module-private function, so the vector half
 * mirrors it statement for statement and this file is what keeps the two statements from drifting apart.
 *
 * These cases pin the two halves to one candidate set over the same vault, including the two guards that
 * make a subtree rule safe: a sibling folder whose name merely starts with the pinned one stays out, and an
 * unfiled or elsewhere-filed note stays out.
 */

const USER = 'user-1'
/** Folders: Project > sea-lock > shed, plus two unrelated branches. */
const FOLDER_PROJECT = '01hzzzzzzzzzzzzzzzzzzzzf01'
const FOLDER_SUB = '01hzzzzzzzzzzzzzzzzzzzzf02'
const FOLDER_GRAND = '01hzzzzzzzzzzzzzzzzzzzzf03'
const FOLDER_SIBLING = '01hzzzzzzzzzzzzzzzzzzzzf04'
const FOLDER_OTHER = '01hzzzzzzzzzzzzzzzzzzzzf05'

/** Filed in `Project` itself: the only note an exact-name folder filter can ever return. */
const AT_PROJECT = '01hzzzzzzzzzzzzzzzzzzzzz01'
/** Filed in `Project/sea-lock`: inside the subtree, never under an exact-name filter. */
const AT_SUBFOLDER = '01hzzzzzzzzzzzzzzzzzzzzz02'
/** Filed in `Project/sea-lock/shed`: proves the walk is recursive, not one level deep. */
const AT_GRANDFOLDER = '01hzzzzzzzzzzzzzzzzzzzzz03'
/** Filed in `Projection`: the name-prefix collision the subtree rule must not swallow. */
const AT_SIBLING = '01hzzzzzzzzzzzzzzzzzzzzz04'
/** Filed in an unrelated folder. */
const AT_OTHER = '01hzzzzzzzzzzzzzzzzzzzzz05'
/** Filed nowhere. */
const UNFILED = '01hzzzzzzzzzzzzzzzzzzzzz06'

const PROJECT = 'Project'
const SUBFOLDER = 'sea-lock'
const SIBLING = 'Projection'

/** One word in every note, so the keyword half can rank all six and only the folder filter separates them. */
const QUERY = 'harbour'

/** The embedding every stubbed call returns, and the vector every note is stored with: cosine 1. */
const UNIT_VECTOR = [1, 0, 0, 0]

const PREF_KEY = `ai-search-enabled:${USER}`

let sqlite: DatabaseSync
let env: Env

function seedFolder(id: string, name: string, parentId: string | null) {
  sqlite.prepare(
    'INSERT INTO folders (id, user_id, parent_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 1, 1)',
  ).run(id, USER, parentId, name)
}

function seedNote(id: string, title: string, content: string, folderId: string | null, updatedAt: number) {
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, folder_id, title, title_key, content, excerpt, rev, word_count, char_count,
       is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 4, 4, 0, 0, 0, 0, 'hash', 1, ?, NULL)`,
  ).run(id, USER, folderId, title, title.toLowerCase(), content, content, updatedAt)
}

/**
 * Puts a note into the meaning index at cosine 1 with every query here.
 *
 * The vector half only reads notes that have a stored vector, so a note that is not indexed can never be
 * a candidate on that side — the cases below index everything they expect back. With cosine 1 and the
 * similarity bar cleared on every note, nothing but the folder filter can decide the vector half.
 */
function seedVector(noteId: string) {
  sqlite.prepare(
    'INSERT INTO ai_note_embeddings (user_id, note_id, model, vector, indexed_at, norm) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(USER, noteId, '@cf/baai/bge-m3', new Uint8Array(encodeVector(new Float32Array(UNIT_VECTOR))), 1_700_000_000_000, 1)
}

function seed() {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  seedFolder(FOLDER_PROJECT, PROJECT, null)
  seedFolder(FOLDER_SUB, SUBFOLDER, FOLDER_PROJECT)
  seedFolder(FOLDER_GRAND, 'shed', FOLDER_SUB)
  seedFolder(FOLDER_SIBLING, SIBLING, null)
  seedFolder(FOLDER_OTHER, 'Boats', null)
  seedNote(AT_PROJECT, 'Project plan', 'The harbour plan sits in the project folder.', FOLDER_PROJECT, 1_700_000_000_100)
  seedNote(AT_SUBFOLDER, 'Sea locks', 'The harbour sea locks were drawn by the project office.', FOLDER_SUB, 1_700_000_000_200)
  seedNote(AT_GRANDFOLDER, 'Shed keys', 'The harbour shed keeps the keys to the lock gates.', FOLDER_GRAND, 1_700_000_000_300)
  seedNote(AT_SIBLING, 'Projection lamp', 'A harbour lamp drawn as a projection, not a plan.', FOLDER_SIBLING, 1_700_000_000_400)
  seedNote(AT_OTHER, 'Rope care', 'Rinse the harbour ropes once a month.', FOLDER_OTHER, 1_700_000_000_500)
  seedNote(UNFILED, 'Loose sheet', 'A harbour note with no folder at all.', null, 1_700_000_000_600)
  sqlite.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(PREF_KEY, '1')
  for (const id of [AT_PROJECT, AT_SUBFOLDER, AT_GRANDFOLDER, AT_SIBLING, AT_OTHER, UNFILED]) seedVector(id)
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
async function keywordIds(folder: string | undefined) {
  const page = await searchMcpNotes(env, USER, 'https://notes.test', false, {
    query: QUERY,
    limit: 20,
    mode: 'lexical',
    folder,
  })
  return page.results.map((hit) => hit.id).sort()
}

// Distinct phrasings per case: `embedQueryText` caches a query embedding by its text, so two cases that
// asked in the same words would read each other's cache rather than the filter under test.
async function vectorIds(folder: string | undefined, ask: string) {
  return idsOf(await searchSemanticNotes(env, env.DB, USER, ask, { folder }))
}

beforeEach(() => seed())

describe('narrowing both halves by one folder', () => {
  it('takes the subtree in the vector half, not only the folder named exactly', async () => {
    const hits = await searchSemanticNotes(env, env.DB, USER, 'which harbour papers sit under a plan', {
      folder: PROJECT,
    })
    // Equal cosine and a cleared bar on every note, so this is the filter alone deciding: `Project` means
    // `Project` and every folder beneath it, exactly as it does in the keyword half and in the sidebar.
    expect(idsOf(hits)).toEqual([AT_PROJECT, AT_SUBFOLDER, AT_GRANDFOLDER].sort())
  })

  it('hands the fused page one candidate set, so the two lists rank the same notes', async () => {
    const vector = await vectorIds(PROJECT, 'harbour papers filed under a project')
    const keyword = await keywordIds(PROJECT)
    expect(vector).toEqual([AT_PROJECT, AT_SUBFOLDER, AT_GRANDFOLDER].sort())
    expect(new Set(vector)).toEqual(new Set(keyword))
  })

  it('walks to a nested folder by name the same way the keyword half does', async () => {
    const vector = await vectorIds(SUBFOLDER, 'the harbour sea lock drawings')
    expect(vector).toEqual([AT_SUBFOLDER, AT_GRANDFOLDER].sort())
    expect(new Set(vector)).toEqual(new Set(await keywordIds(SUBFOLDER)))
  })

  it('does not let the pinned folder claim the similarly named sibling', async () => {
    // `Project` must not swallow `Projection`: the keyword half seeds on `folders.name = ? COLLATE NOCASE`,
    // so equality — not a prefix — is what keeps the two branches apart, and the vector half has to inherit
    // that guard rather than trade it for a name-prefix rule.
    expect(await vectorIds(SIBLING, 'a harbour lamp shown as a projection')).toEqual([AT_SIBLING])
    const pinned = await vectorIds(PROJECT, 'harbour papers filed inside the project tree')
    expect(pinned).not.toContain(AT_SIBLING)
    expect(pinned).not.toContain(AT_OTHER)
    expect(pinned).not.toContain(UNFILED)
  })

  it('folds case the way the keyword half does', async () => {
    const lowered = await vectorIds('project', 'harbour papers under a lowercase project pin')
    expect(lowered).toEqual([AT_PROJECT, AT_SUBFOLDER, AT_GRANDFOLDER].sort())
    expect(new Set(lowered)).toEqual(new Set(await keywordIds('project')))
  })

  it('terminates on a parent_id cycle instead of spinning the scan', async () => {
    // Two folders that are each other's parent, both named `Loop`, each holding a note. `UNION` rather than
    // `UNION ALL` is what makes the walk stop — the guard the keyword half carries in
    // `tests/search-folder-scope.test.ts` — so it is carried here too rather than assumed: the same pin has
    // to answer both halves and must not hang the vector scan on the way.
    const loopA = '01hzzzzzzzzzzzzzzzzzzzzf06'
    const loopB = '01hzzzzzzzzzzzzzzzzzzzzf07'
    const noteA = '01hzzzzzzzzzzzzzzzzzzzzz07'
    const noteB = '01hzzzzzzzzzzzzzzzzzzzzz08'
    seedFolder(loopA, 'Loop', loopB)
    seedFolder(loopB, 'Loop', loopA)
    seedNote(noteA, 'Loop one', 'A harbour note inside the first loop folder.', loopA, 1_700_000_000_700)
    seedNote(noteB, 'Loop two', 'A harbour note inside the second loop folder.', loopB, 1_700_000_000_800)
    seedVector(noteA)
    seedVector(noteB)
    const vector = await vectorIds('Loop', 'harbour notes kept inside looping folders')
    expect(vector).toEqual([noteA, noteB].sort())
    expect(new Set(vector)).toEqual(new Set(await keywordIds('Loop')))
  })

  // Control for every case above: with no folder pinned, all six notes are candidates for both halves, so a
  // narrowed page says something about the narrowing and nothing about the seeding.
  it('keeps all six notes as candidates when no folder is pinned', async () => {
    const all = [AT_PROJECT, AT_SUBFOLDER, AT_GRANDFOLDER, AT_SIBLING, AT_OTHER, UNFILED].sort()
    expect(await vectorIds(undefined, 'every harbour paper in the notebook')).toEqual(all)
    expect(await keywordIds(undefined)).toEqual(all)
  })
})

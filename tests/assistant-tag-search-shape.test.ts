import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS } from '../src/shared/assistant'
import type { NoteScope } from '../src/worker/assistant/note-scope'
import { ToolExecutor, type ToolContext } from '../src/worker/assistant/tools'
import type { AssistantStore } from '../src/worker/assistant/store'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * A pinned `#tag` has to narrow the keyword half of a note search, not empty it.
 *
 * A turn's scope keeps tags as *ids* — the shape the folder pins and the permission check use — while the
 * retriever filters both of its lists by tag *name*: the keyword half turns `tags` into `tag:"…"` terms
 * compared against `t.name`, and `semanticWhere` in `mcp/ai-search.ts` binds `t.name` too. Handing the ids
 * over was therefore a filter no note can satisfy: a reader pinning `#meeting` got a keyword half that was
 * always empty, and on an index that is switched on the only hits left came from the vector list, which is
 * the "it matched but nothing says why" answer.
 *
 * The vector half is switched off in every case below, so any hit at all can only have come from keywords.
 */

const USER = 'user-1'
const TAGGED_NOTE = '01hzzzzzzzzzzzzzzzzzzzzz01'
const UNTAGGED_NOTE = '01hzzzzzzzzzzzzzzzzzzzzz02'
const MEETING_TAG = '01hzzzzzzzzzzzzzzzzzzzzz99'
const TAG_NAME = 'meeting'
const QUERY = 'harbour'

const PREF_KEY = `ai-search-enabled:${USER}`

let sqlite: DatabaseSync
let env: Env
let aiRun: Mock
let scope: NoteScope

function seedNote(id: string, title: string, content: string, updatedAt: number) {
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, title, title_key, content, excerpt, rev, word_count, char_count,
       is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 4, 4, 0, 0, 0, 0, 'hash', 1, ?, NULL)`,
  ).run(id, USER, title, title.toLowerCase(), content, content, updatedAt)
}

/** Both notes say "harbour"; only one of them carries the tag the reader pins. */
function seed() {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  seedNote(TAGGED_NOTE, 'Meeting notes', 'The harbour meeting minutes were taken at the dock.', 1_700_000_000_100)
  seedNote(UNTAGGED_NOTE, 'Boat care', 'Rinse the harbour ropes once a month.', 1_700_000_000_200)
  sqlite.prepare('INSERT INTO tags (id, user_id, name, is_manual, is_pinned, created_at) VALUES (?, ?, ?, 1, 0, 1)')
    .run(MEETING_TAG, USER, TAG_NAME)
  sqlite.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(TAGGED_NOTE, MEETING_TAG)
  // The meaning index stays off: a hit here is a keyword hit or it is nothing.
  sqlite.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(PREF_KEY, '0')
  aiRun = vi.fn(async () => ({ data: [] }))
  env = { DB: makeD1(sqlite), AI: { run: aiRun } } as unknown as Env
  scope = { restricted: false, folderIds: new Set(), tagIds: new Set(), noteIds: new Set() }
}

function context(): ToolContext {
  const store = {
    userId: USER,
    todayUsage: async () => ({ embeddings: 0 }),
    incrementUsage: async () => {},
    listTasks: async () => [],
    searchMemories: async () => [],
    listConversations: async () => [],
  }
  return {
    store: store as unknown as AssistantStore,
    env,
    ftsEnabled: false,
    origin: 'https://notes.test',
    settings: DEFAULT_ASSISTANT_SETTINGS,
    timezone: 'Asia/Shanghai',
    dayEnd: 1_700_000_000_000,
    mode: 'chat',
    memoryHistory: {} as ToolContext['memoryHistory'],
    memoryScope: { projectId: null },
    automations: {} as ToolContext['automations'],
    noteScope: async () => scope,
  }
}

const run = async (tool: string, query: string, callId = 'call-1') => await new ToolExecutor(context(), { maxToolCalls: 8 })
  .execute(tool, { query }, callId) as Record<string, unknown>

const idsOf = (payload: Record<string, unknown>) => ((payload.results ?? []) as Array<Record<string, unknown>>).map((hit) => hit.id)
/** The `search` tool answers under `notes` rather than `results`, and carries no `source` field. */
const noteIdsOf = (payload: Record<string, unknown>) => ((payload.notes ?? []) as Array<Record<string, unknown>>).map((hit) => hit.id)

beforeEach(() => seed())

describe('searching notes inside a pinned tag', () => {
  it('keeps the keyword hit the pinned tag actually covers', async () => {
    scope = { restricted: true, folderIds: new Set(), tagIds: new Set([MEETING_TAG]), noteIds: new Set() }
    const payload = await run('search_notes', QUERY)
    expect(payload.retrieval).toBe('lexical')
    expect(aiRun).not.toHaveBeenCalled()
    expect(idsOf(payload)).toEqual([TAGGED_NOTE])
  })

  it('leaves the untagged note out, so the pin is a filter and not a label', async () => {
    scope = { restricted: true, folderIds: new Set(), tagIds: new Set([MEETING_TAG]), noteIds: new Set() }
    const payload = await run('search_notes', QUERY)
    expect(idsOf(payload)).not.toContain(UNTAGGED_NOTE)
  })

  // The control for the two cases above: the same query over the same data without a pin finds both, so a
  // narrowed page that comes back empty says something about the narrowing, not about the seeding.
  it('finds both notes when no tag is pinned', async () => {
    const payload = await run('search_notes', QUERY)
    expect(idsOf(payload)).toEqual([UNTAGGED_NOTE, TAGGED_NOTE])
  })

  it('narrows the vault-wide search tool the same way', async () => {
    scope = { restricted: true, folderIds: new Set(), tagIds: new Set([MEETING_TAG]), noteIds: new Set() }
    const payload = await run('search', QUERY)
    expect(noteIdsOf(payload)).toEqual([TAGGED_NOTE])
  })

  it('keeps searching by keyword when a pin names a tag the account no longer has', async () => {
    // A deleted tag leaves a stale id behind. It cannot be translated to a name, and the scope check that
    // runs after retrieval still refuses every note, so the pin is dropped from the filter rather than
    // passed on as a tag name no note carries.
    scope = { restricted: true, folderIds: new Set(), tagIds: new Set(['01hzzzzzzzzzzzzzzzzzzzzz98']), noteIds: new Set() }
    const payload = await run('search_notes', QUERY)
    expect(idsOf(payload)).toEqual([])
  })
})

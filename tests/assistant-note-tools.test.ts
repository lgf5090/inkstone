import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS } from '../src/shared/assistant'
import type { NoteScope } from '../src/worker/assistant/note-scope'
import { ToolExecutor, type ToolContext } from '../src/worker/assistant/tools'
import type { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * The listing tools, run the way the model runs them.
 *
 * The reader's complaint was that asking "how many notes do I have" got an answer built out of whatever
 * `search_notes` happened to match, or no answer at all. `assistant-vault.test.ts` pins the SQL; this
 * pins the wire the model actually touches — the tool name, its argument validation, and the shape of
 * what comes back — because a tool that is registered but answers with an empty object is the same
 * failure from the reader's side.
 */

const USER = 'user-1'
const WORK = '01hzzzzzzzzzzzzzzzzzzzzz01'
const PERSONAL = '01hzzzzzzzzzzzzzzzzzzzzz02'
const IN_WORK = '01hzzzzzzzzzzzzzzzzzzzzz11'
const IN_WORK_CHILD = '01hzzzzzzzzzzzzzzzzzzzzz12'
const IN_PERSONAL = '01hzzzzzzzzzzzzzzzzzzzzz13'
const TAG = '01hzzzzzzzzzzzzzzzzzzzzz21'

let env: Env
let scope: NoteScope

function seed(): Env {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE notes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, folder_id TEXT, title TEXT NOT NULL,
      excerpt TEXT NOT NULL DEFAULT '', is_starred INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, deleted_at INTEGER
    );
    CREATE TABLE folders (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL,
      position REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
    );
    CREATE TABLE tags (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE note_tags (note_id TEXT NOT NULL, tag_id TEXT NOT NULL);
  `)
  sqlite.prepare('INSERT INTO folders VALUES (?, ?, NULL, ?, 0, 1, 1, NULL)').run(WORK, USER, '工作')
  sqlite.prepare('INSERT INTO folders VALUES (?, ?, ?, ?, 0, 1, 1, NULL)').run('01hzzzzzzzzzzzzzzzzzzzzz03', USER, WORK, '会议')
  sqlite.prepare('INSERT INTO folders VALUES (?, ?, NULL, ?, 0, 1, 1, NULL)').run(PERSONAL, USER, '生活')
  sqlite.prepare('INSERT INTO tags VALUES (?, ?, ?, NULL, 1)').run(TAG, USER, '重点')
  const rows: Array<[string, string, string, number, number]> = [
    [IN_WORK, WORK, '季度计划', 1, 100],
    [IN_WORK_CHILD, '01hzzzzzzzzzzzzzzzzzzzzz03', '周会纪要', 0, 90],
    [IN_PERSONAL, PERSONAL, '购物清单', 0, 80],
  ]
  for (const [id, folder, title, starred, ts] of rows) {
    sqlite.prepare(`INSERT INTO notes (id, user_id, folder_id, title, excerpt, is_starred, updated_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(id, USER, folder, title, `${title} 的摘要`, starred, 1_700_000_000_000 + ts)
  }
  sqlite.prepare('INSERT INTO note_tags VALUES (?, ?)').run(IN_PERSONAL, TAG)
  return { DB: makeD1(sqlite) } as unknown as Env
}

const openScope = (): NoteScope => ({ restricted: false, folderIds: new Set(), tagIds: new Set(), noteIds: new Set() })

function context(over: Partial<ToolContext> = {}): ToolContext {
  return {
    store: { userId: USER } as unknown as AssistantStore,
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
    ...over,
  }
}

const run = (name: string, args: Record<string, unknown> = {}, over: Partial<ToolContext> = {}) =>
  new ToolExecutor(context(over), { maxToolCalls: 8 }).execute(name, args, 'call-1')

beforeEach(() => {
  env = seed()
  scope = openScope()
})

describe('counting the notebook from a tool call', () => {
  it('answers how many notes there are, and where they sit', async () => {
    const result = await run('count_notes') as Record<string, unknown>
    expect(result.total).toBe(3)
    expect(result.starred).toBe(1)
    expect(result.by_folder).toEqual([
      { path: '工作', count: 1 },
      { path: '工作 / 会议', count: 1 },
      { path: '生活', count: 1 },
    ])
    expect(result.by_tag).toEqual([{ name: '重点', count: 1 }])
    expect(result.scope).toBeUndefined()
  })

  it('counts a folder and its subfolders when the model names one', async () => {
    const result = await run('count_notes', { folder: '工作' }) as Record<string, unknown>
    expect(result.total).toBe(2)
  })

  it('refuses a folder the vault does not have, and names the tool that lists them', async () => {
    // An empty answer would read to the model as "you have no such notes", which is a different claim
    // from "that folder is not one of yours".
    await expect(run('count_notes', { folder: '没有这个文件夹' })).rejects.toThrow(/list_folders/)
  })

  it('leaves out what the reader told the assistant to leave out', async () => {
    scope = { restricted: true, folderIds: new Set([PERSONAL]), tagIds: new Set(), noteIds: new Set() }
    const result = await run('count_notes') as Record<string, unknown>
    expect(result.total).toBe(1)
    expect(result.scope).toBeTruthy()
  })
})

describe('listing the notebook from a tool call', () => {
  it('lists newest first with the folder and tags of each note, and says how many there were', async () => {
    const result = await run('list_notes') as Record<string, unknown>
    expect(result.total).toBe(3)
    expect(result.returned).toBe(3)
    expect(result.note).toBeUndefined()
    const notes = result.notes as Array<Record<string, unknown>>
    expect(notes.map((note) => note.id)).toEqual([IN_WORK, IN_WORK_CHILD, IN_PERSONAL])
    expect(notes[0]).toMatchObject({ title: '季度计划', folder: '工作', tags: [] })
    expect(notes[2]).toMatchObject({ folder: '生活', tags: ['重点'] })
  })

  it('says out loud that the page is not the whole answer', async () => {
    const result = await run('list_notes', { limit: 1 }) as Record<string, unknown>
    expect(result.returned).toBe(1)
    expect(result.total).toBe(3)
    expect(String(result.note)).toContain('limit')
  })

  it('takes a view, and an unknown one is not a filter', async () => {
    const starred = await run('list_notes', { view: 'starred' }) as Record<string, unknown>
    expect((starred.notes as Array<Record<string, unknown>>).map((note) => note.id)).toEqual([IN_WORK])
  })

  it('lists the folders and the tags so a name can be used correctly', async () => {
    expect((await run('list_folders') as { folders: unknown[] }).folders).toEqual([
      { path: '工作', count: 1 },
      { path: '工作 / 会议', count: 1 },
      { path: '生活', count: 1 },
    ])
    expect((await run('list_tags') as { tags: unknown[] }).tags).toEqual([{ name: '重点', count: 1 }])
  })
})

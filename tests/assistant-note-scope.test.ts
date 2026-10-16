import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { readableNoteIds, resolveNoteScope, assertNoteReadable } from '../src/worker/assistant/note-scope'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * What one turn of the assistant is allowed to read.
 *
 * The reader can point the assistant at a couple of folders, and that is a permission: a model that
 * ignores the line in its prompt describing the scope must still be refused by the SQL underneath. The
 * note they had open when they asked is the one deliberate exception, and this is where it is pinned —
 * a widening that reached a folder instead of one named note would be the bug this file exists for.
 */

const USER = 'user-1'
/** ULID-shaped, because every id in the scope path is validated by shape before it reaches SQL. */
const WORK = '01hzzzzzzzzzzzzzzzzzzzzz01'
const OTHER_FOLDER = '01hzzzzzzzzzzzzzzzzzzzzz02'
const IN_WORK = '01hzzzzzzzzzzzzzzzzzzzzz11'
const IN_OTHER = '01hzzzzzzzzzzzzzzzzzzzzz12'
const TAG = '01hzzzzzzzzzzzzzzzzzzzzz21'
const TAGGED = '01hzzzzzzzzzzzzzzzzzzzzz13'

let db: D1Database

function seed(): D1Database {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE folders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, deleted_at INTEGER);
    CREATE TABLE notes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, folder_id TEXT, deleted_at INTEGER);
    CREATE TABLE note_tags (note_id TEXT NOT NULL, tag_id TEXT NOT NULL);
  `)
  for (const id of [WORK, OTHER_FOLDER]) {
    sqlite.prepare('INSERT INTO folders (id, user_id, parent_id, name) VALUES (?, ?, NULL, ?)').run(id, USER, id)
  }
  sqlite.prepare('INSERT INTO folders (id, user_id, parent_id, name, deleted_at) VALUES (?, ?, NULL, ?, 1)')
    .run('01hzzzzzzzzzzzzzzzzzzzzz99', USER, 'gone')
  const rows: Array<[string, string | null]> = [[IN_WORK, WORK], [IN_OTHER, OTHER_FOLDER], [TAGGED, OTHER_FOLDER]]
  for (const [id, folder] of rows) {
    sqlite.prepare('INSERT INTO notes (id, user_id, folder_id) VALUES (?, ?, ?)').run(id, USER, folder)
  }
  sqlite.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(TAGGED, TAG)
  return makeD1(sqlite)
}

/** The scope a reader gets when they allowed the assistant nothing in particular. */
const openScope = { restricted: false, folderIds: new Set<string>(), tagIds: new Set<string>(), noteIds: new Set<string>() }

beforeEach(() => {
  db = seed()
})

describe('a note the reader allowed the assistant to read', () => {
  it('reads anything in a vault with no scope set', async () => {
    const allowed = await readableNoteIds(db, USER, [IN_WORK, IN_OTHER], openScope)
    expect([...allowed].sort()).toEqual([IN_WORK, IN_OTHER].sort())
  })

  it('reads only what is inside the folders the reader named', async () => {
    const scope = await resolveNoteScope(db, USER, [WORK])
    expect(scope.restricted).toBe(true)
    expect([...(await readableNoteIds(db, USER, [IN_WORK, IN_OTHER], scope))]).toEqual([IN_WORK])
  })

  it('reads nothing when the folder the reader named has since been deleted', async () => {
    const scope = await resolveNoteScope(db, USER, ['01hzzzzzzzzzzzzzzzzzzzzz99'])
    expect(scope.restricted).toBe(true)
    expect(scope.folderIds.size).toBe(0)
    // The direction that matters: an empty scope is "nothing", never "no scope at all".
    expect((await readableNoteIds(db, USER, [IN_WORK, IN_OTHER], scope)).size).toBe(0)
  })

  it('reads one turn\'s pinned note even though its folder is out of scope', async () => {
    const scope = await resolveNoteScope(db, USER, [WORK], { noteIds: [IN_OTHER] })
    const allowed = await readableNoteIds(db, USER, [IN_WORK, IN_OTHER], scope)
    expect([...allowed].sort()).toEqual([IN_OTHER, IN_WORK].sort())
    await expect(assertNoteReadable(db, USER, IN_OTHER, scope)).resolves.toBeUndefined()
  })

  it('does not turn that one note into the rest of its folder', async () => {
    const scope = await resolveNoteScope(db, USER, [WORK], { noteIds: [IN_OTHER] })
    // TAGGED sits in the same excluded folder as the pinned note and is still refused.
    expect((await readableNoteIds(db, USER, [TAGGED], scope)).size).toBe(0)
  })

  it('reads a note outside every folder when a tag is what the turn pinned', async () => {
    const scope = await resolveNoteScope(db, USER, [], { tagIds: [TAG] })
    expect(scope.restricted).toBe(true)
    expect([...(await readableNoteIds(db, USER, [IN_WORK, TAGGED], scope))]).toEqual([TAGGED])
    expect(scope.noteIds.size).toBe(0)
  })

  it('refuses a note id that is not even the right shape', async () => {
    await expect(assertNoteReadable(db, USER, 'not-an-id', openScope)).rejects.toThrow()
  })
})

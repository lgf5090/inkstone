// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { searchUserNotes } from '../src/worker/routes/search'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { makeD1 } from './doubles/d1-sqlite'

const MINE = 'user-a'
const OTHER = 'user-b'

let sqlite: DatabaseSync
let db: D1Database

function folder(id: string, user: string, name: string, parent: string | null) {
  sqlite.prepare(
    'INSERT INTO folders (id, user_id, parent_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 1, 1)',
  ).run(id, user, parent, name)
}

function note(id: string, user: string, title: string, folderId: string | null, archived = false) {
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, folder_id, title, title_key, content, excerpt, rev,
       word_count, char_count, is_pinned, is_starred, is_archived, position, content_hash,
       created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, 'body text', 'body text', 1, 0, 0, 0, 0, ?, 0, '', 1, 1, NULL)`,
  ).run(id, user, folderId, title, title, archived ? 1 : 0)
}

const titles = async (query: string) => (await searchUserNotes(db, MINE, query, 50, false)).results
  .map((hit) => hit.note.title).sort()

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  folder('f-root', MINE, 'Proj', null)
  folder('f-mid', MINE, 'Middle', 'f-root')
  folder('f-leaf', MINE, 'Leaf', 'f-mid')
  folder('f-side', MINE, 'Other', null)
  folder('f-theirs', OTHER, 'Proj', null)
  // A parent_id cycle has to terminate rather than spin.
  folder('f-cyc-a', MINE, 'Loop', 'f-cyc-b')
  folder('f-cyc-b', MINE, 'Loop', 'f-cyc-a')

  note('n-root', MINE, 'At Root', 'f-root')
  note('n-mid', MINE, 'At Middle', 'f-mid')
  note('n-leaf', MINE, 'At Leaf', 'f-leaf')
  note('n-side', MINE, 'At Side', 'f-side')
  note('n-loose', MINE, 'No Folder', null)
  note('n-archived', MINE, 'Archived In Folder', 'f-root', true)
  note('n-theirs', OTHER, 'Their Note', 'f-theirs')
})

describe('operator-only queries', () => {
  // Control for the folder tests below: this query never reaches the folder clause, so the
  // same failure here means the defect is in the shared ORDER BY, not in folder scoping.
  it('answers a tag-only query', async () => {
    sqlite.prepare('INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, 1)').run('t1', MINE, 'x')
    sqlite.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run('n-mid', 't1')
    expect(await titles('tag:x')).toEqual(['At Middle'])
  })

  it('answers a starred-only query', async () => {
    sqlite.prepare('UPDATE notes SET is_starred = 1 WHERE id = ?').run('n-leaf')
    expect(await titles('is:starred')).toEqual(['At Leaf'])
  })
})

describe('folder: operator', () => {
  it('matches notes in the named folder and every descendant of it', async () => {
    expect(await titles('folder:"Proj"')).toEqual(['Archived In Folder', 'At Leaf', 'At Middle', 'At Root'])
  })

  it('matches the folder name without regard to case', async () => {
    expect(await titles('folder:"proj"')).toEqual(['Archived In Folder', 'At Leaf', 'At Middle', 'At Root'])
  })

  it('never reaches another account that names a folder the same', async () => {
    expect(await titles('folder:"Proj"')).not.toContain('Their Note')
    expect((await searchUserNotes(db, OTHER, 'folder:"Proj"', 50, false)).results
      .map((hit) => hit.note.title)).toEqual(['Their Note'])
  })

  it('returns a subtree search for a nested folder name too', async () => {
    expect(await titles('folder:"Middle"')).toEqual(['At Leaf', 'At Middle'])
  })

  it('terminates on a parent_id cycle instead of looping forever', async () => {
    expect(await titles('folder:"Loop"')).toEqual([])
  })
})

describe('archive scope of search', () => {
  it('includes archived notes unless the query says otherwise', async () => {
    expect(await titles('Archived')).toContain('Archived In Folder')
    expect(await titles('Archived is:unarchived')).toEqual([])
    expect(await titles('Archived is:archived')).toEqual(['Archived In Folder'])
  })
})

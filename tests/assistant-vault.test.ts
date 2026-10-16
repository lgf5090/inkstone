import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import type { NoteScope } from '../src/worker/assistant/note-scope'
import {
  countVaultNotes,
  folderSubtree,
  listVaultFolders,
  listVaultNotes,
  listVaultTags,
  matchVaultFolders,
  resolveVaultTag,
} from '../src/worker/assistant/vault'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * What the assistant can say about the notebook itself.
 *
 * The reader's question was "how many notes do I have", and the answer used to be "I cannot tell":
 * `search_notes` matches a topic, so the count it reported was however many notes happened to contain
 * the words. These are the listings that answer the question directly, and the scope every note tool
 * obeys has to hold here too — a count that leaked a folder the reader excluded would be a permission
 * bug wearing the costume of a nice feature.
 */

const USER = 'user-1'
const OTHER = 'user-2'

/** Two branch names, one nesting, and enough notes to tell a filter from a whole-vault answer. */
const FOLDERS: Array<[string, string, string | null]> = [
  ['f-work', 'Work', null],
  ['f-notes', 'Notes', 'f-work'],
  ['f-personal', 'Personal', null],
]

/** id, folder, starred, archived, deleted, updatedAt, excerpt */
const NOTES: Array<[string, string | null, number, number, number | null, number, string]> = [
  ['n-1', 'f-work', 1, 0, null, 1_700_000_000_500, 'quarterly plan'],
  ['n-2', 'f-notes', 0, 0, null, 1_700_000_000_400, 'meeting minutes'],
  ['n-3', 'f-personal', 0, 0, null, 1_700_000_000_300, 'grocery list'],
  ['n-4', null, 0, 0, null, 1_700_000_000_200, 'scratch'],
  ['n-5', null, 0, 1, null, 1_700_000_000_100, 'filed away'],
  ['n-6', 'f-work', 0, 0, 1_700_000_000_000, 1_699_999_999_900, 'in the trash'],
]

const TAGS: Array<[string, string]> = [
  ['t-meeting', 'meeting'],
  ['t-idea', 'idea'],
]

const NOTE_TAGS: Array<[string, string]> = [
  ['n-1', 't-meeting'],
  ['n-2', 't-meeting'],
  ['n-3', 't-idea'],
]

interface Fixture {
  db: D1Database
  sqlite: DatabaseSync
}

function seed(): Fixture {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE notes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, folder_id TEXT, title TEXT NOT NULL,
      title_key TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '',
      excerpt TEXT NOT NULL DEFAULT '', rev INTEGER NOT NULL DEFAULT 1,
      word_count INTEGER NOT NULL DEFAULT 0, char_count INTEGER NOT NULL DEFAULT 0,
      is_pinned INTEGER NOT NULL DEFAULT 0, is_starred INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0, position REAL NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, deleted_at INTEGER
    );
    CREATE TABLE folders (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL,
      icon TEXT, color TEXT, position REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
    );
    CREATE TABLE tags (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT,
      is_manual INTEGER NOT NULL DEFAULT 0, is_pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE note_tags (note_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (note_id, tag_id));
  `)
  for (const [id, name, parentId] of FOLDERS) {
    sqlite.prepare(`INSERT INTO folders (id, user_id, parent_id, name, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, USER, parentId, name, 0, 1, 1)
  }
  // Another account's folder with the same name: every query is per-account, and a listing that
  // matched on name alone would answer about it.
  sqlite.prepare(`INSERT INTO folders (id, user_id, parent_id, name, position, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?)`).run('f-other', OTHER, 'Work', 0, 1, 1)
  for (const [id, folderId, starred, archived, deletedAt, updatedAt, excerpt] of NOTES) {
    sqlite.prepare(`INSERT INTO notes
      (id, user_id, folder_id, title, excerpt, is_starred, is_archived, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, USER, folderId, `title of ${id}`, excerpt, starred, archived, 1, updatedAt, deletedAt)
  }
  sqlite.prepare(`INSERT INTO notes
    (id, user_id, folder_id, title, excerpt, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?)`)
    .run('n-other', OTHER, 'their note', 'not mine', 1, 1)
  for (const [id, name] of TAGS) {
    sqlite.prepare(`INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, ?)`).run(id, USER, name, 1)
  }
  for (const [noteId, tagId] of NOTE_TAGS) {
    sqlite.prepare(`INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)`).run(noteId, tagId)
  }
  return { db: makeD1(sqlite), sqlite }
}

const openScope: NoteScope = { restricted: false, folderIds: new Set(), tagIds: new Set(), noteIds: new Set() }
const scopedTo = (...folderIds: string[]): NoteScope => ({ restricted: true, folderIds: new Set(folderIds), tagIds: new Set(), noteIds: new Set() })

let fixture: Fixture

beforeEach(() => {
  fixture = seed()
})

describe('counting the notebook', () => {
  it('counts every live note, with the filed-away ones reported beside the total', async () => {
    const counts = await countVaultNotes(fixture.db, USER, openScope)
    // Six seeded, one in the trash: a count that included the trash would tell the reader they have a
    // note they cannot find anywhere.
    expect(counts.total).toBe(5)
    expect(counts.archived).toBe(1)
    expect(counts.starred).toBe(1)
    expect(counts.scopeLimited).toBe(false)
  })

  it('says where the notes sit, by folder path and by tag', async () => {
    const counts = await countVaultNotes(fixture.db, USER, openScope)
    expect(counts.folders).toEqual([
      { path: '(no folder)', count: 2 },
      { path: 'Personal', count: 1 },
      { path: 'Work', count: 1 },
      { path: 'Work / Notes', count: 1 },
    ])
    expect(counts.tags).toEqual([{ name: 'meeting', count: 2 }, { name: 'idea', count: 1 }])
  })

  it('never counts another account\'s notes', async () => {
    const counts = await countVaultNotes(fixture.db, OTHER, openScope)
    expect(counts.total).toBe(1)
  })

  it('answers about a folder and everything under it', async () => {
    const subtree = await folderSubtree(fixture.db, USER, 'f-work')
    expect(subtree.sort()).toEqual(['f-notes', 'f-work'])
    const counts = await countVaultNotes(fixture.db, USER, openScope, { folderIds: subtree })
    expect(counts.total).toBe(2)
    expect(counts.folders).toEqual([{ path: 'Work', count: 1 }, { path: 'Work / Notes', count: 1 }])
  })

  it('answers about one tag', async () => {
    const tag = await resolveVaultTag(fixture.db, USER, 'Meeting')
    expect(tag?.id).toBe('t-meeting')
    const counts = await countVaultNotes(fixture.db, USER, openScope, { tagId: tag!.id })
    expect(counts.total).toBe(2)
  })

  it('counts nothing rather than everything when the scope names folders that no longer exist', async () => {
    // The reader deleted the folder the assistant was pointed at. Reading an empty scope as "no scope
    // set" is the direction that hands back the whole vault, so this is the case worth pinning.
    const counts = await countVaultNotes(fixture.db, USER, scopedTo('f-gone'), {})
    expect(counts.total).toBe(0)
    expect(counts.scopeLimited).toBe(true)
  })
})

describe('listing the notebook', () => {
  it('lists newest first, outside the trash and without the filed-away ones', async () => {
    const listing = await listVaultNotes(fixture.db, USER, openScope, {})
    expect(listing.notes.map((note) => note.id)).toEqual(['n-1', 'n-2', 'n-3', 'n-4'])
    expect(listing.total).toBe(4)
  })

  it('carries the folder path and the tags of each note', async () => {
    const listing = await listVaultNotes(fixture.db, USER, openScope, {})
    expect(listing.notes[0]).toMatchObject({ folder: 'Work', tags: ['meeting'], starred: true })
    expect(listing.notes[1]).toMatchObject({ folder: 'Work / Notes', tags: ['meeting'] })
    expect(listing.notes[3]).toMatchObject({ folder: null, tags: [] })
  })

  it('lists the starred view, the archived view, and a page no larger than asked for', async () => {
    const starred = await listVaultNotes(fixture.db, USER, openScope, { view: 'starred' })
    expect(starred.notes.map((note) => note.id)).toEqual(['n-1'])
    const archived = await listVaultNotes(fixture.db, USER, openScope, { view: 'archived' })
    expect(archived.notes.map((note) => note.id)).toEqual(['n-5'])
    const page = await listVaultNotes(fixture.db, USER, openScope, { limit: 2 })
    expect(page.notes).toHaveLength(2)
    // The total is what the page was cut out of, which is what makes "20 of 137" sayable.
    expect(page.total).toBe(4)
  })

  it('keeps a listing inside the folders the reader allowed', async () => {
    const listing = await listVaultNotes(fixture.db, USER, scopedTo('f-personal'), {})
    expect(listing.notes.map((note) => note.id)).toEqual(['n-3'])
    expect(listing.total).toBe(1)
    expect(listing.scopeLimited).toBe(true)
  })

  it('narrows by a tag pinned for one turn', async () => {
    const scope: NoteScope = { restricted: true, folderIds: new Set(), tagIds: new Set(['t-idea']), noteIds: new Set() }
    const listing = await listVaultNotes(fixture.db, USER, scope, {})
    expect(listing.notes.map((note) => note.id)).toEqual(['n-3'])
  })
})

describe('naming folders and tags', () => {
  it('reads a folder by its own name, by a branch name, and by its full path', async () => {
    expect((await matchVaultFolders(fixture.db, USER, 'Personal')).map((match) => match.label)).toEqual(['Personal'])
    expect((await matchVaultFolders(fixture.db, USER, 'Notes')).map((match) => match.label)).toEqual(['Work / Notes'])
    expect((await matchVaultFolders(fixture.db, USER, 'Work / Notes')).map((match) => match.id)).toEqual(['f-notes'])
    expect(await matchVaultFolders(fixture.db, USER, 'Nowhere')).toEqual([])
  })

  it('answers a folder name inside the account that asked', async () => {
    // Two accounts can each own a folder called Work. The lookup is keyed by the account, so neither
    // reader can be shown the other's branch by naming it.
    expect((await matchVaultFolders(fixture.db, USER, 'Work')).map((match) => match.id)).toEqual(['f-work'])
    expect((await matchVaultFolders(fixture.db, OTHER, 'Work')).map((match) => match.id)).toEqual(['f-other'])
  })

  it('lists the tree with what each folder holds directly, and the tags in use', async () => {
    expect(await listVaultFolders(fixture.db, USER, openScope)).toEqual([
      { path: 'Personal', count: 1 },
      { path: 'Work', count: 1 },
      { path: 'Work / Notes', count: 1 },
    ])
    // A tag with no notes is still listed: hiding it makes the reader think it was deleted.
    expect(await listVaultTags(fixture.db, USER, openScope)).toEqual([
      { name: 'meeting', count: 2 },
      { name: 'idea', count: 1 },
    ])
  })

  it('shows only the folders in scope when the reader allowed some', async () => {
    expect(await listVaultFolders(fixture.db, USER, scopedTo('f-personal'))).toEqual([
      { path: 'Personal', count: 1 },
    ])
  })
})

import { DatabaseSync } from 'node:sqlite'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  NOTE_COLUMNS,
  NOTE_COLUMNS_NOTAGS,
  attachNoteTags,
  noteTagsQueryForPage,
  splitTags,
  toNoteSummary,
  type NoteRow,
  type NoteTagRow,
} from '../src/worker/db/rows'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'
const OTHER = 'user-b'

let sqlite: DatabaseSync
let db: D1Database

const pageFrom = `FROM notes n WHERE n.user_id = ?1 AND n.deleted_at IS NULL
   ORDER BY n.updated_at DESC, n.id ASC LIMIT ?2`

function note(id: string, userId: string, updatedAt: number) {
  sqlite.prepare(
    'INSERT INTO notes (id, user_id, title, content, excerpt, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
  ).run(id, userId, id, `body ${id}`, '', updatedAt, updatedAt)
}

function tag(id: string, userId: string, name: string) {
  sqlite.prepare('INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, 1)').run(id, userId, name)
}

beforeAll(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  for (let index = 1; index <= 5; index++) note(`a-${index}`, USER, 100 + index)
  note('b-1', OTHER, 200)
  tag('t-red', USER, 'red')
  tag('t-blue', USER, 'blue')
  tag('t-zebra', USER, 'zebra')
  tag('t-other', OTHER, 'foreign')
  const link = sqlite.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)')
  link.run('a-1', 't-blue')
  link.run('a-1', 't-red')
  link.run('a-1', 't-zebra')
  link.run('a-3', 't-red')
  link.run('a-5', 't-zebra')
  // Corrupt row on purpose: tags owned by another account must never surface on this page.
  link.run('a-2', 't-other')
  db = makeD1(sqlite)
})

const tagsByRowId = (rows: NoteRow[]) => new Map(rows.map((row) => [row.id, toNoteSummary(row).tags]))

describe('note page tags', () => {
  it('returns the same tags as the per-row GROUP_CONCAT subquery', async () => {
    const legacy = await db.prepare(`SELECT ${NOTE_COLUMNS} ${pageFrom}`).bind(USER, 10).all<NoteRow>()
    const [page, tagRows] = await db.batch([
      db.prepare(`SELECT ${NOTE_COLUMNS_NOTAGS} ${pageFrom}`).bind(USER, 10),
      db.prepare(noteTagsQueryForPage(pageFrom)).bind(USER, 10),
    ])
    const split = (page?.results as NoteRow[] | undefined) ?? []
    attachNoteTags(split, (tagRows?.results as NoteTagRow[] | undefined) ?? [])
    expect(tagsByRowId(split)).toEqual(tagsByRowId(legacy.results as NoteRow[]))
    expect([...tagsByRowId(split).entries()]).toEqual([
      ['a-5', ['zebra']],
      ['a-4', []],
      ['a-3', ['red']],
      ['a-2', []],
      ['a-1', ['blue', 'red', 'zebra']],
    ])
  })

  it('keeps the page window and skips notes without tags', async () => {
    const [page, tagRows] = await db.batch([
      db.prepare(`SELECT ${NOTE_COLUMNS_NOTAGS} ${pageFrom}`).bind(USER, 2),
      db.prepare(noteTagsQueryForPage(pageFrom)).bind(USER, 2),
    ])
    const rows = (page?.results as NoteRow[] | undefined) ?? []
    attachNoteTags(rows, (tagRows?.results as NoteTagRow[] | undefined) ?? [])
    expect(rows.map((row) => [row.id, splitTags(row.tag_names)])).toEqual([
      ['a-5', ['zebra']],
      ['a-4', []],
    ])
  })

  it('never attaches a tag owned by another account', async () => {
    const [page, tagRows] = await db.batch([
      db.prepare(`SELECT ${NOTE_COLUMNS_NOTAGS} ${pageFrom}`).bind(USER, 10),
      db.prepare(noteTagsQueryForPage(pageFrom)).bind(USER, 10),
    ])
    const rows = (page?.results as NoteRow[] | undefined) ?? []
    attachNoteTags(rows, (tagRows?.results as NoteTagRow[] | undefined) ?? [])
    expect(rows.map((row) => row.tag_names).join('|')).not.toContain('foreign')
  })

  // The routes read a mid-batch SELECT by index (count, page, tags) while still using
  // results.at(-1) for the change seq, so position alignment is load bearing.
  it('keeps batch results aligned with the pushed statement order', async () => {
    const results = await db.batch([
      db.prepare(`SELECT COUNT(*) AS total FROM notes n WHERE n.user_id = ?1 AND n.deleted_at IS NULL`).bind(USER),
      db.prepare(`SELECT ${NOTE_COLUMNS_NOTAGS} ${pageFrom}`).bind(USER, 2),
      db.prepare(noteTagsQueryForPage(pageFrom)).bind(USER, 2),
    ])
    expect((results[0] as { results: { total: number }[] }).results[0]?.total).toBe(5)
    expect(((results[1] as { results: NoteRow[] }).results).map((row) => row.id)).toEqual(['a-5', 'a-4'])
    expect(((results[2] as { results: NoteTagRow[] }).results).map((row) => row.note_id)).toEqual(['a-5'])
    expect(results.at(-1)).toBe(results[2])
  })
})

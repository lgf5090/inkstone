// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { LIMITS } from '@shared/constants'
import { fetchSearchDocuments } from '../src/worker/routes/search'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { makeD1 } from './doubles/d1-sqlite'

const MINE = 'user-a'
const OTHER = 'user-b'

let sqlite: DatabaseSync
let db: D1Database

function note(id: string, user: string, title: string, content: string, options: {
  deleted?: boolean
  archived?: boolean
} = {}) {
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, folder_id, title, title_key, content, excerpt, rev,
       word_count, char_count, is_pinned, is_starred, is_archived, position, content_hash,
       created_at, updated_at, deleted_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, 1, 0, 0, 0, 0, ?, 0, '', 1, 1000, ?)`,
  ).run(id, user, title, title, content, content, options.archived ? 1 : 0, options.deleted ? 1 : null)
}

const byId = (rows: { id: string }[]) => rows.map((row) => row.id).sort()

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  note('a'.repeat(26), MINE, 'Latte', 'milk and foam')
  note('b'.repeat(26), MINE, 'Archived', 'cold brew', { archived: true })
  note('c'.repeat(26), MINE, 'Trashed', 'in the bin', { deleted: true })
  note('d'.repeat(26), OTHER, 'Theirs', 'secret tea')
})

describe('fetchSearchDocuments', () => {
  it('hands over the body the client index needs', async () => {
    const { items } = await fetchSearchDocuments(db, MINE, ['a'.repeat(26)])
    expect(items).toHaveLength(1)
    expect(items[0]!.content).toBe('milk and foam')
    expect(items[0]!.title).toBe('Latte')
    expect(items[0]!.chars).toBe(13)
    expect(items[0]!.updatedAt).toBe(1000)
    expect(items[0]!.archived).toBe(false)
  })

  it('never crosses the account boundary', async () => {
    const { items, missing } = await fetchSearchDocuments(db, MINE, ['d'.repeat(26)])
    expect(items).toEqual([])
    expect(missing).toEqual(['d'.repeat(26)])
  })

  it('leaves the trash out of the index', async () => {
    const { items } = await fetchSearchDocuments(db, MINE, ['c'.repeat(26)])
    expect(items).toEqual([])
  })

  it('keeps archived notes indexable so hiding them stays a ranking choice', async () => {
    const { items } = await fetchSearchDocuments(db, MINE, ['b'.repeat(26)])
    expect(byId(items)).toEqual(['b'.repeat(26)])
    expect(items[0]!.archived).toBe(true)
  })

  it('reports ids it could not serve', async () => {
    const { items, missing } = await fetchSearchDocuments(db, MINE, ['a'.repeat(26), 'z'.repeat(26)])
    expect(byId(items)).toEqual(['a'.repeat(26)])
    expect(missing).toEqual(['z'.repeat(26)])
  })

  it('cuts a huge note at the documented ceiling but keeps its true size', async () => {
    const big = 'e'.repeat(26)
    note(big, MINE, 'Huge', 'x'.repeat(LIMITS.omnisearchDocumentChars + 500))
    const { items } = await fetchSearchDocuments(db, MINE, [big])
    expect(items[0]!.content).toHaveLength(LIMITS.omnisearchDocumentChars)
    expect(items[0]!.chars).toBe(LIMITS.omnisearchDocumentChars + 500)
  })

  it('keeps a page bounded, and never returns nothing for a page it was given', async () => {
    const ids: string[] = []
    for (let index = 0; index < 8; index++) {
      const id = String.fromCharCode(102 + index).repeat(26)
      note(id, MINE, `Big ${index}`, 'y'.repeat(60_000))
      ids.push(id)
    }
    const { items } = await fetchSearchDocuments(db, MINE, ids)
    const total = items.reduce((sum, item) => sum + item.content.length, 0)
    expect(items.length).toBeGreaterThan(0)
    expect(items.length).toBeLessThan(ids.length)
    expect(total).toBeLessThanOrEqual(400_000 + LIMITS.omnisearchDocumentChars)
  })

  it('returns nothing when no id was asked for', async () => {
    expect((await fetchSearchDocuments(db, MINE, [])).items).toEqual([])
  })

  it('does not let a repeated id double the page', async () => {
    const { items } = await fetchSearchDocuments(db, MINE, ['a'.repeat(26), 'a'.repeat(26)])
    expect(items).toHaveLength(1)
  })

  it('counts characters, not bytes, when it truncates', async () => {
    const id = 'n'.repeat(26)
    const tea = String.fromCharCode(0x8336)
    note(id, MINE, 'Han', tea.repeat(LIMITS.omnisearchDocumentChars + 10))
    const { items } = await fetchSearchDocuments(db, MINE, [id])
    expect([...items[0]!.content].length).toBe(LIMITS.omnisearchDocumentChars)
    expect(items[0]!.chars).toBe(LIMITS.omnisearchDocumentChars + 10)
  })
})

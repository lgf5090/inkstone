// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { queryMcpNoteProperties } from '../src/worker/mcp/library'
import { indexNoteProperties } from '../src/shared/note-properties'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'
const FOREIGN = 'user-b'
const noteId = (index: number) => String(index).padStart(26, '0')

let sqlite: DatabaseSync
let db: D1Database

function frontMatter(yaml: string, body = 'Body'): string {
  return `---\n${yaml}\n---\n${body}`
}

function seedNote(
  id: string,
  content: string,
  updatedAt: number,
  options: { userId?: string, deletedAt?: number } = {},
): void {
  sqlite.prepare(`INSERT INTO notes
    (id, user_id, title, content, excerpt, rev, word_count, char_count, is_encrypted,
     position, content_hash, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, '', 1, 1, 1, 0, 0, '', ?, ?, ?)`)
    .run(id, options.userId ?? USER, `Note ${id}`, content, updatedAt, updatedAt, options.deletedAt ?? null)
}

function indexProperties(id: string, content: string, userId = USER): void {
  const insert = sqlite.prepare(`INSERT INTO note_properties
    (user_id, note_id, key, key_key, ordinal, kind, is_array, value_text, value_number, value_boolean, value_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const row of indexNoteProperties(content)) {
    insert.run(userId, id, row.key, row.keyKey, row.ordinal, row.kind, Number(row.array),
      row.text, row.number, row.boolean, row.date)
  }
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
})

afterEach(() => {
  vi.restoreAllMocks()
  sqlite.close()
})

describe('MCP note property scan', () => {
  it('bounds candidate body work for a rare key across 10k notes', async () => {
    sqlite.exec('BEGIN')
    for (let index = 0; index < 10_000; index++) {
      const id = noteId(index)
      const content = frontMatter('common: value', `${index}:${'x'.repeat(1_024)}`)
      seedNote(id, content, index)
      indexProperties(id, content)
    }
    const rareId = noteId(10_000)
    const rareContent = frontMatter('rare_key: needle', `needle:${'z'.repeat(70_000)}`)
    seedNote(rareId, rareContent, 10_000)
    indexProperties(rareId, rareContent)
    sqlite.exec('COMMIT')

    const result = await queryMcpNoteProperties(db, USER, {
      conditions: [{ key: 'rare_key', operator: 'equals', value: 'needle' }],
      limit: 20,
    })

    expect(result.results.map((note) => note.id)).toEqual([rareId])
    expect(result.results[0]?.properties).toEqual({ rare_key: 'needle' })
    expect(result.scanned).toBe(1)
    expect(result.scan_limit).toBe(500)
  })

  it('uses the property lookup index for every requested key after materializing the window', async () => {
    const id = noteId(1)
    const content = frontMatter('rare_key: needle\ncommon: value')
    seedNote(id, content, 1)
    indexProperties(id, content)

    const prepare = vi.spyOn(db, 'prepare')
    const result = await queryMcpNoteProperties(db, USER, {
      conditions: [
        { key: 'rare_key', operator: 'exists' },
        { key: 'common', operator: 'exists' },
      ],
    })
    expect(result.results.map((note) => note.id)).toEqual([id])

    const query = prepare.mock.calls.find(([sql]) => String(sql).includes('WITH candidates AS MATERIALIZED'))?.[0]
    expect(query).toBeTypeOf('string')
    const sql = String(query)
    expect(sql.match(/EXISTS \(/g)).toHaveLength(2)
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(USER, 'rare_key', 'common')
      .map((row) => String(row.detail))
      .join('\n')
    expect(plan).toContain('MATERIALIZE candidates')
    expect(plan.match(/idx_note_properties_lookup/g), plan).toHaveLength(2)
    expect(plan).not.toMatch(/SCAN property\b/)
  })

  it('keeps exact key case and scalar, null, empty, array and object matching in propertyMatches', async () => {
    const id = noteId(2)
    const content = frontMatter(`Status: Active
text: Alpha
empty: ''
nothing: null
count: 42
enabled: true
tags: [Alpha, 2, false, {label: Beta}]
settings:
  nested: value`)
    seedNote(id, content, 2)
    indexProperties(id, content)

    const wrongCase = await queryMcpNoteProperties(db, USER, {
      conditions: [{ key: 'status', operator: 'exists' }],
    })
    expect(wrongCase.results).toEqual([])
    expect(wrongCase.scanned).toBe(1)

    const typed = await queryMcpNoteProperties(db, USER, {
      conditions: [
        { key: 'Status', operator: 'equals', value: 'Active' },
        { key: 'empty', operator: 'equals', value: '' },
        { key: 'nothing', operator: 'equals', value: null },
        { key: 'count', operator: 'equals', value: 42 },
        { key: 'enabled', operator: 'equals', value: true },
        { key: 'tags', operator: 'equals', value: ['Alpha', 2, false, { label: 'Beta' }] },
        { key: 'settings', operator: 'equals', value: { nested: 'value' } },
      ],
    })
    expect(typed.results.map((note) => note.id)).toEqual([id])
    expect(typed.results[0]?.properties).toEqual({
      Status: 'Active',
      text: 'Alpha',
      empty: '',
      nothing: null,
      count: 42,
      enabled: true,
      tags: ['Alpha', 2, false, { label: 'Beta' }],
      settings: { nested: 'value' },
    })

    const cases: Array<{ condition: { key: string, operator: 'exists' | 'equals' | 'contains', value?: unknown }, matches: boolean }> = [
      { condition: { key: 'Status', operator: 'exists' }, matches: true },
      { condition: { key: 'Status', operator: 'equals', value: 'active' }, matches: false },
      { condition: { key: 'empty', operator: 'equals', value: null }, matches: false },
      { condition: { key: 'empty', operator: 'contains', value: '' }, matches: true },
      { condition: { key: 'nothing', operator: 'equals', value: '' }, matches: false },
      { condition: { key: 'nothing', operator: 'contains', value: 'NULL' }, matches: true },
      { condition: { key: 'count', operator: 'equals', value: '42' }, matches: false },
      { condition: { key: 'count', operator: 'contains', value: '2' }, matches: true },
      { condition: { key: 'enabled', operator: 'equals', value: 1 }, matches: false },
      { condition: { key: 'enabled', operator: 'contains', value: 'RU' }, matches: true },
      { condition: { key: 'text', operator: 'contains', value: 'ALPHA' }, matches: true },
      { condition: { key: 'tags', operator: 'contains', value: 'Alpha' }, matches: true },
      { condition: { key: 'tags', operator: 'contains', value: 'alpha' }, matches: false },
      { condition: { key: 'tags', operator: 'contains', value: 2 }, matches: true },
      { condition: { key: 'tags', operator: 'contains', value: false }, matches: true },
      { condition: { key: 'tags', operator: 'contains', value: { label: 'Beta' } }, matches: true },
      { condition: { key: 'tags', operator: 'contains', value: 'Bet' }, matches: false },
      { condition: { key: 'settings', operator: 'equals', value: { nested: 'other' } }, matches: false },
      { condition: { key: 'settings', operator: 'contains', value: 'OBJECT' }, matches: true },
    ]
    for (const { condition, matches } of cases) {
      const result = await queryMcpNoteProperties(db, USER, { conditions: [condition] })
      expect(result.results.map((note) => note.id), JSON.stringify(condition)).toEqual(matches ? [id] : [])
    }
  })

  it('keeps the original newest-500 Front Matter window and descending order', async () => {
    sqlite.exec('BEGIN')
    seedNote(noteId(0), frontMatter('old_only: yes'), 0)
    indexProperties(noteId(0), frontMatter('old_only: yes'))
    for (let index = 1; index <= 500; index++) {
      const id = noteId(index)
      const content = frontMatter('window: yes')
      seedNote(id, content, index)
      indexProperties(id, content)
    }
    for (let index = 501; index <= 510; index++) {
      seedNote(noteId(index), `Plain body ${index}\n---\nwindow: yes\n---`, index)
    }
    const deletedId = noteId(511)
    const deletedContent = frontMatter('window: yes')
    seedNote(deletedId, deletedContent, 511, { deletedAt: 511 })
    indexProperties(deletedId, deletedContent)
    const foreignId = noteId(512)
    const foreignContent = frontMatter('window: yes')
    seedNote(foreignId, foreignContent, 512, { userId: FOREIGN })
    indexProperties(foreignId, foreignContent, FOREIGN)
    sqlite.exec('COMMIT')

    const ordered = await queryMcpNoteProperties(db, USER, {
      conditions: [{ key: 'window', operator: 'exists' }],
      limit: 50,
    })
    expect(ordered.results.map((note) => note.id)).toEqual(
      Array.from({ length: 50 }, (_, index) => noteId(500 - index)),
    )
    expect(ordered.scanned).toBe(500)
    expect(ordered.scan_limit).toBe(500)

    const outsideWindow = await queryMcpNoteProperties(db, USER, {
      conditions: [{ key: 'old_only', operator: 'exists' }],
    })
    expect(outsideWindow.results).toEqual([])
    expect(outsideWindow.scanned).toBe(0)
  })
})

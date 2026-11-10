// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_MIGRATIONS, SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { ProjectViewTypeSchema } from '../src/shared/project/validation'
import {
  PROJECT_AUX_SCHEMA_STATEMENTS,
  PROJECT_CONTENT_SCHEMA_STATEMENTS,
  PROJECT_CORE_SCHEMA_STATEMENTS,
  PROJECT_ENHANCE_SCHEMA_STATEMENTS,
  PROJECT_FTS_SCHEMA_STATEMENTS,
  PROJECT_REQUIRED_COLUMNS,
  PROJECT_REQUIRED_INDEXES,
  PROJECT_REQUIRED_TABLES,
} from '../src/worker/project/schema'

const PROJECT_STATEMENTS = [
  ...PROJECT_CORE_SCHEMA_STATEMENTS,
  ...PROJECT_CONTENT_SCHEMA_STATEMENTS,
  ...PROJECT_AUX_SCHEMA_STATEMENTS,
  ...PROJECT_ENHANCE_SCHEMA_STATEMENTS,
  ...PROJECT_FTS_SCHEMA_STATEMENTS,
]

let sqlite: DatabaseSync

function applySchema(): void {
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
}

function names(type: string): Set<string> {
  const rows = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = ?`).all(type) as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function columns(table: string): string[] {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.map((row) => row.name)
}

function primaryKey(table: string): string[] {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>
  return rows.filter((row) => row.pk > 0).sort((left, right) => left.pk - right.pk).map((row) => row.name)
}

function insertBoard(id: string, overrides: Record<string, string | number> = {}): void {
  const row: Record<string, string | number> = {
    id, owner_id: 'u1', created_by: 'u1', modified_by: 'u1', create_at: 1, update_at: 1, ...overrides,
  }
  const keys = Object.keys(row)
  sqlite.prepare(
    `INSERT INTO project_boards (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
  ).run(...keys.map((key) => row[key]))
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  applySchema()
})

describe('the project tables', () => {
  it('are wired into the schema every boot runs', () => {
    for (const statement of PROJECT_STATEMENTS) {
      expect(SCHEMA_STATEMENTS.includes(statement)).toBe(true)
    }
  })

  it('create every declared table, index and column', () => {
    const presentTables = names('table')
    for (const table of PROJECT_REQUIRED_TABLES) expect(presentTables.has(table)).toBe(true)
    const presentIndexes = names('index')
    for (const index of PROJECT_REQUIRED_INDEXES) expect(presentIndexes.has(index)).toBe(true)
    for (const [table, declared] of Object.entries(PROJECT_REQUIRED_COLUMNS)) {
      expect(columns(table).sort()).toEqual([...declared].sort())
    }
  })

  it('apply a second time without changing anything', () => {
    const before = columns('project_cards')
    sqlite.exec(PROJECT_STATEMENTS.join(';'))
    expect(columns('project_cards')).toEqual(before)
    expect(names('table').has('project_boards')).toBe(true)
  })

  it('reach the same shape by migration as by a fresh boot', () => {
    const migrated = new DatabaseSync(':memory:')
    migrated.exec(SCHEMA_STATEMENTS.filter((statement) => !PROJECT_STATEMENTS.includes(statement)).join(';'))
    expect(migrated.prepare(`SELECT name FROM sqlite_master WHERE name = 'project_boards'`).get()).toBeUndefined()
    const versions = SCHEMA_MIGRATIONS.filter((entry) => entry.version >= 287 && entry.version <= 291)
    expect(versions.map((entry) => entry.version)).toEqual([287, 288, 289, 290, 291])
    for (const entry of versions) migrated.exec(entry.statements.join(';'))

    const shape = (db: DatabaseSync): string[] =>
      (db.prepare(`SELECT name, sql FROM sqlite_master WHERE name LIKE 'project_%' ORDER BY name`).all() as Array<{ name: string; sql: string | null }>)
        .map((row) => `${row.name}: ${row.sql}`)
    expect(shape(migrated)).toEqual(shape(sqlite))
    expect(shape(migrated).length).toBeGreaterThan(PROJECT_REQUIRED_TABLES.length)
  })

  it('key each row the way a board-scoped lookup reads it', () => {
    expect(primaryKey('project_boards')).toEqual(['id'])
    expect(primaryKey('project_board_members')).toEqual(['board_id', 'user_id'])
    expect(primaryKey('project_properties')).toEqual(['board_id', 'id'])
    expect(primaryKey('project_card_values')).toEqual(['card_id', 'property_id'])
    expect(primaryKey('project_categories')).toEqual(['user_id', 'id'])
    expect(primaryKey('project_category_boards')).toEqual(['user_id', 'category_id', 'board_id'])
    expect(primaryKey('project_subscriptions')).toEqual(['block_id', 'subscriber_id'])
    expect(primaryKey('project_settings')).toEqual(['user_id', 'key'])
    expect(primaryKey('project_activity')).toEqual(['board_id', 'id'])
    expect(primaryKey('project_card_links')).toEqual(['from_card_id', 'to_card_id', 'kind'])
    expect(primaryKey('project_todo_links')).toEqual(['card_id', 'todo_id'])
    expect(primaryKey('project_fts_queue')).toEqual(['user_id', 'card_id'])
  })

  it('start a board private, undeleted and empty without being told', () => {
    insertBoard('b1')
    const row = sqlite.prepare(`SELECT * FROM project_boards WHERE id = 'b1'`).get() as Record<string, unknown>
    expect(row.type).toBe('P')
    expect(row.minimum_role).toBe('')
    expect(row.title).toBe('')
    expect(row.show_description).toBe(0)
    expect(row.is_template).toBe(0)
    expect(row.delete_at).toBe(0)
  })

  it('carry the card content order, which a per-row position cannot express', () => {
    sqlite.prepare(
      `INSERT INTO project_cards (id, board_id, created_by, modified_by, create_at, update_at)
       VALUES ('c1', 'b1', 'u1', 'u1', 1, 1)`,
    ).run()
    const row = sqlite.prepare(`SELECT content_order FROM project_cards WHERE id = 'c1'`).get() as { content_order: string }
    expect(JSON.parse(row.content_order)).toEqual([])
    const order = ['a1', ['a2', 'a3'], 'a4']
    sqlite.prepare(`UPDATE project_cards SET content_order = ? WHERE id = 'c1'`).run(JSON.stringify(order))
    const read = sqlite.prepare(`SELECT content_order FROM project_cards WHERE id = 'c1'`).get() as { content_order: string }
    expect(JSON.parse(read.content_order)).toEqual(order)
  })

  it('refuse the enum values the vocabulary does not have', () => {
    expect(() => insertBoard('b1', { type: 'X' })).toThrow()
    expect(() => insertBoard('b2', { minimum_role: 'owner' })).toThrow()
    expect(() => sqlite.prepare(
      `INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at)
       VALUES ('b1', 'u2', 'owner', 1, 1)`,
    ).run()).toThrow()
    // view_type is no longer CHECKed in SQL: the list lives in PROJECT_VIEW_TYPES and
    // ProjectViewTypeSchema refuses an unknown value at the API boundary, which is the one place
    // that can grow without rebuilding the table. The boundary is asserted just below.
    expect(ProjectViewTypeSchema.safeParse('spreadsheet').success).toBe(false)
    expect(ProjectViewTypeSchema.safeParse('dashboard').success).toBe(true)
    expect(() => sqlite.prepare(
      `INSERT INTO project_card_contents (id, card_id, board_id, type, created_by, modified_by, create_at, update_at)
       VALUES ('a1', 'c1', 'b1', 'video', 'u1', 'u1', 1, 1)`,
    ).run()).toThrow()
    expect(() => sqlite.prepare(
      `INSERT INTO project_card_links (from_card_id, to_card_id, kind, board_id, created_at)
       VALUES ('c1', 'c2', 'duplicates', 'b1', 1)`,
    ).run()).toThrow()
    expect(() => sqlite.prepare(
      `INSERT INTO project_fts_queue (user_id, card_id, kind, created_at) VALUES ('u1', 'c1', 'reindex', 1)`,
    ).run()).toThrow()
  })

  it('accept every view type the app offers, including the four beyond the reference', () => {
    const types = ['board', 'table', 'gallery', 'calendar', 'list', 'timeline', 'gantt', 'chart']
    for (const [index, type] of types.entries()) {
      sqlite.prepare(
        `INSERT INTO project_views (id, board_id, view_type, created_by, modified_by, create_at, update_at)
         VALUES (?, 'b1', ?, 'u1', 'u1', 1, 1)`,
      ).run(`v${index}`, type)
    }
    const rows = sqlite.prepare(`SELECT view_type FROM project_views ORDER BY id`).all() as Array<{ view_type: string }>
    expect(rows.map((row) => row.view_type)).toEqual(types)
  })

  it('keep one share per board and one card per todo', () => {
    const share = `INSERT INTO project_shares (slug, board_id, user_id, created_at) VALUES (?, ?, 'u1', 1)`
    sqlite.prepare(share).run('slug-one', 'b1')
    expect(() => sqlite.prepare(share).run('slug-two', 'b1')).toThrow()
    sqlite.prepare(share).run('slug-three', 'b2')

    const link = `INSERT INTO project_todo_links (card_id, todo_id, user_id, created_at) VALUES (?, ?, 'u1', 1)`
    sqlite.prepare(link).run('c1', 't1')
    expect(() => sqlite.prepare(link).run('c2', 't1')).toThrow()
    sqlite.prepare(link).run('c1', 't2')
  })

  it('index a card body and find it again by a word inside it', () => {
    sqlite.prepare(
      `INSERT INTO project_fts (board_id, card_id, user_id, title, body) VALUES (?, ?, ?, ?, ?)`,
    ).run('b1', 'c1', 'u1', 'Roadmap', 'ship the exporter')
    const rows = sqlite.prepare(
      `SELECT card_id FROM project_fts WHERE project_fts MATCH ? AND user_id = ?`,
    ).all('exporter', 'u1') as Array<{ card_id: string }>
    expect(rows.map((row) => row.card_id)).toEqual(['c1'])
  })
})
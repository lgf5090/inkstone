// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectCard } from '../src/shared/project/model'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const ACCOUNTS = ['alice', 'bob'] as const
type Account = (typeof ACCOUNTS)[number]

const app = createApp()
const tokens = new Map<Account, string>()
let sqlite: DatabaseSync
let env: Env

const id = (prefix: string): string => prefix + 'a'.repeat(26)

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite))
  await app.fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  for (const account of ACCOUNTS) {
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at)
       VALUES (?, ?, 'hash', ?, ?, 'member', ?, ?)`,
    ).run(account, account, account, account, now, now)
    tokens.set(account, await createSession(env.DB, account))
  }
})

beforeEach(() => {
  sqlite.exec(`DELETE FROM project_properties; DELETE FROM project_board_members; DELETE FROM project_boards;
    DELETE FROM project_cards; DELETE FROM project_card_values; DELETE FROM project_views;
    DELETE FROM project_card_contents; DELETE FROM project_comments`)
})

async function req(account: Account, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${tokens.get(account)}` }
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
}

async function createBoard(account: Account, title: string, cardProperties: unknown[] = []): Promise<ProjectBoard> {
  const response = await req(account, 'POST', '/boards', { title, cardProperties })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { board: ProjectBoard }).board
}

function seedCard(boardId: string, cardId: string, overrides: Record<string, unknown> = {}): void {
  const row = { title: `Card ${cardId}`, icon: '', parent_id: '', is_template: 0, content_order: '[]', created_by: 'alice', modified_by: 'alice', create_at: 10, update_at: 10, delete_at: 0, ...overrides }
  sqlite.prepare(
    `INSERT INTO project_cards (id, board_id, parent_id, title, icon, is_template, content_order, created_by, modified_by, create_at, update_at, delete_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(cardId, boardId, row.parent_id, row.title, row.icon, row.is_template, row.content_order, row.created_by, row.modified_by, row.create_at, row.update_at, row.delete_at)
}

function seedValue(cardId: string, propertyId: string, value: string): void {
  sqlite.prepare('INSERT INTO project_card_values (card_id, property_id, value, updated_at) VALUES (?, ?, ?, 1)').run(cardId, propertyId, value)
}

function valuesOf(cardId: string): Record<string, string> {
  const rows = sqlite.prepare('SELECT property_id, value FROM project_card_values WHERE card_id = ?').all(cardId) as { property_id: string, value: string }[]
  return Object.fromEntries(rows.map((row) => [row.property_id, row.value]))
}

describe('moving a card to another board', () => {
  it('remaps select and multi-select values onto the target board\'s matching properties', async () => {
    const source = await createBoard('alice', 'Source', [
      { id: id('p'), name: 'Status', type: 'select', options: [{ id: id('o'), value: 'Open', color: '' }] },
      { id: id('q'), name: 'Tags', type: 'multiSelect', options: [{ id: id('r'), value: 'x', color: '' }] },
    ])
    const target = await createBoard('alice', 'Target', [
      { id: id('s'), name: 'Status', type: 'select', options: [{ id: id('t'), value: 'Open', color: '' }] },
      { id: id('u'), name: 'Tags', type: 'multiSelect', options: [{ id: id('v'), value: 'x', color: '' }] },
    ])
    seedCard(source.id, id('c'))
    seedValue(id('c'), id('p'), id('o'))
    seedValue(id('c'), id('q'), JSON.stringify([id('r')]))
    const response = await req('alice', 'POST', `/cards/${id('c')}/move`, { targetBoardId: target.id })
    expect(response.status, await response.clone().text()).toBe(200)
    const { card } = (await response.json()) as { card: ProjectCard }
    expect(card.boardId).toBe(target.id)
    expect(valuesOf(id('c'))).toEqual({ [id('s')]: id('t'), [id('u')]: JSON.stringify([id('v')]) })
  })

  it('creates a property the target lacks and keeps the value', async () => {
    const source = await createBoard('alice', 'Source', [{ id: id('p'), name: 'Hours', type: 'number', options: [] }])
    const target = await createBoard('alice', 'Target', [])
    seedCard(source.id, id('c'))
    seedValue(id('c'), id('p'), '3.5')
    const response = await req('alice', 'POST', `/cards/${id('c')}/move`, { targetBoardId: target.id })
    expect(response.status, await response.clone().text()).toBe(200)
    const properties = sqlite.prepare('SELECT id, name, type FROM project_properties WHERE board_id = ?').all(target.id) as { id: string, name: string, type: string }[]
    expect(properties).toHaveLength(1)
    expect(properties[0]).toMatchObject({ name: 'Hours', type: 'number' })
    expect(valuesOf(id('c'))).toEqual({ [properties[0]!.id]: '3.5' })
  })

  it('carries subtasks, contents and comments, and detaches the moved root from a parent left behind', async () => {
    const source = await createBoard('alice', 'Source', [])
    const target = await createBoard('alice', 'Target', [])
    seedCard(source.id, id('c'), { parent_id: id('d') })
    seedCard(source.id, id('d'))
    seedCard(source.id, id('e'), { parent_id: id('c') })
    sqlite.prepare(`INSERT INTO project_card_contents (id, card_id, board_id, type, title, fields, position, created_by, modified_by, create_at, update_at, delete_at)
      VALUES (?, ?, ?, 'text', 'Body', '{}', 0, 'alice', 'alice', 1, 1, 0)`).run(id('f'), id('c'), source.id)
    sqlite.prepare(`INSERT INTO project_comments (id, card_id, board_id, author_id, body, create_at, update_at, delete_at)
      VALUES (?, ?, ?, 'alice', 'hi', 1, 1, 0)`).run(id('g'), id('c'), source.id)
    const response = await req('alice', 'POST', `/cards/${id('c')}/move`, { targetBoardId: target.id })
    expect(response.status, await response.clone().text()).toBe(200)
    const moved = sqlite.prepare('SELECT id, board_id, parent_id FROM project_cards WHERE id IN (?, ?)').all(id('c'), id('e')) as { id: string, board_id: string, parent_id: string }[]
    expect(moved.every((row) => row.board_id === target.id)).toBe(true)
    expect(moved.find((row) => row.id === id('c'))!.parent_id).toBe('')
    expect(moved.find((row) => row.id === id('e'))!.parent_id).toBe(id('c'))
    expect((sqlite.prepare('SELECT board_id FROM project_cards WHERE id = ?').get(id('d')) as { board_id: string }).board_id).toBe(source.id)
    expect((sqlite.prepare('SELECT board_id FROM project_card_contents WHERE id = ?').get(id('f')) as { board_id: string }).board_id).toBe(target.id)
    expect((sqlite.prepare('SELECT board_id FROM project_comments WHERE id = ?').get(id('g')) as { board_id: string }).board_id).toBe(target.id)
  })

  it('refuses a target the reader cannot edit, and a move onto the same board', async () => {
    const source = await createBoard('alice', 'Source', [])
    const target = await createBoard('bob', 'Target', [])
    seedCard(source.id, id('c'))
    expect((await req('alice', 'POST', `/cards/${id('c')}/move`, { targetBoardId: target.id })).status).toBe(404)
    expect((await req('alice', 'POST', `/cards/${id('c')}/move`, { targetBoardId: source.id })).status).toBe(400)
  })

  it('does not reuse a same-named property of a different type', async () => {
    const source = await createBoard('alice', 'Source', [{ id: id('p'), name: 'Hours', type: 'number', options: [] }])
    const target = await createBoard('alice', 'Target', [{ id: id('s'), name: 'Hours', type: 'text', options: [] }])
    seedCard(source.id, id('c'))
    seedValue(id('c'), id('p'), '3.5')
    const response = await req('alice', 'POST', `/cards/${id('c')}/move`, { targetBoardId: target.id })
    expect(response.status, await response.clone().text()).toBe(200)
    const properties = sqlite.prepare('SELECT id, type FROM project_properties WHERE board_id = ? ORDER BY position').all(target.id) as { id: string, type: string }[]
    expect(properties.map((property) => property.type)).toEqual(['text', 'number'])
    expect(valuesOf(id('c'))).toEqual({ [properties[1]!.id]: '3.5' })
  })
})
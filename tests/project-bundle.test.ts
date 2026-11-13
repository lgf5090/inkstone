// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectBoardBundle } from '../src/shared/project/model'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const ACCOUNTS = ['alice', 'bob', 'carol'] as const
type Account = (typeof ACCOUNTS)[number]

const app = createApp()
const tokens = new Map<Account, string>()
let sqlite: DatabaseSync
let env: Env

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

async function req(account: Account | null, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {}
  if (account) headers.Cookie = `${LEGACY_SESSION_COOKIE}=${tokens.get(account)}`
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(
    new Request(`http://localhost/api/project${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  )
}

async function createBoard(account: Account, body: Record<string, unknown> = {}): Promise<ProjectBoard> {
  const response = await req(account, 'POST', '/boards', body)
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { board: ProjectBoard }).board
}

async function bundle(account: Account, boardId: string): Promise<ProjectBoardBundle> {
  const response = await req(account, 'GET', `/boards/${boardId}/bundle`)
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json()) as ProjectBoardBundle
}

function addMember(boardId: string, account: Account, role: string): void {
  sqlite.prepare(
    'INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
  ).run(boardId, account, role)
}

function seedCard(boardId: string, id: string, overrides: Record<string, unknown> = {}): void {
  const row = {
    title: `Card ${id}`, icon: '', parent_id: '', is_template: 0, content_order: '[]',
    created_by: 'alice', modified_by: 'alice', create_at: 10, update_at: 10, delete_at: 0,
    ...overrides,
  }
  sqlite.prepare(
    `INSERT INTO project_cards (id, board_id, parent_id, title, icon, is_template, content_order,
       created_by, modified_by, create_at, update_at, delete_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, boardId, row.parent_id, row.title, row.icon, row.is_template, row.content_order,
    row.created_by, row.modified_by, row.create_at, row.update_at, row.delete_at,
  )
}

describe('reading a whole board', () => {
  it('returns an empty board with its properties, owner member and role', async () => {
    const board = await createBoard('alice', { title: 'Empty' })
    const result = await bundle('alice', board.id)
    expect(result.board.id).toBe(board.id)
    expect(result.role).toBe('admin')
    expect(result.cards).toEqual([])
    expect(result.views).toEqual([])
    expect(result.contents).toEqual([])
    expect(result.comments).toEqual([])
    expect(result.members.map((m) => m.userId)).toEqual(['alice'])
    expect(result.cursor).toBe(board.updateAt)
  })

  it('names everyone the board refers to, including an assignee who is not a member', async () => {
    const person = `p${'a'.repeat(26)}`
    const many = `q${'b'.repeat(26)}`
    const board = await createBoard('alice', {
      cardProperties: [
        { id: person, name: 'Assignee', type: 'person', options: [] },
        { id: many, name: 'Watchers', type: 'multiPerson', options: [] },
      ],
    })
    seedCard(board.id, 'c1', {})
    sqlite.prepare('INSERT INTO project_card_values (card_id, property_id, value, updated_at) VALUES (?, ?, ?, 1)').run('c1', person, 'carol')
    sqlite.prepare('INSERT INTO project_card_values (card_id, property_id, value, updated_at) VALUES (?, ?, ?, 1)').run('c1', many, '["bob"]')
    sqlite.prepare("UPDATE users SET name = 'Bobby' WHERE id = 'bob'").run()
    const result = await bundle('alice', board.id)
    expect(result.members.map((m) => m.userId)).toEqual(['alice'])
    expect(result.people.alice).toEqual({ id: 'alice', name: 'alice', avatarUrl: '' })
    expect(result.people.bob).toEqual({ id: 'bob', name: 'Bobby', avatarUrl: '' })
    expect(result.people.carol).toEqual({ id: 'carol', name: 'carol', avatarUrl: '' })
  })

  it('maps cards with their values, views, contents and comments, and takes the newest stamp as cursor', async () => {
    const board = await createBoard('alice', {})
    sqlite.prepare('UPDATE project_boards SET update_at = 5 WHERE id = ?').run(board.id)
    sqlite.prepare('UPDATE project_board_members SET updated_at = 5 WHERE board_id = ?').run(board.id)
    seedCard(board.id, 'c1', { title: 'First', icon: '🎯', content_order: '["a1",["a2"]]', update_at: 50 })
    seedCard(board.id, 'c2', { title: 'Second', update_at: 30 })
    for (const id of ['p1', 'p2']) {
      sqlite.prepare(
        `INSERT INTO project_properties (board_id, id, name, type, options, position, created_at, updated_at)
         VALUES (?, ?, ?, 'text', '[]', 0, 1, 1)`,
      ).run(board.id, id, id)
    }
    sqlite.prepare('INSERT INTO project_card_values (card_id, property_id, value, updated_at) VALUES (?, ?, ?, 1)')
      .run('c1', 'p1', 'hello')
    sqlite.prepare('INSERT INTO project_card_values (card_id, property_id, value, updated_at) VALUES (?, ?, ?, 1)')
      .run('c1', 'p2', '["x","y"]')
    sqlite.prepare(
      `INSERT INTO project_views (id, board_id, title, view_type, fields, position, created_by, modified_by, create_at, update_at)
       VALUES ('v1', ?, 'Table', 'table', '{"cardOrder":["c2","c1"]}', 2, 'alice', 'alice', 1, 90)`,
    ).run(board.id)
    sqlite.prepare(
      `INSERT INTO project_card_contents (id, card_id, board_id, type, title, fields, position, created_by, modified_by, create_at, update_at)
       VALUES ('a1', 'c1', ?, 'text', 'Body', '{"language":"md"}', 1, 'alice', 'alice', 1, 70)`,
    ).run(board.id)
    sqlite.prepare(
      `INSERT INTO project_comments (id, card_id, board_id, author_id, body, create_at, update_at)
       VALUES ('m1', 'c1', ?, 'bob', 'Nice', 5, 80)`,
    ).run(board.id)

    const result = await bundle('alice', board.id)
    expect(result.cards.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(result.cards[0]).toMatchObject({
      title: 'First', icon: '🎯', contentOrder: ['a1', ['a2']],
      values: { p1: 'hello', p2: '["x","y"]' }, isTemplate: false,
    })
    expect(result.cards[1]!.values).toEqual({})
    expect(result.views[0]).toMatchObject({ id: 'v1', viewType: 'table', fields: { cardOrder: ['c2', 'c1'] } })
    expect(result.contents[0]).toMatchObject({ id: 'a1', cardId: 'c1', type: 'text', fields: { language: 'md' } })
    expect(result.comments[0]).toMatchObject({ id: 'm1', authorId: 'bob', body: 'Nice' })
    expect(result.cursor).toBe(90)
  })
})

describe('bounded detail rows', () => {
  it('caps the board read and lets a card fetch its full body', async () => {
    const board = await createBoard('alice', {})
    const created = await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'Heavy' })
    const card = ((await created.json()) as { card: { id: string } }).card
    const insert = sqlite.prepare(
      `INSERT INTO project_card_contents (id, card_id, board_id, type, title, fields, position, created_by, modified_by, create_at, update_at)
       VALUES (?, ?, ?, 'text', 'body', '{}', ?, 'alice', 'alice', 1, 1)`,
    )
    sqlite.exec('BEGIN')
    for (let index = 0; index <= 2000; index += 1) {
      insert.run(`a${String(index).padStart(26, '0')}`, card.id, board.id, index)
    }
    sqlite.exec('COMMIT')
    const read = await bundle('alice', board.id)
    expect(read.contents).toHaveLength(2000)
    expect(read.contentsTruncated).toBe(true)
    const detail = await req('alice', 'GET', `/cards/${card.id}/detail`)
    expect(detail.status).toBe(200)
    expect(((await detail.json()) as { contents: unknown[] }).contents).toHaveLength(2001)
  })
})

describe('the staleness cursor', () => {
  it('advances after a child write, including a delete', async () => {
    const board = await createBoard('alice', {})
    const created = await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'C' })
    expect(created.status, await created.clone().text()).toBe(201)
    const card = ((await created.json()) as { card: { id: string } }).card
    const first = await req('alice', 'GET', `/boards/${board.id}/cursor`)
    const before = ((await first.json()) as { cursor: number }).cursor
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect((await req('alice', 'DELETE', `/cards/${card.id}`)).status).toBe(200)
    const second = await req('alice', 'GET', `/boards/${board.id}/cursor`)
    const after = ((await second.json()) as { cursor: number }).cursor
    expect(after).toBeGreaterThan(before)
  })
})

describe('what a bundle leaves out', () => {
  it('drops soft-deleted cards together with their values, and deleted views, contents and comments', async () => {
    const board = await createBoard('alice', {})
    seedCard(board.id, 'live', { update_at: 20 })
    seedCard(board.id, 'gone', { delete_at: 99, update_at: 200 })
    sqlite.prepare('INSERT INTO project_card_values (card_id, property_id, value, updated_at) VALUES (?, ?, ?, 1)')
      .run('gone', 'p1', 'stale')
    sqlite.prepare(
      `INSERT INTO project_views (id, board_id, title, view_type, created_by, modified_by, create_at, update_at, delete_at)
       VALUES ('vg', ?, 'Gone', 'board', 'alice', 'alice', 1, 300, 5)`,
    ).run(board.id)
    sqlite.prepare(
      `INSERT INTO project_card_contents (id, card_id, board_id, type, created_by, modified_by, create_at, update_at, delete_at)
       VALUES ('ag', 'live', ?, 'text', 'alice', 'alice', 1, 400, 5)`,
    ).run(board.id)
    sqlite.prepare(
      `INSERT INTO project_comments (id, card_id, board_id, author_id, body, create_at, update_at, delete_at)
       VALUES ('mg', 'live', ?, 'alice', 'gone', 1, 500, 5)`,
    ).run(board.id)

    const result = await bundle('alice', board.id)
    expect(result.cards.map((c) => c.id)).toEqual(['live'])
    expect(result.cards[0]!.values).toEqual({})
    expect(result.views).toEqual([])
    expect(result.contents).toEqual([])
    expect(result.comments).toEqual([])
    expect(result.cursor).toBe(Math.max(board.updateAt, 20))
  })

  it('drops live contents and comments whose parent card has been soft-deleted', async () => {
    const board = await createBoard('alice', {})
    seedCard(board.id, 'kept')
    seedCard(board.id, 'deleted', { delete_at: 99 })
    sqlite.prepare(
      `INSERT INTO project_card_contents (id, card_id, board_id, type, title, position, created_by, modified_by, create_at, update_at, delete_at)
       VALUES ('orphan-content', 'deleted', ?, 'text', 'still here', 0, 'alice', 'alice', 1, 1, 0)`,
    ).run(board.id)
    sqlite.prepare(
      `INSERT INTO project_comments (id, card_id, board_id, author_id, body, create_at, update_at, delete_at)
       VALUES ('orphan-comment', 'deleted', ?, 'alice', 'still here', 1, 1, 0)`,
    ).run(board.id)
    sqlite.prepare(
      `INSERT INTO project_card_contents (id, card_id, board_id, type, created_by, modified_by, create_at, update_at, delete_at)
       VALUES ('alive-content', 'kept', ?, 'text', 'alice', 'alice', 1, 1, 0)`,
    ).run(board.id)
    const result = await bundle('alice', board.id)
    expect(result.cards.map((card) => card.id)).toEqual(['kept'])
    expect(result.contents.map((content) => content.id)).toEqual(['alive-content'])
    expect(result.comments).toEqual([])
    const csv = await req('alice', 'GET', `/boards/${board.id}/csv`)
    expect(await csv.text()).not.toContain('still here')
  })

  it('orders views and contents by position and comments by creation', async () => {
    const board = await createBoard('alice', {})
    seedCard(board.id, 'c1')
    for (const [id, pos] of [['v2', 1], ['v1', 2]] as const) {
      sqlite.prepare(
        `INSERT INTO project_views (id, board_id, title, view_type, position, created_by, modified_by, create_at, update_at)
         VALUES (?, ?, 'V', 'board', ?, 'alice', 'alice', 1, 1)`,
      ).run(id, board.id, pos)
    }
    for (const [id, pos] of [['a2', 1], ['a1', 2]] as const) {
      sqlite.prepare(
        `INSERT INTO project_card_contents (id, card_id, board_id, type, position, created_by, modified_by, create_at, update_at)
         VALUES (?, 'c1', ?, 'text', ?, 'alice', 'alice', 1, 1)`,
      ).run(id, board.id, pos)
    }
    for (const [id, at] of [['m2', 1], ['m1', 2]] as const) {
      sqlite.prepare(
        `INSERT INTO project_comments (id, card_id, board_id, author_id, body, create_at, update_at)
         VALUES (?, 'c1', ?, 'alice', 'x', ?, 1)`,
      ).run(id, board.id, at)
    }
    const result = await bundle('alice', board.id)
    expect(result.views.map((v) => v.id)).toEqual(['v2', 'v1'])
    expect(result.contents.map((a) => a.id)).toEqual(['a2', 'a1'])
    expect(result.comments.map((m) => m.id)).toEqual(['m2', 'm1'])
  })
})

describe('view visibility', () => {
  it('keeps a role-gated view out of a weaker reader’s bundle', async () => {
    const board = await createBoard('alice', {})
    const created = await req('alice', 'POST', `/boards/${board.id}/views`, { title: 'Admins only', viewType: 'table', fields: { minimumRole: 'admin' } })
    expect(created.status, await created.clone().text()).toBe(201)
    addMember(board.id, 'bob', 'viewer')
    expect((await bundle('alice', board.id)).views.map((view) => view.title)).toEqual(['Admins only'])
    expect((await bundle('bob', board.id)).views).toEqual([])
  })
})

describe('who may read a bundle', () => {
  it('lets a viewer member read, hides a private board from a stranger, and requires sign-in', async () => {
    const board = await createBoard('alice', { title: 'Secret' })
    addMember(board.id, 'bob', 'viewer')
    expect((await bundle('bob', board.id)).role).toBe('viewer')
    expect((await req('carol', 'GET', `/boards/${board.id}/bundle`)).status).toBe(404)
    expect((await req(null, 'GET', `/boards/${board.id}/bundle`)).status).toBe(401)
  })
})
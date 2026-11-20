// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectBoardMetadata, ProjectProperty } from '../src/shared/project/model'
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
  sqlite.exec('DELETE FROM project_properties; DELETE FROM project_board_members; DELETE FROM project_boards')
})

const pid = (n: number) => `p${String(n).padStart(26, '0')}`

function prop(n: number, name = `P${n}`): ProjectProperty {
  return { id: pid(n), name, type: 'text', options: [] }
}

function addMember(boardId: string, account: Account, role: string): void {
  sqlite.prepare(
    'INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
  ).run(boardId, account, role)
}

async function req(account: Account | null, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {}
  if (account) headers.Cookie = `${LEGACY_SESSION_COOKIE}=${tokens.get(account)}`
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(
    new Request(`http://localhost/api/project${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  )
}

async function createBoard(account: Account, body: Record<string, unknown> = {}): Promise<ProjectBoard> {
  const response = await req(account, 'POST', '/boards', body)
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { board: ProjectBoard }).board
}

describe('deleting a property', () => {
  it('takes the card values that belonged to it', async () => {
    const board = await createBoard('alice', { cardProperties: [prop(1)] })
    const created = await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'C', values: { [pid(1)]: 'hello' } })
    expect(created.status, await created.clone().text()).toBe(201)
    const card = ((await created.json()) as { card: { id: string } }).card
    const patched = await req('alice', 'PATCH', `/boards/${board.id}`, { deletedCardProperties: [pid(1)] })
    expect(patched.status).toBe(200)
    const left = sqlite.prepare('SELECT COUNT(*) AS n FROM project_card_values WHERE card_id = ?').get(card.id) as { n: number }
    expect(left.n).toBe(0)
  })
})

describe('creating a board', () => {
  it('makes the creator an admin member and stores properties in order', async () => {
    const board = await createBoard('alice', { title: 'Roadmap', icon: '🗺️', cardProperties: [prop(1), prop(2), prop(3)] })
    expect(board).toMatchObject({ ownerId: 'alice', title: 'Roadmap', icon: '🗺️', type: 'P', deleteAt: 0 })
    const member = sqlite.prepare('SELECT role FROM project_board_members WHERE board_id = ? AND user_id = ?').get(board.id, 'alice') as { role: string }
    expect(member.role).toBe('admin')
    const read = await req('alice', 'GET', `/boards/${board.id}`)
    expect(read.status).toBe(200)
    const { properties, role } = (await read.json()) as { properties: ProjectProperty[]; role: string }
    expect(role).toBe('admin')
    expect(properties.map((p) => p.id)).toEqual([pid(1), pid(2), pid(3)])
  })

  it('applies defaults for an empty body', async () => {
    const board = await createBoard('alice', {})
    expect(board).toMatchObject({ title: '', description: '', icon: '', showDescription: false, isTemplate: false, minimumRole: '' })
  })

  it('rejects an invalid board type and an over-long title with a 400', async () => {
    expect((await req('alice', 'POST', '/boards', { type: 'X' })).status).toBe(400)
    expect((await req('alice', 'POST', '/boards', { title: 'a'.repeat(16384) })).status).toBe(400)
  })

  it('requires sign-in', async () => {
    expect((await req(null, 'POST', '/boards', { title: 'x' })).status).toBe(401)
  })
})

describe('reading a board', () => {
  it('lets a member read and hides a private board from a stranger', async () => {
    const board = await createBoard('alice', { title: 'Secret' })
    addMember(board.id, 'bob', 'viewer')
    expect((await req('bob', 'GET', `/boards/${board.id}`)).status).toBe(200)
    expect((await req('carol', 'GET', `/boards/${board.id}`)).status).toBe(404)
  })
})

describe('patching a board', () => {
  it('lets an editor change the title but not the board type', async () => {
    const board = await createBoard('alice', { title: 'Old' })
    addMember(board.id, 'bob', 'editor')
    const title = await req('bob', 'PATCH', `/boards/${board.id}`, { title: 'New' })
    expect(title.status).toBe(200)
    expect(((await title.json()) as { board: ProjectBoard }).board.title).toBe('New')
    expect((await req('bob', 'PATCH', `/boards/${board.id}`, { type: 'O' })).status).toBe(403)
    expect((await req('bob', 'PATCH', `/boards/${board.id}`, { minimumRole: 'viewer' })).status).toBe(403)
  })

  it('refuses a viewer any patch', async () => {
    const board = await createBoard('alice', {})
    addMember(board.id, 'bob', 'viewer')
    expect((await req('bob', 'PATCH', `/boards/${board.id}`, { title: 'x' })).status).toBe(403)
  })

  it('lets an admin change type and minimum role', async () => {
    const board = await createBoard('alice', {})
    const response = await req('alice', 'PATCH', `/boards/${board.id}`, { type: 'O', minimumRole: 'viewer' })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { board: ProjectBoard }).board).toMatchObject({ type: 'O', minimumRole: 'viewer' })
  })

  it('applies the property ordering rule over HTTP (§6.2)', async () => {
    const board = await createBoard('alice', { cardProperties: [prop(1), prop(2), prop(3)] })
    const first = await req('alice', 'PATCH', `/boards/${board.id}`, {
      updatedCardProperties: [prop(2, 'B-prime'), prop(4)],
      deletedCardProperties: [pid(1)],
    })
    expect(first.status).toBe(200)
    expect(((await first.json()) as { properties: ProjectProperty[] }).properties.map((p) => p.id)).toEqual([pid(2), pid(3), pid(4)])
    const second = await req('alice', 'PATCH', `/boards/${board.id}`, { updatedCardProperties: [prop(3, 'C-prime')] })
    const { properties } = (await second.json()) as { properties: ProjectProperty[] }
    expect(properties.map((p) => p.id)).toEqual([pid(2), pid(3), pid(4)])
    expect(properties[1]!.name).toBe('C-prime')
  })

  it('refuses a viewer patching properties', async () => {
    const board = await createBoard('alice', { cardProperties: [prop(1)] })
    addMember(board.id, 'bob', 'viewer')
    expect((await req('bob', 'PATCH', `/boards/${board.id}`, { deletedCardProperties: [pid(1)] })).status).toBe(403)
  })
})

describe('deleting and restoring a board', () => {
  it('soft-deletes for an admin, hides it from reads and the list, and refuses an editor', async () => {
    const board = await createBoard('alice', { title: 'Doomed' })
    addMember(board.id, 'bob', 'editor')
    expect((await req('bob', 'DELETE', `/boards/${board.id}`)).status).toBe(403)
    expect((await req('alice', 'DELETE', `/boards/${board.id}`)).status).toBe(200)
    const row = sqlite.prepare('SELECT delete_at FROM project_boards WHERE id = ?').get(board.id) as { delete_at: number }
    expect(row.delete_at).toBeGreaterThan(0)
    expect((await req('alice', 'GET', `/boards/${board.id}`)).status).toBe(404)
    const list = (await (await req('alice', 'GET', '/boards')).json()) as { boards: ProjectBoard[] }
    expect(list.boards.map((b) => b.id)).not.toContain(board.id)
  })

  it('restores a soft-deleted board for an admin', async () => {
    const board = await createBoard('alice', { title: 'Back' })
    await req('alice', 'DELETE', `/boards/${board.id}`)
    const response = await req('alice', 'POST', `/boards/${board.id}/undelete`)
    expect(response.status, await response.clone().text()).toBe(200)
    expect(((await response.json()) as { board: ProjectBoard }).board.deleteAt).toBe(0)
    expect((await req('alice', 'GET', `/boards/${board.id}`)).status).toBe(200)
  })

  it('refuses a non-admin undelete', async () => {
    const board = await createBoard('alice', {})
    addMember(board.id, 'bob', 'editor')
    await req('alice', 'DELETE', `/boards/${board.id}`)
    expect((await req('bob', 'POST', `/boards/${board.id}/undelete`)).status).toBe(403)
  })

  it('keeps publishing, archiving, deleting and restoring owner-only even for an admin', async () => {
    const board = await createBoard('alice', {})
    addMember(board.id, 'bob', 'admin')
    expect((await req('bob', 'PATCH', `/boards/${board.id}`, { type: 'O', minimumRole: 'viewer' })).status).toBe(403)
    expect((await req('bob', 'PATCH', `/boards/${board.id}`, { archived: true })).status).toBe(403)
    expect((await req('bob', 'DELETE', `/boards/${board.id}`)).status).toBe(403)
    await req('alice', 'DELETE', `/boards/${board.id}`)
    expect((await req('bob', 'POST', `/boards/${board.id}/undelete`)).status).toBe(403)
  })
})

describe('per-reader card marks', () => {
  it('round-trips stars and pins and keeps them per account', async () => {
    const board = await createBoard('alice', {})
    addMember(board.id, 'bob', 'viewer')
    const c1 = `c${'a'.repeat(26)}`
    const c2 = `c${'b'.repeat(26)}`
    expect((await req('alice', 'PUT', `/boards/${board.id}/card-marks`, { starred: [c1], pinned: [c2] })).status).toBe(200)
    expect(await (await req('alice', 'GET', `/boards/${board.id}/card-marks`)).json()).toEqual({ marks: { starred: [c1], pinned: [c2] } })
    expect(await (await req('bob', 'GET', `/boards/${board.id}/card-marks`)).json()).toEqual({ marks: { starred: [], pinned: [] } })
  })
})

describe('board metadata', () => {
  it('counts cards, properties and views', async () => {
    const board = await createBoard('alice', { cardProperties: [prop(1), prop(2)] })
    sqlite.prepare(
      `INSERT INTO project_cards (id, board_id, title, created_by, modified_by, create_at, update_at) VALUES ('c1', ?, 'Card', 'alice', 'alice', 1, 1)`,
    ).run(board.id)
    sqlite.prepare(
      `INSERT INTO project_views (id, board_id, title, view_type, created_by, modified_by, create_at, update_at) VALUES ('v1', ?, 'View', 'board', 'alice', 'alice', 1, 1)`,
    ).run(board.id)
    const response = await req('alice', 'GET', `/boards/${board.id}/metadata`)
    expect(response.status).toBe(200)
    expect((await response.json()) as ProjectBoardMetadata).toEqual({ cardCount: 1, propertyCount: 2, viewCount: 1 })
  })
})
describe('the board list card count (R4-4)', () => {
  it('counts live cards per board in the list itself, excluding deleted ones', async () => {
    const created = await req('alice', 'POST', '/boards', { title: 'Counted' })
    const board = ((await created.json()) as { board: { id: string } }).board
    const a = ((await (await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'One' })).json()) as { card: { id: string } }).card
    await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'Two' })
    const listed = ((await (await req('alice', 'GET', '/boards')).json()) as { boards: { id: string, cardCount?: number }[] }).boards
    expect(listed.find((entry) => entry.id === board.id)?.cardCount).toBe(2)
    await req('alice', 'DELETE', `/cards/${a.id}`)
    const after = ((await (await req('alice', 'GET', '/boards')).json()) as { boards: { id: string, cardCount?: number }[] }).boards
    expect(after.find((entry) => entry.id === board.id)?.cardCount).toBe(1)
  })
})

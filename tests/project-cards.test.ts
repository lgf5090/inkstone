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
    DELETE FROM project_cards; DELETE FROM project_card_values`)
})

const pid = (n: number) => `p${String(n).padStart(26, '0')}`
const cid = (n: number) => `a${String(n).padStart(26, '0')}`

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

function addMember(boardId: string, account: Account, role: string): void {
  sqlite.prepare(
    'INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
  ).run(boardId, account, role)
}

async function createCard(account: Account, boardId: string, body: Record<string, unknown> = {}): Promise<ProjectCard> {
  const response = await req(account, 'POST', `/boards/${boardId}/cards`, body)
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { card: ProjectCard }).card
}

describe('creating a card', () => {
  it('stores the card and its values for an editor', async () => {
    const board = await createBoard('alice', {})
    addMember(board.id, 'bob', 'editor')
    const card = await createCard('bob', board.id, { title: 'Task', icon: '📌', values: { [pid(1)]: 'hello' } })
    expect(card).toMatchObject({ boardId: board.id, title: 'Task', icon: '📌', createdBy: 'bob', contentOrder: [], values: { [pid(1)]: 'hello' } })
    const stored = sqlite.prepare('SELECT value FROM project_card_values WHERE card_id = ? AND property_id = ?').get(card.id, pid(1)) as { value: string }
    expect(stored.value).toBe('hello')
  })

  it('refuses a viewer, requires sign-in, and rejects a malformed value key', async () => {
    const board = await createBoard('alice', {})
    addMember(board.id, 'bob', 'viewer')
    expect((await req('bob', 'POST', `/boards/${board.id}/cards`, { title: 'x' })).status).toBe(403)
    expect((await req(null, 'POST', `/boards/${board.id}/cards`, { title: 'x' })).status).toBe(401)
    expect((await req('alice', 'POST', `/boards/${board.id}/cards`, { values: { 'not-an-id': 'x' } })).status).toBe(400)
  })

  it('enforces the per-board card ceiling', async () => {
    const board = await createBoard('alice', {})
    const insert = sqlite.prepare(
      `INSERT INTO project_cards (id, board_id, title, created_by, modified_by, create_at, update_at) VALUES (?, ?, 'x', 'alice', 'alice', 1, 1)`,
    )
    for (let i = 0; i < 5000; i += 1) insert.run(`c${String(i).padStart(26, '0')}`, board.id)
    const response = await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'one too many' })
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe('PROJECT_MAX_CARDS_PER_BOARD')
  })
})

describe('reading a card', () => {
  it('lets a viewer member read with its values and hides it from a stranger', async () => {
    const board = await createBoard('alice', {})
    const card = await createCard('alice', board.id, { title: 'Read me', values: { [pid(1)]: 'v' } })
    addMember(board.id, 'bob', 'viewer')
    const response = await req('bob', 'GET', `/cards/${card.id}`)
    expect(response.status).toBe(200)
    expect(((await response.json()) as { card: ProjectCard }).card).toMatchObject({ title: 'Read me', values: { [pid(1)]: 'v' } })
    expect((await req('carol', 'GET', `/cards/${card.id}`)).status).toBe(404)
  })
})

describe('patching a card', () => {
  it('updates fields, upserts a value and deletes another with null', async () => {
    const board = await createBoard('alice', {})
    const card = await createCard('alice', board.id, { title: 'Old', values: { [pid(1)]: 'a', [pid(2)]: 'b' } })
    const response = await req('alice', 'PATCH', `/cards/${card.id}`, {
      title: 'New', icon: '✅', contentOrder: [cid(1), [cid(2)]],
      values: { [pid(1)]: 'a2', [pid(2)]: null, [pid(3)]: 'c' },
    })
    expect(response.status).toBe(200)
    const updated = ((await response.json()) as { card: ProjectCard }).card
    expect(updated).toMatchObject({ title: 'New', icon: '✅', contentOrder: [cid(1), [cid(2)]], values: { [pid(1)]: 'a2', [pid(3)]: 'c' } })
    expect(updated.values[pid(2)]).toBeUndefined()
  })

  it('refuses a viewer any patch', async () => {
    const board = await createBoard('alice', {})
    const card = await createCard('alice', board.id, {})
    addMember(board.id, 'bob', 'viewer')
    expect((await req('bob', 'PATCH', `/cards/${card.id}`, { title: 'x' })).status).toBe(403)
  })
})

describe('deleting and restoring a card', () => {
  it('soft-deletes for an editor, hides it from reads, and restores it with values intact', async () => {
    const board = await createBoard('alice', {})
    addMember(board.id, 'bob', 'editor')
    const card = await createCard('alice', board.id, { title: 'Doomed', values: { [pid(1)]: 'keep' } })
    expect((await req('bob', 'DELETE', `/cards/${card.id}`)).status).toBe(200)
    expect((await req('alice', 'GET', `/cards/${card.id}`)).status).toBe(404)
    const restored = await req('bob', 'POST', `/cards/${card.id}/undelete`)
    expect(restored.status, await restored.clone().text()).toBe(200)
    expect(((await restored.json()) as { card: ProjectCard }).card).toMatchObject({ deleteAt: 0, values: { [pid(1)]: 'keep' } })
    expect((await req('alice', 'GET', `/cards/${card.id}`)).status).toBe(200)
  })

  it('refuses a viewer delete and a card on a deleted board', async () => {
    const board = await createBoard('alice', {})
    const card = await createCard('alice', board.id, {})
    addMember(board.id, 'bob', 'viewer')
    expect((await req('bob', 'DELETE', `/cards/${card.id}`)).status).toBe(403)
    await req('alice', 'DELETE', `/boards/${board.id}`)
    expect((await req('alice', 'GET', `/cards/${card.id}`)).status).toBe(404)
  })

  it('validates parent card exists on the same board and refuses self-parenting', async () => {
    const board1 = await createBoard('alice', {})
    const board2 = await createBoard('alice', {})
    const card1 = await createCard('alice', board1.id, { title: 'Parent' })
    const card2 = await createCard('alice', board2.id, { title: 'Other Board Card' })

    const crossBoard = await req('alice', 'POST', `/boards/${board1.id}/cards`, { title: 'Child', parentId: card2.id })
    expect(crossBoard.status).toBe(400)

    const validChild = await req('alice', 'POST', `/boards/${board1.id}/cards`, { title: 'Child', parentId: card1.id })
    expect(validChild.status).toBe(201)
    const childCard = ((await validChild.json()) as { card: ProjectCard }).card
    expect(childCard.parentId).toBe(card1.id)

    const selfParent = await req('alice', 'PATCH', `/cards/${card1.id}`, { parentId: card1.id })
    expect(selfParent.status).toBe(400)
  })
})
// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectCard, ProjectSubscription } from '../src/shared/project/model'
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
  sqlite.exec(`DELETE FROM project_subscriptions; DELETE FROM project_board_members; DELETE FROM project_boards; DELETE FROM project_cards`)
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

async function createBoard(account: Account): Promise<ProjectBoard> {
  const response = await req(account, 'POST', '/boards', { title: 'B' })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { board: ProjectBoard }).board
}

function addMember(boardId: string, account: Account, role: string): void {
  sqlite.prepare(
    'INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
  ).run(boardId, account, role)
}

async function list(account: Account): Promise<ProjectSubscription[]> {
  const response = await req(account, 'GET', '/subscriptions')
  expect(response.status).toBe(200)
  return ((await response.json()) as { subscriptions: ProjectSubscription[] }).subscriptions
}

describe('following a board', () => {
  it('follows, lists, re-follows idempotently, and unfollows', async () => {
    const board = await createBoard('alice')
    addMember(board.id, 'bob', 'viewer')
    const response = await req('bob', 'POST', '/subscriptions', { blockType: 'board', blockId: board.id })
    expect(response.status).toBe(201)
    expect(((await response.json()) as { subscription: ProjectSubscription }).subscription).toMatchObject({ blockType: 'board', blockId: board.id, subscriberId: 'bob' })
    expect((await list('bob')).map((s) => s.blockId)).toEqual([board.id])
    await req('bob', 'POST', '/subscriptions', { blockType: 'board', blockId: board.id })
    expect(await list('bob')).toHaveLength(1)
    expect((await req('bob', 'DELETE', `/subscriptions/${board.id}`)).status).toBe(200)
    expect(await list('bob')).toEqual([])
    await req('bob', 'POST', '/subscriptions', { blockType: 'board', blockId: board.id })
    expect((await list('bob')).map((s) => s.blockId)).toEqual([board.id])
  })

  it('hides a private board from a stranger and requires sign-in', async () => {
    const board = await createBoard('alice')
    expect((await req('carol', 'POST', '/subscriptions', { blockType: 'board', blockId: board.id })).status).toBe(404)
    expect((await req(null, 'POST', '/subscriptions', { blockType: 'board', blockId: board.id })).status).toBe(401)
  })

  it('lists only the caller’s own subscriptions and unfollow is idempotent', async () => {
    const board = await createBoard('alice')
    addMember(board.id, 'bob', 'viewer')
    await req('bob', 'POST', '/subscriptions', { blockType: 'board', blockId: board.id })
    expect(await list('alice')).toEqual([])
    expect((await req('alice', 'DELETE', `/subscriptions/${board.id}`)).status).toBe(200)
    expect((await list('bob')).map((s) => s.blockId)).toEqual([board.id])
  })
})

describe('following a card', () => {
  it('follows a card on a readable board', async () => {
    const board = await createBoard('alice')
    const cardResponse = await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'C' })
    const card = ((await cardResponse.json()) as { card: ProjectCard }).card
    addMember(board.id, 'bob', 'viewer')
    const response = await req('bob', 'POST', '/subscriptions', { blockType: 'card', blockId: card.id })
    expect(response.status).toBe(201)
    expect(((await response.json()) as { subscription: ProjectSubscription }).subscription.blockType).toBe('card')
    expect((await list('bob')).map((s) => s.blockId)).toEqual([card.id])
  })
})
describe('the restore list (R3-5)', () => {
  it('lists a soft-deleted board the live list hides, and restoring brings it back', async () => {
    const created = await req('alice', 'POST', '/boards', { title: 'Doomed' })
    const board = ((await created.json()) as { board: ProjectBoard }).board
    await req('alice', 'DELETE', `/boards/${board.id}`)
    const live = ((await (await req('alice', 'GET', '/boards')).json()) as { boards: ProjectBoard[] }).boards
    expect(live.some((entry) => entry.id === board.id)).toBe(false)
    const trash = ((await (await req('alice', 'GET', '/trash')).json()) as { boards: ProjectBoard[] }).boards
    expect(trash.some((entry) => entry.id === board.id)).toBe(true)
    await req('alice', 'POST', `/boards/${board.id}/undelete`, {})
    const after = ((await (await req('alice', 'GET', '/trash')).json()) as { boards: ProjectBoard[] }).boards
    expect(after.some((entry) => entry.id === board.id)).toBe(false)
  })

  it('lists deleted cards for a board admin', async () => {
    const created = await req('alice', 'POST', '/boards', { title: 'Card trash' })
    const board = ((await created.json()) as { board: ProjectBoard }).board
    const cardRes = await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'Dropped' })
    const card = ((await cardRes.json()) as { card: { id: string } }).card
    await req('alice', 'DELETE', `/cards/${card.id}`)
    const trash = ((await (await req('alice', 'GET', `/boards/${board.id}/trash`)).json()) as { cards: { id: string }[] }).cards
    expect(trash.map((entry) => entry.id)).toContain(card.id)
  })
})

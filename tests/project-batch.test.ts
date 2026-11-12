// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectBoardBundle, ProjectCard } from '../src/shared/project/model'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const ACCOUNTS = ['alice', 'bob'] as const
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

const pid = (n: number) => `p${String(n).padStart(26, '0')}`
const missingId = `c${'9'.repeat(26)}`

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
  const response = await req(account, 'POST', '/boards', { title: 'B', cardProperties: [{ id: pid(1), name: 'Status', type: 'select', options: [] }] })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { board: ProjectBoard }).board
}

async function createCard(account: Account, boardId: string, title: string): Promise<ProjectCard> {
  const response = await req(account, 'POST', `/boards/${boardId}/cards`, { title })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { card: ProjectCard }).card
}

async function bundle(account: Account, boardId: string): Promise<ProjectBoardBundle> {
  const response = await req(account, 'GET', `/boards/${boardId}/bundle`)
  expect(response.status).toBe(200)
  return (await response.json()) as ProjectBoardBundle
}

function addMember(boardId: string, account: Account, role: string): void {
  sqlite.prepare(
    'INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
  ).run(boardId, account, role)
}

describe('batch patch', () => {
  it('applies card, content and view edits in one transaction', async () => {
    const board = await createBoard('alice')
    const a = await createCard('alice', board.id, 'A')
    const b = await createCard('alice', board.id, 'B')
    const contentResponse = await req('alice', 'POST', `/cards/${a.id}/contents`, { type: 'text', title: 'Old' })
    const content = ((await contentResponse.json()) as { content: { id: string } }).content
    const viewResponse = await req('alice', 'POST', `/boards/${board.id}/views`, { title: 'V' })
    const view = ((await viewResponse.json()) as { view: { id: string } }).view
    const response = await req('alice', 'PATCH', `/boards/${board.id}/batch`, {
      cards: [{ id: a.id, patch: { values: { [pid(1)]: 'done' } } }, { id: b.id, patch: { title: 'B2' } }],
      contents: [{ id: content.id, patch: { title: 'New' } }],
      views: [{ id: view.id, patch: { title: 'V2' } }],
    })
    expect(response.status).toBe(200)
    const result = await bundle('alice', board.id)
    expect(result.cards.find((c) => c.id === a.id)!.values).toEqual({ [pid(1)]: 'done' })
    expect(result.cards.find((c) => c.id === b.id)!.title).toBe('B2')
    expect(result.contents[0]!.title).toBe('New')
    expect(result.views[0]!.title).toBe('V2')
  })

  it('rolls back nothing applied when one target is missing (atomic)', async () => {
    const board = await createBoard('alice')
    const a = await createCard('alice', board.id, 'A')
    const response = await req('alice', 'PATCH', `/boards/${board.id}/batch`, {
      cards: [{ id: a.id, patch: { title: 'Changed' } }, { id: missingId, patch: { title: 'X' } }],
    })
    expect(response.status).toBe(404)
    expect((await bundle('alice', board.id)).cards[0]!.title).toBe('A')
  })

  it('refuses a card from another board and a viewer', async () => {
    const board = await createBoard('alice')
    const other = await createBoard('alice')
    const foreign = await createCard('alice', other.id, 'Foreign')
    expect((await req('alice', 'PATCH', `/boards/${board.id}/batch`, { cards: [{ id: foreign.id, patch: { title: 'X' } }] })).status).toBe(404)
    addMember(board.id, 'bob', 'viewer')
    expect((await req('bob', 'PATCH', `/boards/${board.id}/batch`, { cards: [] })).status).toBe(403)
  })
})

describe('batch delete', () => {
  it('soft-deletes cards, views and contents, scrubbing the reading order', async () => {
    const board = await createBoard('alice')
    const a = await createCard('alice', board.id, 'A')
    const b = await createCard('alice', board.id, 'B')
    const c1 = ((await (await req('alice', 'POST', `/cards/${a.id}/contents`, { type: 'text', title: '1' })).json()) as { content: { id: string } }).content
    const c2 = ((await (await req('alice', 'POST', `/cards/${a.id}/contents`, { type: 'text', title: '2' })).json()) as { content: { id: string } }).content
    const view = ((await (await req('alice', 'POST', `/boards/${board.id}/views`, { title: 'V' })).json()) as { view: { id: string } }).view
    const response = await req('alice', 'POST', `/boards/${board.id}/batch-delete`, {
      cardIds: [b.id], viewIds: [view.id], contentIds: [c1.id, c2.id],
    })
    expect(response.status).toBe(200)
    const result = await bundle('alice', board.id)
    expect(result.cards.map((c) => c.id)).toEqual([a.id])
    expect(result.views).toEqual([])
    expect(result.contents).toEqual([])
    expect(result.cards[0]!.contentOrder).toEqual([])
  })
})
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

const pid = (n: number) => `p${String(n).padStart(26, '0')}`

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

async function bundle(account: Account, boardId: string): Promise<ProjectBoardBundle> {
  const response = await req(account, 'GET', `/boards/${boardId}/bundle`)
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json()) as ProjectBoardBundle
}

async function richBoard(): Promise<{ board: ProjectBoard; card: ProjectCard }> {
  const board = await createBoard('alice', {
    title: 'Source', cardProperties: [{ id: pid(1), name: 'Status', type: 'select', options: [] }],
  })
  const cardResponse = await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'Card', values: { [pid(1)]: 'x' } })
  const card = ((await cardResponse.json()) as { card: ProjectCard }).card
  await req('alice', 'POST', `/cards/${card.id}/contents`, { type: 'text', title: 'Body' })
  await req('alice', 'POST', `/cards/${card.id}/comments`, { body: 'A comment' })
  await req('alice', 'POST', `/boards/${board.id}/views`, { title: 'Table', viewType: 'table', fields: { cardOrder: [card.id], defaultTemplateId: card.id } })
  return { board, card }
}

describe('duplicating a board', () => {
  it('copies every entity with fresh ids and rewired references, under the caller', async () => {
    const { board, card } = await richBoard()
    addMember(board.id, 'bob', 'viewer')
    const response = await req('bob', 'POST', `/boards/${board.id}/duplicate`)
    expect(response.status, await response.clone().text()).toBe(201)
    const copy = ((await response.json()) as { board: ProjectBoard }).board
    expect(copy.id).not.toBe(board.id)
    expect(copy.ownerId).toBe('bob')
    expect(copy.title).toBe('Source')

    const result = await bundle('bob', copy.id)
    expect(result.board.ownerId).toBe('bob')
    expect(result.properties.map((p) => p.id)).toEqual([pid(1)])
    expect(result.cards).toHaveLength(1)
    const newCard = result.cards[0]!
    expect(newCard.id).not.toBe(card.id)
    expect(newCard).toMatchObject({ title: 'Card', values: { [pid(1)]: 'x' } })
    expect(result.contents).toHaveLength(1)
    expect(result.contents[0]!.cardId).toBe(newCard.id)
    expect(result.contents[0]!.id).not.toBe(card.contentOrder[0])
    expect(newCard.contentOrder).toEqual([result.contents[0]!.id, result.comments[0]!.id])
    expect(result.comments).toHaveLength(1)
    expect(result.comments[0]!.cardId).toBe(newCard.id)
    expect(result.views[0]!.fields.cardOrder).toEqual([newCard.id])
    expect(result.views[0]!.fields.defaultTemplateId).toBe(newCard.id)
    expect(result.members.map((m) => m.userId)).toEqual(['bob'])
  })

  it('hides a private board from a stranger', async () => {
    const { board } = await richBoard()
    expect((await req('carol', 'POST', `/boards/${board.id}/duplicate`)).status).toBe(404)
  })
})

describe('duplicating a card', () => {
  it('copies values and content but not comments, with a fresh reading order', async () => {
    const { board, card } = await richBoard()
    addMember(board.id, 'bob', 'editor')
    const response = await req('bob', 'POST', `/cards/${card.id}/duplicate`)
    expect(response.status, await response.clone().text()).toBe(201)
    const copy = ((await response.json()) as { card: ProjectCard }).card
    expect(copy.id).not.toBe(card.id)
    expect(copy).toMatchObject({ title: 'Card', values: { [pid(1)]: 'x' }, createdBy: 'bob' })
    const result = await bundle('bob', board.id)
    const copiedContents = result.contents.filter((a) => a.cardId === copy.id)
    expect(copiedContents).toHaveLength(1)
    expect(copy.contentOrder).toEqual([copiedContents[0]!.id])
    expect(result.comments.filter((m) => m.cardId === copy.id)).toEqual([])
    expect(result.cards.filter((c) => c.id === card.id)).toHaveLength(1)
  })

  it('refuses a viewer', async () => {
    const { board, card } = await richBoard()
    addMember(board.id, 'bob', 'viewer')
    expect((await req('bob', 'POST', `/cards/${card.id}/duplicate`)).status).toBe(403)
  })
})
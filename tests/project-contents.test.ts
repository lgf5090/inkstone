// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectCard, ProjectComment, ProjectContent } from '../src/shared/project/model'
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
    DELETE FROM project_cards; DELETE FROM project_card_values; DELETE FROM project_card_contents; DELETE FROM project_comments`)
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

async function createCard(account: Account, boardId: string): Promise<ProjectCard> {
  const response = await req(account, 'POST', `/boards/${boardId}/cards`, { title: 'C' })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { card: ProjectCard }).card
}

function addMember(boardId: string, account: Account, role: string): void {
  sqlite.prepare(
    'INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
  ).run(boardId, account, role)
}

function cardOrder(cardId: string): (string | string[])[] {
  const row = sqlite.prepare('SELECT content_order FROM project_cards WHERE id = ?').get(cardId) as { content_order: string }
  return JSON.parse(row.content_order) as (string | string[])[]
}

async function createContent(account: Account, cardId: string, body: Record<string, unknown>): Promise<ProjectContent> {
  const response = await req(account, 'POST', `/cards/${cardId}/contents`, body)
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { content: ProjectContent }).content
}

describe('content blocks', () => {
  it('creates blocks that join the reading order with ascending positions, and refuses a viewer', async () => {
    const board = await createBoard('alice')
    const card = await createCard('alice', board.id)
    const first = await createContent('alice', card.id, { type: 'text', title: 'Hello' })
    const second = await createContent('alice', card.id, { type: 'checkbox', fields: { checked: true } })
    expect(first.position).toBe(0)
    expect(second.position).toBe(1)
    expect(second.fields).toEqual({ checked: true })
    expect(cardOrder(card.id)).toEqual([first.id, second.id])
    addMember(board.id, 'bob', 'viewer')
    expect((await req('bob', 'POST', `/cards/${card.id}/contents`, { type: 'text' })).status).toBe(403)
  })

  it('moves a block before another, reordering both the reading order and positions', async () => {
    const board = await createBoard('alice')
    const card = await createCard('alice', board.id)
    const a = await createContent('alice', card.id, { type: 'text', title: 'A' })
    const b = await createContent('alice', card.id, { type: 'text', title: 'B' })
    const c = await createContent('alice', card.id, { type: 'text', title: 'C' })
    const response = await req('alice', 'POST', `/contents/${c.id}/move`, { where: 'before', targetId: a.id })
    expect(response.status).toBe(200)
    expect(cardOrder(card.id)).toEqual([c.id, a.id, b.id])
    const positions = sqlite.prepare('SELECT id, position FROM project_card_contents WHERE card_id = ? ORDER BY position').all(card.id) as { id: string; position: number }[]
    expect(positions.map((p) => p.id)).toEqual([c.id, a.id, b.id])
    expect(positions.map((p) => p.position)).toEqual([0, 1, 2])
  })

  it('deletes a block out of the reading order and restores it on undelete', async () => {
    const board = await createBoard('alice')
    const card = await createCard('alice', board.id)
    const a = await createContent('alice', card.id, { type: 'text', title: 'A' })
    const b = await createContent('alice', card.id, { type: 'text', title: 'B' })
    expect((await req('alice', 'DELETE', `/contents/${a.id}`)).status).toBe(200)
    expect(cardOrder(card.id)).toEqual([b.id])
    expect((await req('alice', 'GET', `/contents/${a.id}`)).status).toBe(404)
    const restored = await req('alice', 'POST', `/contents/${a.id}/undelete`)
    expect(restored.status).toBe(200)
    expect(cardOrder(card.id)).toEqual([b.id, a.id])
  })

  it('patches a block title and fields', async () => {
    const board = await createBoard('alice')
    const card = await createCard('alice', board.id)
    const block = await createContent('alice', card.id, { type: 'checkbox', title: 'Old', fields: { checked: false } })
    const response = await req('alice', 'PATCH', `/contents/${block.id}`, { title: 'New', fields: { checked: true } })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { content: ProjectContent }).content).toMatchObject({ title: 'New', fields: { checked: true } })
  })
})

describe('comments', () => {
  it('lets a commenter post, joins the reading order, and lists in creation order', async () => {
    const board = await createBoard('alice')
    const card = await createCard('alice', board.id)
    addMember(board.id, 'bob', 'commenter')
    const response = await req('bob', 'POST', `/cards/${card.id}/comments`, { body: 'First!' })
    expect(response.status).toBe(201)
    const comment = ((await response.json()) as { comment: ProjectComment }).comment
    expect(comment).toMatchObject({ authorId: 'bob', body: 'First!' })
    expect(cardOrder(card.id)).toEqual([comment.id])
    const list = await req('alice', 'GET', `/cards/${card.id}/comments`)
    expect(list.status).toBe(200)
    expect(((await list.json()) as { comments: ProjectComment[] }).comments.map((m) => m.id)).toEqual([comment.id])
    addMember(board.id, 'carol', 'viewer')
    expect((await req('carol', 'POST', `/cards/${card.id}/comments`, { body: 'no' })).status).toBe(403)
  })

  it('lets only the author edit or delete, and scrubs a deleted comment from a thread', async () => {
    const board = await createBoard('alice')
    const card = await createCard('alice', board.id)
    addMember(board.id, 'bob', 'commenter')
    const posted = await req('alice', 'POST', `/cards/${card.id}/comments`, { body: 'Mine' })
    const comment = ((await posted.json()) as { comment: ProjectComment }).comment
    expect((await req('bob', 'PATCH', `/comments/${comment.id}`, { body: 'hijack' })).status).toBe(403)
    expect((await req('bob', 'DELETE', `/comments/${comment.id}`)).status).toBe(403)
    const edited = await req('alice', 'PATCH', `/comments/${comment.id}`, { body: 'Edited' })
    expect(edited.status).toBe(200)
    expect(((await edited.json()) as { comment: ProjectComment }).comment.body).toBe('Edited')
    sqlite.prepare('UPDATE project_cards SET content_order = ? WHERE id = ?').run(JSON.stringify([[comment.id]]), card.id)
    expect((await req('alice', 'DELETE', `/comments/${comment.id}`)).status).toBe(200)
    expect(cardOrder(card.id)).toEqual([])
    expect(((await (await req('alice', 'GET', `/cards/${card.id}/comments`)).json()) as { comments: ProjectComment[] }).comments).toEqual([])
  })
})
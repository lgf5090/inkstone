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

const app = createApp()
let sqlite: DatabaseSync
let env: Env
let token: string

const pid = (n: number) => `p${String(n).padStart(26, '0')}`

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite))
  await app.fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  for (const account of ['alice', 'bob']) {
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at)
       VALUES (?, ?, 'hash', ?, ?, 'member', ?, ?)`,
    ).run(account, account, account, account, now, now)
  }
  token = await createSession(env.DB, 'alice')
})

beforeEach(() => {
  sqlite.exec(`DELETE FROM project_properties; DELETE FROM project_board_members; DELETE FROM project_boards;
    DELETE FROM project_cards; DELETE FROM project_card_values; DELETE FROM project_card_contents;
    DELETE FROM project_comments; DELETE FROM project_subscriptions; DELETE FROM chat_notifications`)
  sqlite.prepare("UPDATE users SET settings = '{}'").run()
})

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${token}` }
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
}

async function boardWithCard(): Promise<{ board: ProjectBoard, card: ProjectCard }> {
  const created = await req('POST', '/boards', {
    title: 'Notify', cardProperties: [{ id: pid(1), name: 'Owner', type: 'person', options: [] }],
  })
  const board = ((await created.json()) as { board: ProjectBoard }).board
  sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
    .run(board.id, 'bob', 'editor')
  const cardResponse = await req('POST', `/boards/${board.id}/cards`, { title: 'Task' })
  const card = ((await cardResponse.json()) as { card: ProjectCard }).card
  return { board, card }
}

function preference(boardId: string, level: 'all' | 'mentions' | 'off'): void {
  sqlite.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify({ project: { notifications: { [boardId]: level } } }), 'bob')
}

function notices(): { title: string, link: string | null }[] {
  return sqlite.prepare('SELECT title, link FROM chat_notifications WHERE user_id = ? ORDER BY created_at').all('bob') as { title: string, link: string | null }[]
}

describe('the per-board notification preference', () => {
  it('delivers a mention by default', async () => {
    const { board, card } = await boardWithCard()
    expect((await req('POST', `/cards/${card.id}/comments`, { body: '@bob please look' })).status).toBe(201)
    expect(notices()).toEqual([{ title: 'New comment on Task', link: `project:${board.id}:${card.id}` }])
  })

  it('drops every comment notice when the reader chose nothing', async () => {
    const { board, card } = await boardWithCard()
    preference(board.id, 'off')
    await req('POST', `/cards/${card.id}/comments`, { body: '@bob please look' })
    expect(notices()).toEqual([])
  })

  it('keeps only mentions when the reader chose mentions', async () => {
    const { board, card } = await boardWithCard()
    preference(board.id, 'mentions')
    sqlite.prepare('INSERT INTO project_subscriptions (block_type, block_id, subscriber_id, create_at) VALUES (?, ?, ?, 1)')
      .run('card', card.id, 'bob')
    await req('POST', `/cards/${card.id}/comments`, { body: 'a general update' })
    expect(notices()).toEqual([])
    await req('POST', `/cards/${card.id}/comments`, { body: '@bob a direct one' })
    expect(notices().map((notice) => notice.title)).toEqual(['New comment on Task'])
  })

  it('honours the same choice for an assignment', async () => {
    const { board, card } = await boardWithCard()
    preference(board.id, 'off')
    await req('PATCH', `/cards/${card.id}`, { values: { [pid(1)]: 'bob' } })
    expect(notices()).toEqual([])
    preference(board.id, 'mentions')
    await req('PATCH', `/cards/${card.id}`, { values: { [pid(1)]: null } })
    await req('PATCH', `/cards/${card.id}`, { values: { [pid(1)]: 'bob' } })
    expect(notices().map((notice) => notice.title)).toEqual(['Assigned to Task'])
  })
})

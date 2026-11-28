// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { SyncHub } from '../src/worker/realtime/sync-hub'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard } from '../src/shared/project/model'
import { testBindings, testD1 } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const app = createApp()
const tokens = new Map<string, string>()
let sqlite: DatabaseSync
let env: Env

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite))
  await app.fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  for (const account of ['alice', 'bob', 'carol']) {
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at)
       VALUES (?, ?, 'hash', ?, ?, 'member', ?, ?)`,
    ).run(account, account, account, account, now, now)
    tokens.set(account, await createSession(env.DB, account))
  }
})

beforeEach(() => {
  sqlite.exec('DELETE FROM project_activity_changes; DELETE FROM project_board_presence; DELETE FROM project_activity; DELETE FROM project_board_members; DELETE FROM project_boards')
})

async function req(account: string | null, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {}
  if (account) headers.Cookie = `${LEGACY_SESSION_COOKIE}=${tokens.get(account)}`
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
}

async function createBoard(): Promise<ProjectBoard> {
  const response = await req('alice', 'POST', '/boards', { title: 'Collab' })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { board: ProjectBoard }).board
}

async function createCard(boardId: string, title = 'Card'): Promise<{ id: string, title: string }> {
  const response = await req('alice', 'POST', `/boards/${boardId}/cards`, { title })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { card: { id: string, title: string } }).card
}

async function waitForActivity(boardId: string, entityId: string, field?: string, newValue?: unknown): Promise<{ activity: Array<{ targetId: string, changes?: Array<{ field: string, oldValue?: unknown, newValue?: unknown, entityId: string }> }> }> {
  let lastBody: unknown = null
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await req('alice', 'GET', `/boards/${boardId}/activity`)
    const body = await response.json() as { activity: Array<{ targetId: string, changes?: Array<{ field: string, oldValue?: unknown, newValue?: unknown, entityId: string }> }> }
    lastBody = body
    if (body.activity.some((entry) => entry.changes?.some((change) => change.entityId === entityId && (!field || (change.field === field && change.newValue === newValue))))) return body
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Audit activity did not appear: ${JSON.stringify(lastBody)}`)
}

describe('board presence', () => {
  it('lists only fresh members and removes stale heartbeats', async () => {
    const board = await createBoard()
    sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
      .run(board.id, 'bob', 'viewer')

    const alice = await req('alice', 'POST', `/boards/${board.id}/presence`)
    expect(alice.status).toBe(202)
    expect(((await alice.json()) as { users: string[] }).users).toEqual(['alice'])

    const bob = await req('bob', 'POST', `/boards/${board.id}/presence`)
    expect(bob.status).toBe(202)
    expect(((await bob.json()) as { users: string[] }).users).toEqual(['bob', 'alice'])

    sqlite.prepare('UPDATE project_board_presence SET last_seen_at = 1 WHERE user_id = ?').run('alice')
    const fresh = await req('bob', 'POST', `/boards/${board.id}/presence`)
    expect(((await fresh.json()) as { users: string[] }).users).toEqual(['bob'])
    expect(sqlite.prepare('SELECT user_id FROM project_board_presence WHERE user_id = ?').get('alice')).toBeUndefined()
  })

  it('does not expose a private board or turn heartbeats into board activity', async () => {
    const board = await createBoard()
    const before = await req('alice', 'GET', `/boards/${board.id}/cursor`)
    const cursor = ((await before.json()) as { cursor: number }).cursor
    expect((await req('carol', 'POST', `/boards/${board.id}/presence`)).status).toBe(404)
    expect((await req('alice', 'POST', `/boards/${board.id}/presence`)).status).toBe(202)
    const after = await req('alice', 'GET', `/boards/${board.id}/cursor`)
    expect(((await after.json()) as { cursor: number }).cursor).toBe(cursor)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM project_activity').get()).toEqual({ count: 0 })
  })
})

describe('field-level activity audit', () => {
  it('records card title and property value changes with old and new values', async () => {
    const propertyId = `p${'a'.repeat(26)}`
    const createdBoard = await req('alice', 'POST', '/boards', {
      title: 'Collab',
      cardProperties: [{ id: propertyId, name: 'Status', type: 'text', options: [] }],
    })
    expect(createdBoard.status, await createdBoard.clone().text()).toBe(201)
    const board = ((await createdBoard.json()) as { board: ProjectBoard }).board
    const card = await createCard(board.id, 'Before')
    const response = await req('alice', 'PATCH', `/cards/${card.id}`, { title: 'After', values: { [propertyId]: 'Done' } })
    expect(response.status, await response.clone().text()).toBe(200)
    const body = await waitForActivity(board.id, card.id, 'title', 'After')
    const entry = body.activity.find((item) => item.changes?.some((change) => change.entityId === card.id && change.field === 'title'))
    expect(entry?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: card.id, field: 'title', oldValue: 'Before', newValue: 'After' }),
      expect.objectContaining({ entityId: card.id, field: `values.${propertyId}`, newValue: 'Done' }),
    ]))
  })

  it('records comment creation and edits without losing the previous body', async () => {
    const board = await createBoard()
    const card = await createCard(board.id)
    const created = await req('alice', 'POST', `/cards/${card.id}/comments`, { body: 'Hello' })
    expect(created.status).toBe(201)
    const comment = ((await created.json()) as { comment: { id: string } }).comment
    await waitForActivity(board.id, comment.id, 'body', 'Hello')
    const patched = await req('alice', 'PATCH', `/comments/${comment.id}`, { body: 'Edited' })
    expect(patched.status).toBe(200)
    const body = await waitForActivity(board.id, comment.id, 'body', 'Edited')
    expect(body.activity.flatMap((entry) => entry.changes ?? [])).toContainEqual(expect.objectContaining({
      entity: 'comment', entityId: comment.id, field: 'body', oldValue: 'Hello', newValue: 'Edited',
    }))
  })

  it('audits batch patches and deletes without storing share passwords', async () => {
    const board = await createBoard()
    const first = await createCard(board.id, 'First')
    const second = await createCard(board.id, 'Second')
    const batch = await req('alice', 'PATCH', `/boards/${board.id}/batch`, {
      cards: [{ id: first.id, patch: { title: 'One' } }, { id: second.id, patch: { title: 'Two' } }],
    })
    expect(batch.status).toBe(200)
    const batchActivity = await waitForActivity(board.id, first.id, 'title', 'One')
    expect(batchActivity.activity[0]?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: first.id, field: 'title', oldValue: 'First', newValue: 'One' }),
      expect.objectContaining({ entityId: second.id, field: 'title', oldValue: 'Second', newValue: 'Two' }),
    ]))

    const deleted = await req('alice', 'POST', `/boards/${board.id}/batch-delete`, { cardIds: [first.id] })
    expect(deleted.status).toBe(200)
    const deleteActivity = await waitForActivity(board.id, first.id, 'deleted', true)
    expect(deleteActivity.activity[0]?.changes).toContainEqual(expect.objectContaining({ entityId: first.id, field: 'deleted', oldValue: false, newValue: true }))

    const share = await req('alice', 'PUT', `/boards/${board.id}/share`, { password: 'not-for-audit' })
    expect(share.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const activity = await req('alice', 'GET', `/boards/${board.id}/activity`)
    const entries = ((await activity.json()) as { activity: Array<{ changes?: Array<{ field: string, newValue?: unknown }> }> }).activity
    expect(entries.flatMap((entry) => entry.changes ?? []).some((change) => change.field.includes('password') || String(change.newValue).includes('not-for-audit'))).toBe(false)
  })
})

describe('project realtime messages', () => {
  it('fans out a validated board event with its card and comment targets', async () => {
    const sent: string[] = []
    const socket = { send: (payload: string) => sent.push(payload) } as unknown as WebSocket
    const state = {
      id: { name: 'user', toString: () => 'user' },
      storage: { get: () => null, put: () => {}, delete: () => true, list: () => [] },
      getWebSockets: () => [socket],
      acceptWebSocket: () => {},
      waitUntil: () => {},
    } as unknown as DurableObjectState
    const hub = new SyncHub(state, testBindings(testD1()))
    const response = await hub.fetch(new Request('https://sync-hub.internal/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cursor: 42,
        origin: 'tab',
        project: { boardId: 'board', entity: 'comment', cardId: 'card', commentId: 'comment' },
      }),
    }))
    expect(response.status).toBe(204)
    expect(JSON.parse(sent[0]!)).toEqual({
      type: 'project-changed', cursor: 42, origin: 'tab', boardId: 'board', entity: 'comment', cardId: 'card', commentId: 'comment',
    })
  })
})

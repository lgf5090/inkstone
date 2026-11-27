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
  sqlite.exec('DELETE FROM project_board_presence; DELETE FROM project_activity; DELETE FROM project_board_members; DELETE FROM project_boards')
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

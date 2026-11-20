// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectView } from '../src/shared/project/model'
import { testBindings } from './doubles/bindings'
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
  for (const account of ['alice', 'bob']) {
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at)
       VALUES (?, ?, 'hash', ?, ?, 'member', ?, ?)`,
    ).run(account, account, account, account, now, now)
    tokens.set(account, await createSession(env.DB, account))
  }
  // A second device on the same account, so the conflict rule is exercised across sessions.
  tokens.set('alice-2', await createSession(env.DB, 'alice'))
})

beforeEach(() => {
  sqlite.exec('DELETE FROM project_settings; DELETE FROM project_board_members; DELETE FROM project_boards; DELETE FROM project_views')
})

async function call(account: string | null, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {}
  if (account) headers.Cookie = `${LEGACY_SESSION_COOKIE}=${tokens.get(account)}`
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
}

async function createBoard(account: string): Promise<ProjectBoard> {
  const response = await call(account, 'POST', '/boards', {})
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { board: ProjectBoard }).board
}

async function createView(account: string, boardId: string): Promise<ProjectView> {
  const response = await call(account, 'POST', `/boards/${boardId}/views`, { title: 'Board' })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { view: ProjectView }).view
}

async function readDefaultView(account: string, boardId: string): Promise<string | null> {
  const response = await call(account, 'GET', `/boards/${boardId}/default-view`)
  expect(response.status).toBe(200)
  return ((await response.json()) as { viewId: string | null }).viewId
}

describe('the account default view', () => {
  it('starts empty and follows the account, not the board', async () => {
    const board = await createBoard('alice')
    expect(await readDefaultView('alice', board.id)).toBeNull()
    sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
      .run(board.id, 'bob', 'viewer')
    const view = await createView('alice', board.id)
    expect((await call('bob', 'PUT', `/boards/${board.id}/default-view`, { viewId: view.id })).status).toBe(200)
    expect(await readDefaultView('alice', board.id)).toBeNull()
    expect(await readDefaultView('bob', board.id)).toBe(view.id)
  })

  it('refuses a view from another board and a malformed id', async () => {
    const board = await createBoard('alice')
    const other = await createBoard('alice')
    const view = await createView('alice', other.id)
    expect((await call('alice', 'PUT', `/boards/${board.id}/default-view`, { viewId: view.id })).status).toBe(400)
    expect((await call('alice', 'PUT', `/boards/${board.id}/default-view`, { viewId: '../escape' })).status).toBe(400)
    expect(await readDefaultView('alice', board.id)).toBeNull()
  })

  it('lets the later device write win when two sessions pick different views', async () => {
    const board = await createBoard('alice')
    const first = await createView('alice', board.id)
    const second = await createView('alice', board.id)
    expect((await call('alice', 'PUT', `/boards/${board.id}/default-view`, { viewId: first.id })).status).toBe(200)
    expect((await call('alice-2', 'PUT', `/boards/${board.id}/default-view`, { viewId: second.id })).status).toBe(200)
    expect(await readDefaultView('alice', board.id)).toBe(second.id)
    expect((await call('alice-2', 'PUT', `/boards/${board.id}/default-view`, { viewId: null })).status).toBe(200)
    expect(await readDefaultView('alice', board.id)).toBeNull()
  })

  it('refuses a reader who cannot see the board at all', async () => {
    const board = await createBoard('alice')
    expect((await call('bob', 'GET', `/boards/${board.id}/default-view`)).status).toBe(404)
    expect((await call(null, 'GET', `/boards/${board.id}/default-view`)).status).toBe(401)
  })
})

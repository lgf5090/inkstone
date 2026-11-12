// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectBoardSummary } from '../src/shared/project/model'
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
  sqlite.exec('DELETE FROM project_board_members; DELETE FROM project_boards')
})

async function req(account: Account, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${tokens.get(account)}` }
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
}

async function createBoard(account: Account, title: string): Promise<ProjectBoard> {
  const response = await req(account, 'POST', '/boards', { title })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { board: ProjectBoard }).board
}

async function listBoards(account: Account, path: string): Promise<ProjectBoardSummary[]> {
  const response = await req(account, 'GET', path)
  expect(response.status).toBe(200)
  return ((await response.json()) as { boards: ProjectBoardSummary[] }).boards
}

describe('archiving a board', () => {
  it('hides an archived board from the live list and lists it under archived', async () => {
    const board = await createBoard('alice', 'Keep')
    expect((await listBoards('alice', '/boards')).map((entry) => entry.id)).toEqual([board.id])
    const archive = await req('alice', 'PATCH', `/boards/${board.id}`, { archived: true })
    expect(archive.status, await archive.clone().text()).toBe(200)
    expect((await listBoards('alice', '/boards')).map((entry) => entry.id)).toEqual([])
    const archived = await listBoards('alice', '/archived')
    expect(archived.map((entry) => entry.id)).toEqual([board.id])
    expect(archived[0]!.archived).toBe(true)
  })

  it('restores an archived board to the live list', async () => {
    const board = await createBoard('alice', 'Keep')
    await req('alice', 'PATCH', `/boards/${board.id}`, { archived: true })
    const restore = await req('alice', 'PATCH', `/boards/${board.id}`, { archived: false })
    expect(restore.status, await restore.clone().text()).toBe(200)
    expect((await listBoards('alice', '/boards')).map((entry) => entry.id)).toEqual([board.id])
    expect((await listBoards('alice', '/archived')).map((entry) => entry.id)).toEqual([])
  })

  it('keeps an archived board readable, and refuses an editor archiving it', async () => {
    const board = await createBoard('alice', 'Keep')
    sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)').run(board.id, 'bob', 'editor')
    expect((await req('bob', 'PATCH', `/boards/${board.id}`, { archived: true })).status).toBe(403)
    await req('alice', 'PATCH', `/boards/${board.id}`, { archived: true })
    expect((await req('alice', 'GET', `/boards/${board.id}`)).status).toBe(200)
  })
})
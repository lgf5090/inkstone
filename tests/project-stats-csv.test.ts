// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard } from '../src/shared/project/model'
import type { ProjectStatistics } from '../src/worker/project/statistics'
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
  sqlite.exec(`DELETE FROM project_properties; DELETE FROM project_board_members; DELETE FROM project_boards; DELETE FROM project_cards`)
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

async function createBoard(account: Account, title: string): Promise<ProjectBoard> {
  const response = await req(account, 'POST', '/boards', { title })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { board: ProjectBoard }).board
}

function addCard(boardId: string, id: string, deleteAt = 0): void {
  sqlite.prepare(
    `INSERT INTO project_cards (id, board_id, title, created_by, modified_by, create_at, update_at, delete_at) VALUES (?, ?, 'C', 'alice', 'alice', 1, 1, ?)`,
  ).run(id, boardId, deleteAt)
}

async function stats(account: Account): Promise<ProjectStatistics> {
  const response = await req(account, 'GET', '/statistics')
  expect(response.status).toBe(200)
  return (await response.json()) as ProjectStatistics
}

describe('personal statistics', () => {
  it('is zero for an account with no boards', async () => {
    expect(await stats('alice')).toEqual({ boardCount: 0, cardCount: 0 })
  })

  it('counts visible boards and their live cards per account', async () => {
    const b1 = await createBoard('alice', 'One')
    const b2 = await createBoard('alice', 'Two')
    addCard(b1.id, 'c1')
    addCard(b1.id, 'c2')
    addCard(b2.id, 'c3')
    addCard(b2.id, 'c4', 99)
    sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)').run(b1.id, 'bob', 'viewer')
    expect(await stats('alice')).toEqual({ boardCount: 2, cardCount: 3 })
    expect(await stats('bob')).toEqual({ boardCount: 1, cardCount: 2 })
    expect(await stats('carol')).toEqual({ boardCount: 0, cardCount: 0 })
  })

  it('requires sign-in', async () => {
    expect((await req(null, 'GET', '/statistics')).status).toBe(401)
  })
})

describe('CSV download', () => {
  it('serves a BOM-prefixed CSV with the card title and hides it from a stranger', async () => {
    const board = await createBoard('alice', 'Export')
    addCard(board.id, 'c1')
    sqlite.prepare('UPDATE project_cards SET title = ? WHERE id = ?').run('Comma, title', 'c1')
    const response = await req('alice', 'GET', `/boards/${board.id}/csv`)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    // Response.text() strips a leading UTF-8 BOM by spec, so verify the bytes on the wire instead.
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
    expect(text.startsWith('\uFEFF')).toBe(true)
    expect(text).toContain('"Comma, title"')
    expect((await req('carol', 'GET', `/boards/${board.id}/csv`)).status).toBe(404)
  })
})
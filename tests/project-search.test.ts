// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard } from '../src/shared/project/model'
import type { ProjectSearchResult } from '../src/worker/project/search'
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
    sqlite.prepare(`INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at) VALUES (?,?, 'hash', ?, ?, 'member', ?, ?)`).run(account, account, account, account, now, now)
    tokens.set(account, await createSession(env.DB, account))
  }
})

beforeEach(() => {
  sqlite.exec(`DELETE FROM project_board_members; DELETE FROM project_boards; DELETE FROM project_cards`)
})

async function req(account: Account, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${tokens.get(account)}` }
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
}

async function search(account: Account, q: string): Promise<ProjectSearchResult> {
  const response = await req(account, 'GET', `/search?q=${encodeURIComponent(q)}`)
  expect(response.status).toBe(200)
  return (await response.json()) as ProjectSearchResult
}

describe('cross-board search respects visibility', () => {
  it('hides a private board and its cards from a stranger, then reveals them once shared', async () => {
    const created = await req('alice', 'POST', '/boards', { title: 'Secret roadmap' })
    const board = ((await created.json()) as { board: ProjectBoard }).board
    await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'Launch plan' })
    expect((await search('bob', 'Launch')).cards).toEqual([])
    expect((await search('bob', 'Secret')).boards).toEqual([])
    sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?,?,?,1,1)').run(board.id, 'bob', 'viewer')
    expect((await search('bob', 'Launch')).cards.map((c) => c.title)).toEqual(['Launch plan'])
    expect((await search('bob', 'Secret')).boards.map((b) => b.id)).toEqual([board.id])
    expect((await search('carol', 'Launch')).cards).toEqual([])
  })

  it('returns empty for a blank query and escapes LIKE wildcards', async () => {
    const created = await req('alice', 'POST', '/boards', { title: '100% done' })
    const board = ((await created.json()) as { board: ProjectBoard }).board
    await req('alice', 'POST', `/boards/${board.id}/cards`, { title: '50% off' })
    expect((await search('alice', '')).cards).toEqual([])
    expect((await search('alice', '50%')).cards.map((c) => c.title)).toEqual(['50% off'])
    expect((await search('alice', '50_')).cards).toEqual([])
  })
})
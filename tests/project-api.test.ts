// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoardSummary } from '../src/worker/project/permissions'
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
  sqlite.exec('DELETE FROM project_board_members; DELETE FROM project_boards')
})

function addBoard(id: string, owner: Account, extra: Record<string, string | number> = {}): void {
  const row: Record<string, string | number> = {
    id, owner_id: owner, created_by: owner, modified_by: owner, create_at: 1, update_at: 1, ...extra,
  }
  const keys = Object.keys(row)
  sqlite.prepare(
    `INSERT INTO project_boards (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
  ).run(...keys.map((key) => row[key]))
}

function addMember(boardId: string, account: Account, role: string): void {
  sqlite.prepare(
    `INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)`,
  ).run(boardId, account, role)
}

async function list(account: Account | null): Promise<Response> {
  const headers: Record<string, string> = {}
  if (account) headers.Cookie = `${LEGACY_SESSION_COOKIE}=${tokens.get(account)}`
  return app.fetch(new Request('http://localhost/api/project/boards', { headers }), env)
}

async function boards(account: Account): Promise<ProjectBoardSummary[]> {
  const response = await list(account)
  expect(response.status, await response.clone().text()).toBe(200)
  return ((await response.json()) as { boards: ProjectBoardSummary[] }).boards
}

describe('the board list', () => {
  it('answers an empty list rather than an error when the account has no boards', async () => {
    expect(await boards('alice')).toEqual([])
  })

  it('refuses a caller who is not signed in', async () => {
    const response = await list(null)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: { code: 'unauthenticated', message: 'Please sign in first' },
    })
  })

  it('lists the boards the account owns and the ones shared with it, and no others', async () => {
    addBoard('owned', 'alice')
    addBoard('shared', 'bob')
    addBoard('stranger', 'carol')
    addMember('shared', 'alice', 'editor')
    const listed = await boards('alice')
    expect(listed.map((board) => board.id).sort()).toEqual(['owned', 'shared'])
    expect(listed.find((board) => board.id === 'owned')!.role).toBe('admin')
    expect(listed.find((board) => board.id === 'shared')!.role).toBe('editor')
    expect((await boards('carol')).map((board) => board.id)).toEqual(['stranger'])
  })

  it('keeps deleted boards and templates out of the list even when a membership names them', async () => {
    addBoard('deleted', 'alice', { delete_at: 5 })
    addBoard('template', 'alice', { is_template: 1 })
    addBoard('shared-deleted', 'bob', { delete_at: 5 })
    addMember('shared-deleted', 'alice', 'viewer')
    addBoard('live', 'alice')
    expect((await boards('alice')).map((board) => board.id)).toEqual(['live'])
  })

  it('orders the list by the most recently updated board first', async () => {
    addBoard('older', 'alice', { update_at: 10 })
    addBoard('newer', 'alice', { update_at: 20 })
    expect((await boards('alice')).map((board) => board.id)).toEqual(['newer', 'older'])
  })

  it('keeps the list out of every cache, because it names what another account shared', async () => {
    expect((await list('alice')).headers.get('Cache-Control')).toBe('no-store')
  })
})
// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoardMember, ProjectRole } from '../src/shared/project/model'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const ACCOUNTS = ['alice', 'bob', 'carol', 'dave', 'eve', 'mallory'] as const
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

function addMember(boardId: string, account: string, role: string): void {
  sqlite.prepare(
    'INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
  ).run(boardId, account, role)
}

async function req(
  account: Account | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {}
  if (account) headers.Cookie = `${LEGACY_SESSION_COOKIE}=${tokens.get(account)}`
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(
    new Request(`http://localhost/api/project${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  )
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  return ((await response.json()) as { error: { code: string; message: string } }).error
}

describe('reading the member list', () => {
  it('lets a viewer read it but hides a private board from a stranger with a 404', async () => {
    addBoard('b1', 'alice')
    addMember('b1', 'bob', 'viewer')
    const allowed = await req('bob', 'GET', '/boards/b1/members')
    expect(allowed.status).toBe(200)
    expect(((await allowed.json()) as { members: ProjectBoardMember[] }).members.map((m) => m.userId)).toEqual(['bob'])
    const hidden = await req('mallory', 'GET', '/boards/b1/members')
    expect(hidden.status).toBe(404)
  })

  it('answers 404 for a board that does not exist', async () => {
    expect((await req('alice', 'GET', '/boards/nope/members')).status).toBe(404)
  })
})

describe('adding a member', () => {
  it('allows the owner and an admin, and refuses every weaker role with a 403', async () => {
    addBoard('b1', 'alice')
    addMember('b1', 'bob', 'admin')
    addMember('b1', 'carol', 'editor')
    addMember('b1', 'dave', 'commenter')
    addMember('b1', 'eve', 'viewer')
    for (const account of ['alice', 'bob'] as const) {
      const response = await req(account, 'POST', '/boards/b1/members', { userId: 'mallory', role: 'viewer' })
      expect(response.status, `${account}: ${await response.clone().text()}`).toBe(201)
      sqlite.exec("DELETE FROM project_board_members WHERE user_id = 'mallory'")
    }
    for (const account of ['carol', 'dave', 'eve'] as const) {
      const response = await req(account, 'POST', '/boards/b1/members', { userId: 'mallory', role: 'viewer' })
      expect(response.status, account).toBe(403)
    }
  })

  it('returns the created member with its role', async () => {
    addBoard('b1', 'alice')
    const response = await req('alice', 'POST', '/boards/b1/members', { userId: 'bob', role: 'editor' })
    expect(response.status).toBe(201)
    const { member } = (await response.json()) as { member: ProjectBoardMember }
    expect(member).toMatchObject({ boardId: 'b1', userId: 'bob', role: 'editor' })
  })

  it('refuses an unknown user with a 404', async () => {
    addBoard('b1', 'alice')
    const response = await req('alice', 'POST', '/boards/b1/members', { userId: 'ghost', role: 'viewer' })
    expect(response.status).toBe(404)
  })

  it('refuses a duplicate grant with a 409 already_member', async () => {
    addBoard('b1', 'alice')
    addMember('b1', 'bob', 'viewer')
    const response = await req('alice', 'POST', '/boards/b1/members', { userId: 'bob', role: 'editor' })
    expect(response.status).toBe(409)
    expect((await errorOf(response)).message).toBe('already_member')
  })

  it('refuses to grant the owner a membership with a 409 owner_immutable', async () => {
    addBoard('b1', 'alice')
    const response = await req('alice', 'POST', '/boards/b1/members', { userId: 'alice', role: 'viewer' })
    expect(response.status).toBe(409)
    expect((await errorOf(response)).message).toBe('owner_immutable')
  })

  it('refuses to exceed the member ceiling with a 409 naming the constant', async () => {
    addBoard('b1', 'alice')
    for (let i = 0; i < 50; i += 1) addMember('b1', `filler-${i}`, 'viewer')
    const response = await req('alice', 'POST', '/boards/b1/members', { userId: 'bob', role: 'viewer' })
    expect(response.status).toBe(409)
    expect((await errorOf(response)).message).toBe('PROJECT_MAX_BOARD_MEMBERS')
  })

  it('rejects an invalid role and a missing user id with a 400', async () => {
    addBoard('b1', 'alice')
    expect((await req('alice', 'POST', '/boards/b1/members', { userId: 'bob', role: 'superuser' })).status).toBe(400)
    expect((await req('alice', 'POST', '/boards/b1/members', { role: 'viewer' })).status).toBe(400)
  })
})

describe('changing a role', () => {
  it('lets an admin demote another member', async () => {
    addBoard('b1', 'alice')
    addMember('b1', 'bob', 'admin')
    addMember('b1', 'carol', 'editor')
    const response = await req('bob', 'PATCH', '/boards/b1/members/carol', { role: 'viewer' })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { member: ProjectBoardMember }).member.role).toBe('viewer')
  })

  it('refuses a weaker role with a 403', async () => {
    addBoard('b1', 'alice')
    addMember('b1', 'bob', 'editor')
    addMember('b1', 'carol', 'viewer')
    expect((await req('bob', 'PATCH', '/boards/b1/members/carol', { role: 'admin' })).status).toBe(403)
  })

  it('refuses the sole admin demoting themselves with a 409 last_admin', async () => {
    addBoard('b1', 'alice')
    addMember('b1', 'bob', 'admin')
    const response = await req('bob', 'PATCH', '/boards/b1/members/bob', { role: 'viewer' })
    expect(response.status).toBe(409)
    expect((await errorOf(response)).message).toBe('last_admin')
  })

  it('allows demoting one of two admins', async () => {
    addBoard('b1', 'alice')
    addMember('b1', 'bob', 'admin')
    addMember('b1', 'carol', 'admin')
    expect((await req('bob', 'PATCH', '/boards/b1/members/carol', { role: 'viewer' })).status).toBe(200)
  })

  it('refuses to change the owner role and answers 404 for a non-member', async () => {
    addBoard('b1', 'alice')
    addMember('b1', 'bob', 'admin')
    const owner = await req('bob', 'PATCH', '/boards/b1/members/alice', { role: 'viewer' })
    expect(owner.status).toBe(409)
    expect((await errorOf(owner)).message).toBe('owner_immutable')
    expect((await req('bob', 'PATCH', '/boards/b1/members/carol', { role: 'viewer' })).status).toBe(404)
  })
})

describe('removing a member', () => {
  it('lets an admin remove another member', async () => {
    addBoard('b1', 'alice')
    addMember('b1', 'bob', 'admin')
    addMember('b1', 'carol', 'editor')
    expect((await req('bob', 'DELETE', '/boards/b1/members/carol')).status).toBe(200)
    expect((await req('alice', 'GET', '/boards/b1/members')).status).toBe(200)
  })

  it('refuses to remove the sole admin with a 409 last_admin', async () => {
    addBoard('b1', 'alice')
    addMember('b1', 'bob', 'admin')
    const response = await req('alice', 'DELETE', '/boards/b1/members/bob')
    expect(response.status).toBe(409)
    expect((await errorOf(response)).message).toBe('last_admin')
  })

  it('refuses to remove the owner and answers 404 for a non-member', async () => {
    addBoard('b1', 'alice')
    addMember('b1', 'bob', 'admin')
    expect((await req('bob', 'DELETE', '/boards/b1/members/alice')).status).toBe(409)
    expect((await req('bob', 'DELETE', '/boards/b1/members/carol')).status).toBe(404)
  })
})

describe('joining an open board', () => {
  it('grants a stranger the board minimum role', async () => {
    addBoard('b1', 'alice', { type: 'O', minimum_role: 'editor' })
    const response = await req('mallory', 'POST', '/boards/b1/join')
    expect(response.status, await response.clone().text()).toBe(200)
    const { member, role } = (await response.json()) as { member: ProjectBoardMember; role: ProjectRole }
    expect(role).toBe('editor')
    expect(member).toMatchObject({ userId: 'mallory', role: 'editor' })
  })

  it('is idempotent and never downgrades an existing grant', async () => {
    addBoard('b1', 'alice', { type: 'O', minimum_role: 'viewer' })
    addMember('b1', 'bob', 'admin')
    const response = await req('bob', 'POST', '/boards/b1/join')
    expect(response.status).toBe(200)
    expect(((await response.json()) as { member: ProjectBoardMember }).member.role).toBe('admin')
  })

  it('hides a private board from a stranger with a 404', async () => {
    addBoard('b1', 'alice', { type: 'P' })
    expect((await req('mallory', 'POST', '/boards/b1/join')).status).toBe(404)
  })

  it('refuses an open board that grants no minimum role with a 404', async () => {
    addBoard('b1', 'alice', { type: 'O', minimum_role: '' })
    expect((await req('mallory', 'POST', '/boards/b1/join')).status).toBe(404)
  })

  it('returns admin without a membership row when the owner joins', async () => {
    addBoard('b1', 'alice', { type: 'O', minimum_role: 'viewer' })
    const response = await req('alice', 'POST', '/boards/b1/join')
    expect(response.status).toBe(200)
    expect((await response.json()) as { member: null; role: ProjectRole }).toEqual({ member: null, role: 'admin' })
  })
})

describe('leaving a board', () => {
  it('removes the caller membership', async () => {
    addBoard('b1', 'alice')
    addMember('b1', 'bob', 'editor')
    expect((await req('bob', 'POST', '/boards/b1/leave')).status).toBe(200)
    const { members } = (await (await req('alice', 'GET', '/boards/b1/members')).json()) as { members: ProjectBoardMember[] }
    expect(members.map((m) => m.userId)).toEqual([])
  })

  it('refuses the owner leaving with a 409 owner_immutable', async () => {
    addBoard('b1', 'alice')
    const response = await req('alice', 'POST', '/boards/b1/leave')
    expect(response.status).toBe(409)
    expect((await errorOf(response)).message).toBe('owner_immutable')
  })

  it('refuses the sole admin leaving with a 409 last_admin', async () => {
    addBoard('b1', 'alice')
    addMember('b1', 'bob', 'admin')
    const response = await req('bob', 'POST', '/boards/b1/leave')
    expect(response.status).toBe(409)
    expect((await errorOf(response)).message).toBe('last_admin')
  })

  it('answers 404 when a non-member tries to leave', async () => {
    addBoard('b1', 'alice', { type: 'O', minimum_role: 'viewer' })
    expect((await req('mallory', 'POST', '/boards/b1/leave')).status).toBe(404)
  })
})
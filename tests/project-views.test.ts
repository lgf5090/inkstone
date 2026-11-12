// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectView } from '../src/shared/project/model'
import { emptyProjectViewFields } from '../src/shared/project/model'
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
  sqlite.exec(`DELETE FROM project_properties; DELETE FROM project_board_members; DELETE FROM project_boards; DELETE FROM project_views`)
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

async function createBoard(account: Account, body: Record<string, unknown> = {}): Promise<ProjectBoard> {
  const response = await req(account, 'POST', '/boards', body)
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { board: ProjectBoard }).board
}

function addMember(boardId: string, account: Account, role: string): void {
  sqlite.prepare(
    'INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
  ).run(boardId, account, role)
}

async function createView(account: Account, boardId: string, body: Record<string, unknown> = {}): Promise<ProjectView> {
  const response = await req(account, 'POST', `/boards/${boardId}/views`, body)
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { view: ProjectView }).view
}

describe('creating a view', () => {
  it('merges partial fields over defaults and appends positions', async () => {
    const board = await createBoard('alice', {})
    const first = await createView('alice', board.id, { title: 'Board', fields: { cardOrder: ['c1'] } })
    expect(first.viewType).toBe('board')
    expect(first.position).toBe(0)
    expect(first.fields).toEqual({ ...emptyProjectViewFields(), cardOrder: ['c1'] })
    const second = await createView('alice', board.id, { title: 'Table', viewType: 'table' })
    expect(second.position).toBe(1)
    expect(second.viewType).toBe('table')
  })

  it('refuses a viewer and enforces the per-board view ceiling', async () => {
    const board = await createBoard('alice', {})
    addMember(board.id, 'bob', 'viewer')
    expect((await req('bob', 'POST', `/boards/${board.id}/views`, { title: 'x' })).status).toBe(403)
    const insert = sqlite.prepare(
      `INSERT INTO project_views (id, board_id, title, view_type, created_by, modified_by, create_at, update_at) VALUES (?, ?, 'V', 'board', 'alice', 'alice', 1, 1)`,
    )
    for (let i = 0; i < 50; i += 1) insert.run(`v${String(i).padStart(26, '0')}`, board.id)
    const response = await req('alice', 'POST', `/boards/${board.id}/views`, { title: 'one too many' })
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe('PROJECT_MAX_VIEWS_PER_BOARD')
  })
})

describe('reading and patching a view', () => {
  it('enforces view-level visibility on direct reads, patches and batch writes', async () => {
    const board = await createBoard('alice', {})
    const view = await createView('alice', board.id, { title: 'Private', fields: { minimumRole: 'admin' } })
    addMember(board.id, 'bob', 'viewer')
    addMember(board.id, 'carol', 'editor')
    expect((await req('bob', 'GET', `/views/${view.id}`)).status).toBe(404)
    expect((await req('carol', 'PATCH', `/views/${view.id}`, { title: 'x' })).status).toBe(404)
    expect((await req('carol', 'DELETE', `/views/${view.id}`)).status).toBe(404)
    expect((await req('carol', 'POST', `/boards/${board.id}/batch`, { views: [{ id: view.id, patch: { title: 'x' } }] })).status).toBe(404)
    expect((await req('carol', 'POST', `/boards/${board.id}/batch-delete`, { viewIds: [view.id] })).status).toBe(404)
    expect((await req('alice', 'GET', `/views/${view.id}`)).status).toBe(200)
    const reader = ((await (await req('bob', 'GET', `/boards/${board.id}/bundle`)).json()) as { views: ProjectView[], cursor: number })
    expect(reader.views.map((entry) => entry.id)).not.toContain(view.id)
    expect(reader.cursor).toBeGreaterThanOrEqual(view.updateAt)
  })

  it('lets a viewer read and merges a partial field patch without dropping the rest', async () => {
    const board = await createBoard('alice', {})
    const view = await createView('alice', board.id, { title: 'V', fields: { columnWidths: { c1: 200 }, cardOrder: ['c1'] } })
    addMember(board.id, 'bob', 'viewer')
    expect((await req('bob', 'GET', `/views/${view.id}`)).status).toBe(200)
    const response = await req('alice', 'PATCH', `/views/${view.id}`, { title: 'V2', fields: { cardOrder: ['c2'] } })
    expect(response.status).toBe(200)
    const updated = ((await response.json()) as { view: ProjectView }).view
    expect(updated.title).toBe('V2')
    expect(updated.fields.columnWidths).toEqual({ c1: 200 })
    expect(updated.fields.cardOrder).toEqual(['c2'])
    expect((await req('bob', 'PATCH', `/views/${view.id}`, { title: 'x' })).status).toBe(403)
    expect((await req('carol', 'GET', `/views/${view.id}`)).status).toBe(404)
  })
})

describe('deleting, restoring and duplicating a view', () => {
  it('soft-deletes, restores, and copies with a fresh id and the next position', async () => {
    const board = await createBoard('alice', {})
    const view = await createView('alice', board.id, { title: 'Original', viewType: 'gallery', fields: { cardOrder: ['c1'] } })
    expect((await req('alice', 'DELETE', `/views/${view.id}`)).status).toBe(200)
    expect((await req('alice', 'GET', `/views/${view.id}`)).status).toBe(404)
    const restored = await req('alice', 'POST', `/views/${view.id}/undelete`)
    expect(restored.status).toBe(200)
    expect(((await restored.json()) as { view: ProjectView }).view.deleteAt).toBe(0)
    const copyResponse = await req('alice', 'POST', `/views/${view.id}/duplicate`)
    expect(copyResponse.status).toBe(201)
    const copy = ((await copyResponse.json()) as { view: ProjectView }).view
    expect(copy.id).not.toBe(view.id)
    expect(copy.title).toBe('Original copy')
    expect(copy.viewType).toBe('gallery')
    expect(copy.fields.cardOrder).toEqual(['c1'])
    expect(copy.position).toBe(1)
  })
})
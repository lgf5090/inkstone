// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectCategory, ProjectCategoryBoard } from '../src/shared/project/model'
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
  sqlite.exec(`DELETE FROM project_categories; DELETE FROM project_category_boards; DELETE FROM project_board_members; DELETE FROM project_boards`)
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

async function createBoard(account: Account): Promise<ProjectBoard> {
  const response = await req(account, 'POST', '/boards', { title: 'B' })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { board: ProjectBoard }).board
}

async function createCategory(account: Account, name: string): Promise<ProjectCategory> {
  const response = await req(account, 'POST', '/categories', { name })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { category: ProjectCategory }).category
}

async function listCategories(account: Account): Promise<{ categories: ProjectCategory[]; categoryBoards: ProjectCategoryBoard[] }> {
  const response = await req(account, 'GET', '/categories')
  expect(response.status).toBe(200)
  return (await response.json()) as { categories: ProjectCategory[]; categoryBoards: ProjectCategoryBoard[] }
}

describe('category CRUD', () => {
  it('creates with ascending sort order, patches, and reorders', async () => {
    const a = await createCategory('alice', 'A')
    const b = await createCategory('alice', 'B')
    expect(a.sortOrder).toBe(0)
    expect(b.sortOrder).toBe(1)
    const patched = await req('alice', 'PATCH', `/categories/${a.id}`, { name: 'A2', collapsed: true })
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as { category: ProjectCategory }).category).toMatchObject({ name: 'A2', collapsed: true })
    expect((await req('alice', 'PUT', '/categories/order', { categoryIds: [b.id, a.id] })).status).toBe(200)
    expect((await listCategories('alice')).categories.map((c) => c.id)).toEqual([b.id, a.id])
  })

  it('deletes a custom category and its filings, but protects system categories', async () => {
    const board = await createBoard('alice')
    const category = await createCategory('alice', 'Custom')
    await req('alice', 'POST', `/categories/${category.id}/boards/${board.id}`)
    expect((await req('alice', 'DELETE', `/categories/${category.id}`)).status).toBe(200)
    const listed = await listCategories('alice')
    expect(listed.categories).toEqual([])
    expect(listed.categoryBoards).toEqual([])
    sqlite.prepare(
      `INSERT INTO project_categories (user_id, id, name, type, collapsed, sort_order, create_at, update_at, delete_at)
       VALUES ('alice', 'sys1', 'System', 'system', 0, 0, 1, 1, 0)`,
    ).run()
    expect((await req('alice', 'DELETE', '/categories/sys1')).status).toBe(409)
    expect((await req('alice', 'PATCH', '/categories/sys1', { name: 'Renamed' })).status).toBe(409)
    expect((await req('alice', 'PATCH', '/categories/sys1', { collapsed: true })).status).toBe(200)
  })

  it('keeps categories private to their owner', async () => {
    const category = await createCategory('alice', 'Mine')
    expect((await req('bob', 'PATCH', `/categories/${category.id}`, { name: 'Stolen' })).status).toBe(404)
    expect((await req('bob', 'DELETE', `/categories/${category.id}`)).status).toBe(404)
    expect((await listCategories('bob')).categories).toEqual([])
  })
})

describe('filing boards', () => {
  it('files a board, moves it between categories, reorders and hides', async () => {
    const board = await createBoard('alice')
    const first = await createCategory('alice', 'First')
    const second = await createCategory('alice', 'Second')
    const filed = await req('alice', 'POST', `/categories/${first.id}/boards/${board.id}`)
    expect(filed.status).toBe(201)
    expect(((await filed.json()) as { categoryBoard: ProjectCategoryBoard }).categoryBoard).toMatchObject({ categoryId: first.id, boardId: board.id, hidden: false })
    await req('alice', 'POST', `/categories/${second.id}/boards/${board.id}`)
    const edges = (await listCategories('alice')).categoryBoards
    expect(edges.map((e) => e.categoryId)).toEqual([second.id])
    const hidden = await req('alice', 'PUT', `/categories/${second.id}/boards/${board.id}/hidden`, { hidden: true })
    expect(hidden.status).toBe(200)
    expect(((await hidden.json()) as { categoryBoard: ProjectCategoryBoard }).categoryBoard.hidden).toBe(true)
    const board2 = await createBoard('alice')
    await req('alice', 'POST', `/categories/${second.id}/boards/${board2.id}`)
    expect((await req('alice', 'PUT', `/categories/${second.id}/boards/order`, { boardIds: [board2.id, board.id] })).status).toBe(200)
    const ordered = (await listCategories('alice')).categoryBoards.filter((e) => e.categoryId === second.id)
    expect(ordered.map((e) => e.boardId)).toEqual([board2.id, board.id])
    expect(ordered.map((e) => e.position)).toEqual([0, 1])
  })

  it('refuses to file a board the caller cannot see', async () => {
    const board = await createBoard('alice')
    const category = await createCategory('bob', 'Bob')
    expect((await req('bob', 'POST', `/categories/${category.id}/boards/${board.id}`)).status).toBe(404)
  })
})
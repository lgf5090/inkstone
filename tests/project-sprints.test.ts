// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectCard } from '../src/shared/project/model'
import type { ProjectSprint, ProjectSprintBurndown } from '../src/shared/project/stats'
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
})

beforeEach(() => {
  sqlite.exec(`DELETE FROM project_sprint_cards; DELETE FROM project_sprints; DELETE FROM project_card_values;
    DELETE FROM project_cards; DELETE FROM project_properties; DELETE FROM project_views;
    DELETE FROM project_board_members; DELETE FROM project_boards; DELETE FROM project_settings`)
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

async function createBoard(account = 'alice'): Promise<ProjectBoard> {
  const response = await call(account, 'POST', '/boards', {})
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { board: ProjectBoard }).board
}

async function createCard(account: string, boardId: string): Promise<ProjectCard> {
  const response = await call(account, 'POST', `/boards/${boardId}/cards`, { title: 'Work' })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { card: ProjectCard }).card
}

async function createSprint(boardId: string): Promise<ProjectSprint> {
  const response = await call('alice', 'POST', `/boards/${boardId}/sprints`, {
    name: 'Sprint 1', goal: 'Ship', startAt: 1, endAt: 1 + 3 * 86_400_000,
  })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { sprint: ProjectSprint }).sprint
}

interface SprintDetail { sprint: ProjectSprint, cards: ProjectCard[], burndown: ProjectSprintBurndown }

async function detail(boardId: string, sprintId: string): Promise<SprintDetail> {
  const response = await call('alice', 'GET', `/boards/${boardId}/sprints/${sprintId}`)
  expect(response.status).toBe(200)
  return response.json() as Promise<SprintDetail>
}

describe('project sprints', () => {
  it('refuses an interval whose end precedes its start', async () => {
    const board = await createBoard()
    expect((await call('alice', 'POST', `/boards/${board.id}/sprints`, {
      name: 'Bad', startAt: 100, endAt: 50,
    })).status).toBe(400)
  })

  it('owns cards through an edge and computes the burndown from them', async () => {
    const board = await createBoard()
    const sprint = await createSprint(board.id)
    const card = await createCard('alice', board.id)
    expect((await detail(board.id, sprint.id)).burndown.total).toBe(0)
    expect((await call('alice', 'PUT', `/boards/${board.id}/sprints/${sprint.id}/cards/${card.id}`)).status).toBe(200)
    const loaded = await detail(board.id, sprint.id)
    expect(loaded.cards.map((entry) => entry.id)).toEqual([card.id])
    expect(loaded.burndown.total).toBe(1)
    expect(loaded.burndown.remaining).toBe(1)
    expect((await call('alice', 'DELETE', `/boards/${board.id}/sprints/${sprint.id}/cards/${card.id}`)).status).toBe(200)
    expect((await detail(board.id, sprint.id)).cards).toEqual([])
  })

  it('refuses a card or sprint from another board', async () => {
    const board = await createBoard()
    const other = await createBoard()
    const sprint = await createSprint(board.id)
    const foreignCard = await createCard('alice', other.id)
    expect((await call('alice', 'PUT', `/boards/${board.id}/sprints/${sprint.id}/cards/${foreignCard.id}`)).status).toBe(404)
    expect((await call('alice', 'GET', `/boards/${other.id}/sprints/${sprint.id}`)).status).toBe(404)
  })

  it('patches status and keeps cards when a sprint is deleted', async () => {
    const board = await createBoard()
    const sprint = await createSprint(board.id)
    const card = await createCard('alice', board.id)
    await call('alice', 'PUT', `/boards/${board.id}/sprints/${sprint.id}/cards/${card.id}`)
    const patched = await call('alice', 'PATCH', `/boards/${board.id}/sprints/${sprint.id}`, { status: 'completed' })
    expect(((await patched.json()) as { sprint: ProjectSprint }).sprint.status).toBe('completed')
    expect((await call('alice', 'DELETE', `/boards/${board.id}/sprints/${sprint.id}`)).status).toBe(200)
    expect((await call('alice', 'GET', `/boards/${board.id}/sprints`, undefined)).status).toBe(200)
    const list = await (await call('alice', 'GET', `/boards/${board.id}/sprints`)).json() as { sprints: ProjectSprint[] }
    expect(list.sprints).toEqual([])
    const edges = sqlite.prepare('SELECT COUNT(*) AS count FROM project_sprint_cards').get() as { count: number }
    expect(edges.count).toBe(0)
    const cards = sqlite.prepare('SELECT COUNT(*) AS count FROM project_cards WHERE delete_at = 0').get() as { count: number }
    expect(cards.count).toBe(1)
  })

  it('refuses a viewer trying to change the iteration', async () => {
    const board = await createBoard()
    sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
      .run(board.id, 'bob', 'viewer')
    expect((await call('bob', 'POST', `/boards/${board.id}/sprints`, {
      name: 'x', startAt: 1, endAt: 2,
    })).status).toBe(403)
  })
})

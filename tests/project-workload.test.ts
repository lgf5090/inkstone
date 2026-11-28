// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '@shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectCard, ProjectWorkloadReport } from '@shared/project/model'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const app = createApp()
const tokens = new Map<string, string>()
let sqlite: DatabaseSync
let env: Env
const FROM = Date.UTC(2026, 10, 23)
const TO = FROM + 7 * 86_400_000
const personId = `p${'a'.repeat(26)}`
const peopleId = `p${'b'.repeat(26)}`
const estimateId = `p${'c'.repeat(26)}`

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
  sqlite.exec(`DELETE FROM project_time_entries; DELETE FROM project_card_values; DELETE FROM project_cards;
    DELETE FROM project_property_configs; DELETE FROM project_properties; DELETE FROM project_board_members; DELETE FROM project_boards`)
})

async function req(account: string, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${tokens.get(account)}` }
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
}

async function createBoard(title = 'Workload'): Promise<ProjectBoard> {
  const response = await req('alice', 'POST', '/boards', {
    title,
    cardProperties: [
      { id: personId, name: 'Owner', type: 'person', options: [] },
      { id: peopleId, name: 'Team', type: 'multiPerson', options: [] },
      { id: estimateId, name: 'Estimate', type: 'estimate', options: [] },
    ],
  })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { board: ProjectBoard }).board
}

async function createCard(boardId: string, title: string, values: Record<string, string>): Promise<ProjectCard> {
  const response = await req('alice', 'POST', `/boards/${boardId}/cards`, { title, values })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { card: ProjectCard }).card
}

function addTime(boardId: string, cardId: string, userId: string, startedAt: number, endedAt: number): void {
  sqlite.prepare(`INSERT INTO project_time_entries (id, board_id, card_id, user_id, note, started_at, ended_at, created_at)
    VALUES (?, ?, ?, ?, '', ?, ?, 1)`).run(`t${crypto.randomUUID()}`, boardId, cardId, userId, startedAt, endedAt)
}

describe('estimates and workload', () => {
  it('accepts numeric estimates and rejects invalid values', async () => {
    const board = await createBoard()
    const card = await createCard(board.id, 'Estimate', {})
    expect((await req('alice', 'PATCH', `/cards/${card.id}`, { values: { [estimateId]: '2.5' } })).status).toBe(200)
    expect((await req('alice', 'PATCH', `/cards/${card.id}`, { values: { [estimateId]: '-1' } })).status).toBe(400)
    expect((await req('alice', 'PATCH', `/cards/${card.id}`, { values: { [estimateId]: 'abc' } })).status).toBe(400)
  })

  it('aggregates estimates and clamped actual time across boards', async () => {
    const first = await createBoard('One')
    const second = await createBoard('Two')
    const aliceCard = await createCard(first.id, 'Alice card', { [personId]: 'alice', [estimateId]: '2' })
    const bobCard = await createCard(first.id, 'Bob card', { [peopleId]: '["bob","carol"]', [estimateId]: '3' })
    const crossBoard = await createCard(second.id, 'Cross board', { [personId]: 'alice', [estimateId]: '1' })
    addTime(first.id, aliceCard.id, 'alice', FROM - 60_000, FROM + 90 * 60_000)
    addTime(first.id, bobCard.id, 'bob', FROM + 60 * 60_000, FROM + 90 * 60_000)
    addTime(second.id, crossBoard.id, 'alice', TO - 30 * 60_000, TO + 30 * 60_000)
    sqlite.prepare('UPDATE users SET settings = ? WHERE id = ?').run('{"project":{"capacityMinutesPerWeek":1200}}', 'alice')

    const response = await req('alice', 'GET', `/workload?from=${FROM}&to=${TO}`)
    expect(response.status, await response.clone().text()).toBe(200)
    const report = (await response.json()) as ProjectWorkloadReport
    const alice = report.users.find((user) => user.userId === 'alice')
    const bob = report.users.find((user) => user.userId === 'bob')
    expect(alice).toMatchObject({ capacityMinutes: 1200, estimatedMinutes: 180, actualMinutes: 120, cardCount: 2 })
    expect(bob).toMatchObject({ capacityMinutes: 2400, estimatedMinutes: 180, actualMinutes: 30, cardCount: 1 })
    expect(report.cards.find((card) => card.cardId === aliceCard.id)).toMatchObject({ estimateMinutes: 120, actualMinutes: 90 })
    expect(report.cards.find((card) => card.cardId === bobCard.id)?.assigneeIds).toEqual(['bob', 'carol'])
  })

  it('does not reveal estimates hidden from the reader', async () => {
    const board = await createBoard()
    await createCard(board.id, 'Hidden estimate', { [personId]: 'bob', [estimateId]: '5' })
    sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
      .run(board.id, 'bob', 'viewer')
    sqlite.prepare(`INSERT INTO project_property_configs (board_id, property_id, config, updated_at) VALUES (?, ?, ?, 1)
      ON CONFLICT(board_id, property_id) DO UPDATE SET config = excluded.config`)
      .run(board.id, estimateId, JSON.stringify({ viewRoles: ['admin'] }))
    const response = await req('bob', 'GET', `/workload?from=${FROM}&to=${TO}`)
    expect(response.status).toBe(200)
    const report = (await response.json()) as ProjectWorkloadReport
    expect(report.cards.find((card) => card.title === 'Hidden estimate')?.estimateMinutes).toBe(0)
  })
})

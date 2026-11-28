// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectCard } from '../src/shared/project/model'
import { projectDayToStamp, projectStampToDay } from '../src/shared/project/date'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'
import { SCHEMA_MIGRATIONS } from '../src/worker/db/schema'

const app = createApp()
let token: string
let sqlite: DatabaseSync
let env: Env

const id = (prefix: string): string => prefix + 'a'.repeat(26)
const STATUS = id('p')
const DATE = id('q')
const OPEN = id('o')
const DONE = id('r')

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite))
  await app.fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  sqlite.prepare(`INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at) VALUES ('alice', 'alice', 'hash', 'alice', 'alice', 'member', ?, ?)`).run(now, now)
  token = await createSession(env.DB, 'alice')
})

beforeEach(() => {
  sqlite.exec(`DELETE FROM project_properties; DELETE FROM project_board_members; DELETE FROM project_boards; DELETE FROM project_cards; DELETE FROM project_card_values`)
})

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${token}` }
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
}

async function boardWithProperties(): Promise<ProjectBoard> {
  const response = await req('POST', '/boards', {
    title: 'Recurring',
    cardProperties: [
      { id: STATUS, name: 'Status', type: 'select', options: [{ id: OPEN, value: 'Open', color: '', category: 'todo' }, { id: DONE, value: 'Done', color: '', category: 'done' }] },
      { id: DATE, name: 'Due', type: 'date', options: [] },
    ],
  })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { board: ProjectBoard }).board
}

async function createCard(boardId: string, values: Record<string, string>, recurrence: unknown): Promise<ProjectCard> {
  const response = await req('POST', `/boards/${boardId}/cards`, { title: 'Standup', values, recurrence })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { card: ProjectCard }).card
}

async function cards(boardId: string): Promise<ProjectCard[]> {
  const response = await req('GET', `/boards/${boardId}/bundle`)
  return ((await response.json()) as { cards: ProjectCard[] }).cards
}

describe('completing a recurring card', () => {
  it('installs a unique source constraint on existing card tables', () => {
    const legacy = new DatabaseSync(':memory:')
    legacy.exec('CREATE TABLE project_cards (id TEXT PRIMARY KEY)')
    const migration = SCHEMA_MIGRATIONS.find((entry) => entry.version === 455)
    expect(migration).toBeDefined()
    for (const statement of migration!.statements) legacy.exec(statement)
    legacy.prepare('INSERT INTO project_cards (id, recurrence_source_id) VALUES (?, ?)').run('c1', 'source')
    expect(() => legacy.prepare('INSERT INTO project_cards (id, recurrence_source_id) VALUES (?, ?)').run('c2', 'source')).toThrow()
    legacy.prepare('INSERT INTO project_cards (id, recurrence_source_id) VALUES (?, NULL)').run('c3')
    legacy.prepare('INSERT INTO project_cards (id, recurrence_source_id) VALUES (?, NULL)').run('c4')
    legacy.close()
  })

  it('spawns the next instance with the date advanced and the tick reset', async () => {
    const board = await boardWithProperties()
    const start = projectDayToStamp(new Date(2026, 0, 30))
    const card = await createCard(board.id, { [STATUS]: OPEN, [DATE]: JSON.stringify({ from: start }) }, { freq: 'daily', interval: 1 })
    const complete = await req('PATCH', `/cards/${card.id}`, { values: { [STATUS]: DONE } })
    expect(complete.status, await complete.clone().text()).toBe(200)
    const all = await cards(board.id)
    expect(all).toHaveLength(2)
    const original = all.find((entry) => entry.id === card.id)!
    const next = all.find((entry) => entry.id !== card.id)!
    expect(original.values[STATUS]).toBe(DONE)
    expect(next.title).toBe('Standup')
    expect(next.values[STATUS]).toBe(OPEN)
    expect(next.recurrence).toMatchObject({ freq: 'daily', interval: 1 })
    expect(next.recurrence?.anchor).toBeTypeOf('number')
    const nextDate = JSON.parse(next.values[DATE]!) as { from: number }
    expect(projectStampToDay(nextDate.from).getDate()).toBe(31)
  })

  it('does not spawn for an ordinary card, and chains when the instance is completed', async () => {
    const board = await boardWithProperties()
    const plain = await createCard(board.id, { [STATUS]: OPEN }, null)
    await req('PATCH', `/cards/${plain.id}`, { values: { [STATUS]: DONE } })
    expect(await cards(board.id)).toHaveLength(1)

    const start = projectDayToStamp(new Date(2026, 0, 1))
    const recurring = await createCard(board.id, { [STATUS]: OPEN, [DATE]: JSON.stringify({ from: start }) }, { freq: 'weekly', interval: 1 })
    await req('PATCH', `/cards/${recurring.id}`, { values: { [STATUS]: DONE } })
    const afterFirst = await cards(board.id)
    const instance = afterFirst.find((entry) => entry.id !== recurring.id && entry.id !== plain.id)!
    await req('PATCH', `/cards/${instance.id}`, { values: { [STATUS]: DONE } })
    const afterSecond = await cards(board.id)
    expect(afterSecond.filter((entry) => entry.recurrence !== null && entry.recurrence !== undefined)).toHaveLength(3)
    expect(afterSecond.filter((entry) => entry.id === plain.id)).toHaveLength(1)
  })

  it('spawns at most one next instance across concurrent completion and reopen cycles', async () => {
    const board = await boardWithProperties()
    const start = projectDayToStamp(new Date(2026, 0, 1))
    const card = await createCard(board.id, { [STATUS]: OPEN, [DATE]: JSON.stringify({ from: start }) }, { freq: 'daily', interval: 1 })
    const complete = () => req('PATCH', `/cards/${card.id}`, { values: { [STATUS]: DONE } })
    const responses = await Promise.all([complete(), complete()])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(await cards(board.id)).toHaveLength(2)
    expect((await req('PATCH', `/cards/${card.id}`, { values: { [STATUS]: OPEN } })).status).toBe(200)
    expect((await complete()).status).toBe(200)
    expect(await cards(board.id)).toHaveLength(2)
    expect(sqlite.prepare('SELECT recurrence_source_id FROM project_cards WHERE id <> ?').all(card.id)).toEqual([{ recurrence_source_id: card.id }])
  })

  it('does not treat an incomplete label or an arbitrary checkbox as completion', async () => {
    const incomplete = id('o')
    const response = await req('POST', '/boards', {
      title: 'Explicit status',
      cardProperties: [{ id: STATUS, name: 'Status', type: 'select', options: [{ id: incomplete, value: 'Incomplete', color: '', category: 'todo' }] }],
    })
    const board = ((await response.json()) as { board: ProjectBoard }).board
    const card = await createCard(board.id, { [STATUS]: incomplete }, { freq: 'daily', interval: 1 })
    expect((await req('PATCH', `/cards/${card.id}`, { values: { [STATUS]: incomplete } })).status).toBe(200)
    expect(await cards(board.id)).toHaveLength(1)

    const checkbox = id('p')
    const checkboxResponse = await req('POST', '/boards', {
      title: 'Checklist',
      cardProperties: [{ id: checkbox, name: 'Checked', type: 'checkbox', options: [] }],
    })
    const checkboxBoard = ((await checkboxResponse.json()) as { board: ProjectBoard }).board
    const checkboxCard = await createCard(checkboxBoard.id, { [checkbox]: 'false' }, { freq: 'daily', interval: 1 })
    expect((await req('PATCH', `/cards/${checkboxCard.id}`, { values: { [checkbox]: 'true' } })).status).toBe(200)
    expect(await cards(checkboxBoard.id)).toHaveLength(1)
  })

  it('keeps the original month-end day across a chain of spawned instances', async () => {
    const board = await boardWithProperties()
    const start = projectDayToStamp(new Date(2026, 0, 31))
    const first = await createCard(board.id, { [STATUS]: OPEN, [DATE]: JSON.stringify({ from: start }) }, { freq: 'monthly', interval: 1 })
    await req('PATCH', `/cards/${first.id}`, { values: { [STATUS]: DONE } })
    const afterFirst = await cards(board.id)
    const second = afterFirst.find((entry) => entry.id !== first.id)!
    const secondDate = JSON.parse(second.values[DATE]!) as { from: number }
    expect(projectStampToDay(secondDate.from).getDate()).toBe(28)
    await req('PATCH', `/cards/${second.id}`, { values: { [STATUS]: DONE } })
    const afterSecond = await cards(board.id)
    const third = afterSecond.find((entry) => entry.id !== first.id && entry.id !== second.id)!
    const thirdDate = JSON.parse(third.values[DATE]!) as { from: number }
    expect(projectStampToDay(thirdDate.from).getDate()).toBe(31)
    expect(third.recurrence?.anchor).toBe(second.recurrence?.anchor)
  })
})
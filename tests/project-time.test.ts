// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectCard, ProjectTimeEntry } from '../src/shared/project/model'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'
import { SCHEMA_MIGRATIONS } from '../src/worker/db/schema'

const app = createApp()
let sqlite: DatabaseSync
let env: Env
const tokens = new Map<string, string>()

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
  sqlite.exec(`DELETE FROM project_time_entries; DELETE FROM project_card_values; DELETE FROM project_cards;
    DELETE FROM project_properties; DELETE FROM project_board_members; DELETE FROM project_boards`)
})

async function req(account: string, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${tokens.get(account)}` }
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
}

async function boardWithCard(): Promise<{ board: ProjectBoard, card: ProjectCard }> {
  const created = await req('alice', 'POST', '/boards', { title: 'Time' })
  const board = ((await created.json()) as { board: ProjectBoard }).board
  sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
    .run(board.id, 'bob', 'viewer')
  const card = ((await (await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'Work' })).json()) as { card: ProjectCard }).card
  return { board, card }
}

describe('time tracking', () => {
  it('migration 442 closes duplicate running timers before adding the unique index', () => {
    const legacy = new DatabaseSync(':memory:')
    legacy.exec('CREATE TABLE project_time_entries (id TEXT PRIMARY KEY, card_id TEXT, user_id TEXT, started_at INTEGER, ended_at INTEGER)')
    legacy.prepare('INSERT INTO project_time_entries VALUES (?, ?, ?, ?, NULL)').run('old', 'card', 'alice', 1)
    legacy.prepare('INSERT INTO project_time_entries VALUES (?, ?, ?, ?, NULL)').run('new', 'card', 'alice', 2)
    const migration = SCHEMA_MIGRATIONS.find((entry) => entry.version === 442)
    expect(migration).toBeDefined()
    for (const statement of migration!.statements) legacy.exec(statement)
    expect(legacy.prepare('SELECT id, ended_at FROM project_time_entries ORDER BY id').all()).toEqual([
      { id: 'new', ended_at: null }, { id: 'old', ended_at: 1 },
    ])
    expect(() => legacy.prepare('INSERT INTO project_time_entries VALUES (?, ?, ?, ?, NULL)').run('third', 'card', 'alice', 3)).toThrow()
    legacy.close()
  })

  it('starts once, stops the same interval and lists it', async () => {
    const { card } = await boardWithCard()
    const started = await req('alice', 'POST', `/cards/${card.id}/time/start`)
    expect(started.status, await started.clone().text()).toBe(201)
    const entry = ((await started.json()) as { entry: ProjectTimeEntry }).entry
    expect(entry.endedAt).toBeNull()
    expect((await req('alice', 'POST', `/cards/${card.id}/time/start`)).status).toBe(409)

    const stopped = await req('alice', 'POST', `/cards/${card.id}/time/stop`)
    expect(stopped.status, await stopped.clone().text()).toBe(200)
    const closed = ((await stopped.json()) as { entry: ProjectTimeEntry }).entry
    expect(closed.id).toBe(entry.id)
    expect(closed.endedAt).not.toBeNull()

    const listed = ((await (await req('alice', 'GET', `/cards/${card.id}/time`)).json()) as { entries: ProjectTimeEntry[] }).entries
    expect(listed).toHaveLength(1)
    expect(listed[0]!.endedAt).toBe(closed.endedAt)
    expect((await req('alice', 'POST', `/cards/${card.id}/time/stop`)).status).toBe(200)
  })

  it('rejects a concurrent second start through the database constraint', async () => {
    const { card } = await boardWithCard()
    const responses = await Promise.all([
      req('alice', 'POST', `/cards/${card.id}/time/start`),
      req('alice', 'POST', `/cards/${card.id}/time/start`),
    ])
    expect(responses.map((response) => response.status).toSorted()).toEqual([201, 409])
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM project_time_entries WHERE card_id = ? AND ended_at IS NULL').get(card.id)).toMatchObject({ count: 1 })
  })

  it('returns every entry so the displayed total is not capped at 200', async () => {
    const { card } = await boardWithCard()
    const insert = sqlite.prepare(`INSERT INTO project_time_entries (id, board_id, card_id, user_id, note, started_at, ended_at, created_at)
      VALUES (?, ?, ?, 'alice', '', ?, ?, 1)`)
    for (let index = 0; index < 205; index += 1) insert.run(`t${index}`, card.boardId, card.id, index * 1000, index * 1000 + 500)
    const listed = ((await (await req('alice', 'GET', `/cards/${card.id}/time`)).json()) as { entries: ProjectTimeEntry[] }).entries
    expect(listed).toHaveLength(205)
    expect(listed.reduce((sum, entry) => sum + entry.endedAt! - entry.startedAt, 0)).toBe(205 * 500)
  })

  it('refuses a viewer and deletes an entry through the card route', async () => {
    const { card } = await boardWithCard()
    expect((await req('bob', 'POST', `/cards/${card.id}/time/start`)).status).toBe(403)
    const started = ((await (await req('alice', 'POST', `/cards/${card.id}/time/start`)).json()) as { entry: ProjectTimeEntry }).entry
    expect((await req('alice', 'DELETE', `/cards/${card.id}/time/${started.id}`)).status).toBe(200)
    expect(((await (await req('alice', 'GET', `/cards/${card.id}/time`)).json()) as { entries: ProjectTimeEntry[] }).entries).toEqual([])
  })

  it('creates and edits manual entries with strict interval validation', async () => {
    const { card } = await boardWithCard()
    const startedAt = Date.UTC(2026, 10, 25, 9)
    const endedAt = startedAt + 90 * 60_000
    const created = await req('alice', 'POST', `/cards/${card.id}/time`, { note: 'Manual', startedAt, endedAt })
    expect(created.status, await created.clone().text()).toBe(201)
    const entry = ((await created.json()) as { entry: ProjectTimeEntry }).entry
    expect(entry).toMatchObject({ note: 'Manual', startedAt, endedAt, userId: 'alice' })
    const updated = await req('alice', 'PATCH', `/cards/${card.id}/time/${entry.id}`, { note: 'Edited', endedAt: endedAt + 30 * 60_000 })
    expect(updated.status).toBe(200)
    expect(((await updated.json()) as { entry: ProjectTimeEntry }).entry.endedAt).toBe(endedAt + 30 * 60_000)
    expect((await req('alice', 'PATCH', `/cards/${card.id}/time/${entry.id}`, { startedAt: endedAt, endedAt: startedAt })).status).toBe(400)
    expect((await req('bob', 'POST', `/cards/${card.id}/time`, { startedAt, endedAt })).status).toBe(403)
  })
})

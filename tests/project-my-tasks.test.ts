// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectCard } from '../src/shared/project/model'
import { projectDateValue } from '../src/shared/project/date'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const app = createApp()
let sqlite: DatabaseSync
let env: Env
const tokens = new Map<string, string>()

const pid = (n: number) => `p${String(n).padStart(26, '0')}`

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
  sqlite.exec(`DELETE FROM project_properties; DELETE FROM project_board_members; DELETE FROM project_boards;
    DELETE FROM project_cards; DELETE FROM project_card_values; DELETE FROM project_card_contents;
    DELETE FROM project_comments`)
})

async function req(account: string, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${tokens.get(account)}` }
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
}

async function createBoard(account: string, body: Record<string, unknown>): Promise<ProjectBoard> {
  const response = await req(account, 'POST', '/boards', body)
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { board: ProjectBoard }).board
}

async function createCard(account: string, boardId: string, body: Record<string, unknown>): Promise<ProjectCard> {
  const response = await req(account, 'POST', `/boards/${boardId}/cards`, body)
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { card: ProjectCard }).card
}

function dateValue(day: number): string {
  return JSON.stringify(projectDateValue(new Date(2026, 10, day), { timeZone: 'UTC' }))
}

function addMember(boardId: string, account: string): void {
  sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
    .run(boardId, account, 'editor')
}

describe('the cross-board task list', () => {
  it('keeps assigned cards the reader may see, drops the rest, and dates the earliest date', async () => {
    const board = await createBoard('alice', {
      title: 'Mine',
      cardProperties: [
        { id: pid(1), name: 'Owner', type: 'person', options: [] },
        { id: pid(2), name: 'Due', type: 'date', options: [] },
        { id: pid(3), name: 'Ship', type: 'date', options: [] },
      ],
    })
    addMember(board.id, 'bob')
    await createCard('alice', board.id, { title: 'Mine task', values: { [pid(1)]: 'bob', [pid(2)]: dateValue(20), [pid(3)]: dateValue(10) } })
    await createCard('alice', board.id, { title: 'Alice task', values: { [pid(1)]: 'alice', [pid(2)]: dateValue(1) } })

    const open = await createBoard('carol', {
      title: 'Open', type: 'O', minimumRole: 'viewer',
      cardProperties: [{ id: pid(4), name: 'Owner', type: 'person', options: [] }],
    })
    await createCard('carol', open.id, { title: 'Open task', values: { [pid(4)]: 'bob' } })

    const closed = await createBoard('carol', {
      title: 'Closed',
      cardProperties: [{ id: pid(5), name: 'Owner', type: 'person', options: [] }],
    })
    await createCard('carol', closed.id, { title: 'Closed task', values: { [pid(5)]: 'bob' } })

    const response = await req('bob', 'GET', '/my-tasks')
    expect(response.status, await response.clone().text()).toBe(200)
    const tasks = ((await response.json()) as { tasks: { cardId: string, boardId: string, title: string, dueAt: number | null }[] }).tasks
    expect(tasks.map((task) => task.title)).toEqual(['Mine task', 'Open task'])
    expect(tasks[0]!.dueAt).toBe(new Date(2026, 10, 10).getTime())
    expect(tasks[1]!.dueAt).toBeNull()
    expect(tasks.some((task) => task.boardId === closed.id)).toBe(false)
  })
})

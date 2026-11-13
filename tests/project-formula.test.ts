// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectBoardBundle, ProjectCard } from '../src/shared/project/model'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const app = createApp()
let sqlite: DatabaseSync
let env: Env
let token: string

const pid = (n: number) => `p${String(n).padStart(26, '0')}`

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite))
  await app.fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at)
     VALUES ('alice', 'alice', 'hash', 'alice', 'alice', 'member', ?, ?)`,
  ).run(now, now)
  token = await createSession(env.DB, 'alice')
})

beforeEach(() => {
  sqlite.exec(`DELETE FROM project_property_configs; DELETE FROM project_properties; DELETE FROM project_board_members;
    DELETE FROM project_boards; DELETE FROM project_cards; DELETE FROM project_card_values`)
})

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${token}` }
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
}

async function setup(): Promise<{ board: ProjectBoard, card: ProjectCard }> {
  const created = await req('POST', '/boards', {
    title: 'Math',
    cardProperties: [
      { id: pid(1), name: 'Price', type: 'number', options: [] },
      { id: pid(2), name: 'Qty', type: 'number', options: [] },
      { id: pid(3), name: 'Total', type: 'formula', options: [], config: { expression: '{Price} * {Qty}' } },
    ],
  })
  const board = ((await created.json()) as { board: ProjectBoard }).board
  const cardResponse = await req('POST', `/boards/${board.id}/cards`, { title: 'Order', values: { [pid(1)]: '10', [pid(2)]: '3' } })
  expect(cardResponse.status, await cardResponse.clone().text()).toBe(201)
  return { board, card: ((await cardResponse.json()) as { card: ProjectCard }).card }
}

describe('the formula property', () => {
  it('computes a value on read without storing one', async () => {
    const { board, card } = await setup()
    const response = await req('GET', `/boards/${board.id}/bundle`)
    expect(response.status, await response.clone().text()).toBe(200)
    const bundle = (await response.json()) as ProjectBoardBundle
    expect(bundle.cards.find((entry) => entry.id === card.id)!.values[pid(3)]).toBe('30')
    const stored = sqlite.prepare('SELECT COUNT(*) AS n FROM project_card_values WHERE card_id = ? AND property_id = ?').get(card.id, pid(3)) as { n: number }
    expect(stored.n).toBe(0)
  })

  it('refuses a write to the computed column', async () => {
    const { board, card } = await setup()
    expect((await req('PATCH', `/cards/${card.id}`, { values: { [pid(3)]: '999' } })).status).toBe(403)
    const bundle = (await (await req('GET', `/boards/${board.id}/bundle`)).json()) as ProjectBoardBundle
    expect(bundle.cards.find((entry) => entry.id === card.id)!.values[pid(3)]).toBe('30')
  })
})

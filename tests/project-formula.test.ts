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
  sqlite.exec(`DELETE FROM project_property_configs; DELETE FROM project_card_relations; DELETE FROM project_properties; DELETE FROM project_board_members;
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

  it('uses display inputs, evaluates dependencies first and exposes formula errors', async () => {
    const created = await req('POST', '/boards', {
      title: 'Dependencies',
      cardProperties: [
        { id: pid(4), name: 'Final', type: 'formula', options: [], config: { expression: '{Base} * 2 + {Status} + ({Due} - 1000)' } },
        { id: pid(5), name: 'Base', type: 'formula', options: [], config: { expression: '{Price} + 1' } },
        { id: pid(1), name: 'Price', type: 'number', options: [] },
        { id: pid(6), name: 'Status', type: 'select', options: [{ id: pid(7), value: '10', color: '' }] },
        { id: pid(8), name: 'Due', type: 'date', options: [] },
        { id: pid(9), name: 'Broken', type: 'formula', options: [], config: { expression: '{Missing}' } },
      ],
    })
    const board = ((await created.json()) as { board: ProjectBoard }).board
    const cardResponse = await req('POST', `/boards/${board.id}/cards`, {
      title: 'Computed',
      values: { [pid(1)]: '10', [pid(6)]: pid(7), [pid(8)]: JSON.stringify({ from: 1000 }) },
    })
    const card = ((await cardResponse.json()) as { card: ProjectCard }).card
    const bundle = (await (await req('GET', `/boards/${board.id}/bundle`)).json()) as ProjectBoardBundle
    const computed = bundle.cards.find((entry) => entry.id === card.id)!
    expect(computed.values[pid(4)]).toBe('32')
    expect(computed.values[pid(5)]).toBe('11')
    expect(computed.values[pid(9)]).toBe('')
    expect(computed.valueErrors?.[pid(9)]).toBe('unknown reference Missing')
    const csv = await req('GET', `/boards/${board.id}/csv`)
    expect(csv.status, await csv.clone().text()).toBe(200)
    expect(await csv.text()).toContain('#unknown reference Missing')
  })

  it('evaluates relation values before formulas and formulas before rollups', async () => {
    const boardId = 'b'.repeat(27)
    const created = await req('POST', '/boards', {
      id: boardId,
      title: 'Pipeline',
      cardProperties: [
        { id: pid(10), name: 'Links', type: 'relation', options: [], config: { targetBoardId: boardId } },
        { id: pid(11), name: 'Base', type: 'formula', options: [], config: { expression: '{Price} + 1' } },
        { id: pid(12), name: 'Has links', type: 'formula', options: [], config: { expression: 'IF({Links} == "", 0, 1)' } },
        { id: pid(13), name: 'Linked total', type: 'rollup', options: [], config: { rollup: { relationPropertyId: pid(10), targetPropertyId: pid(11), aggregation: 'sum' } } },
        { id: pid(14), name: 'Price', type: 'number', options: [] },
      ],
    })
    const board = ((await created.json()) as { board: ProjectBoard }).board
    const first = ((await (await req('POST', `/boards/${board.id}/cards`, { title: 'First', values: { [pid(14)]: '1' } })).json()) as { card: ProjectCard }).card
    const second = ((await (await req('POST', `/boards/${board.id}/cards`, { title: 'Second', values: { [pid(14)]: '10' } })).json()) as { card: ProjectCard }).card
    expect((await req('PATCH', `/cards/${first.id}`, { values: { [pid(10)]: JSON.stringify([second.id]) } })).status).toBe(200)
    sqlite.prepare('DELETE FROM project_card_values WHERE card_id = ? AND property_id = ?').run(first.id, pid(10))
    const bundle = (await (await req('GET', `/boards/${board.id}/bundle`)).json()) as ProjectBoardBundle
    const computed = bundle.cards.find((entry) => entry.id === first.id)!
    expect(computed.values[pid(10)]).toBe(JSON.stringify([second.id]))
    expect(computed.values[pid(11)]).toBe('2')
    expect(computed.values[pid(12)]).toBe('1')
    expect(computed.values[pid(13)]).toBe('11')
  })

  it('refuses a write to the computed column', async () => {
    const { board, card } = await setup()
    expect((await req('PATCH', `/cards/${card.id}`, { values: { [pid(3)]: '999' } })).status).toBe(403)
    const bundle = (await (await req('GET', `/boards/${board.id}/bundle`)).json()) as ProjectBoardBundle
    expect(bundle.cards.find((entry) => entry.id === card.id)!.values[pid(3)]).toBe('30')
  })
})

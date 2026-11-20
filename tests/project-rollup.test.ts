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
const tokens = new Map<string, string>()
const pid = (n: number) => `p${String(n).padStart(26, '0')}`
const amount = pid(1)
const relation = pid(2)
const total = pid(3)

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
  sqlite.exec(`DELETE FROM project_card_relations; DELETE FROM project_property_configs; DELETE FROM project_properties;
    DELETE FROM project_board_members; DELETE FROM project_boards; DELETE FROM project_cards; DELETE FROM project_card_values`)
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

async function createCard(account: string, boardId: string, values: Record<string, string>): Promise<ProjectCard> {
  const response = await req(account, 'POST', `/boards/${boardId}/cards`, { title: 'Linked', values })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { card: ProjectCard }).card
}

async function bundle(account: string, boardId: string): Promise<ProjectBoardBundle> {
  const response = await req(account, 'GET', `/boards/${boardId}/bundle`)
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json()) as ProjectBoardBundle
}

async function setup(aggregation = 'sum'): Promise<{ boardA: ProjectBoard, boardB: ProjectBoard, first: ProjectCard, second: ProjectCard, card: ProjectCard }> {
  const boardB = await createBoard('alice', {
    title: 'Amounts',
    cardProperties: [{ id: amount, name: 'Amount', type: 'number', options: [] }],
  })
  const first = await createCard('alice', boardB.id, { [amount]: '10' })
  const second = await createCard('alice', boardB.id, { [amount]: '20' })
  const boardA = await createBoard('alice', {
    title: 'Totals',
    cardProperties: [
      { id: relation, name: 'Items', type: 'relation', options: [], config: { targetBoardId: boardB.id, multiple: true } },
      { id: total, name: 'Total', type: 'rollup', options: [], config: { rollup: { relationPropertyId: relation, targetPropertyId: amount, aggregation } } },
    ],
  })
  sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
    .run(boardA.id, 'bob', 'editor')
  const card = await createCard('alice', boardA.id, { [relation]: JSON.stringify([first.id, second.id]) })
  return { boardA, boardB, first, second, card }
}

describe('the rollup property', () => {
  it('aggregates the values of related cards on read without storing one', async () => {
    const { boardA, card } = await setup()
    const read = await bundle('alice', boardA.id)
    expect(read.cards.find((entry) => entry.id === card.id)!.values[total]).toBe('30')
    const stored = sqlite.prepare('SELECT COUNT(*) AS n FROM project_card_values WHERE card_id = ? AND property_id = ?').get(card.id, total) as { n: number }
    expect(stored.n).toBe(0)
  })

  it('counts related cards and refuses a write to the computed column', async () => {
    const { boardA, card } = await setup('count')
    const read = await bundle('alice', boardA.id)
    expect(read.cards.find((entry) => entry.id === card.id)!.values[total]).toBe('2')
    expect((await req('alice', 'PATCH', `/cards/${card.id}`, { values: { [total]: '999' } })).status).toBe(403)
  })

  it('leaves a rollup that references a missing relation property empty', async () => {
    const missing = pid(8)
    const rollup = pid(9)
    const board = await createBoard('alice', {
      title: 'Broken',
      cardProperties: [{ id: rollup, name: 'Broken', type: 'rollup', options: [], config: { rollup: { relationPropertyId: missing, targetPropertyId: amount, aggregation: 'sum' } } }],
    })
    const card = await createCard('alice', board.id, {})
    const read = await bundle('alice', board.id)
    expect(read.cards.find((entry) => entry.id === card.id)!.values[rollup]).toBe('')
  })

  it('refuses to evaluate a rollup that references itself', async () => {
    const selfRelation = pid(4)
    const selfRollup = pid(5)
    const boardB = await createBoard('alice', { title: 'Amounts' })
    const first = await createCard('alice', boardB.id, {})
    const board = await createBoard('alice', {
      title: 'Cycle',
      cardProperties: [
        { id: selfRelation, name: 'Items', type: 'relation', options: [], config: { targetBoardId: boardB.id } },
        { id: selfRollup, name: 'Self', type: 'rollup', options: [], config: { rollup: { relationPropertyId: selfRelation, targetPropertyId: selfRollup, aggregation: 'sum' } } },
      ],
    })
    const card = await createCard('alice', board.id, { [selfRelation]: JSON.stringify([first.id]) })
    const read = await bundle('alice', board.id)
    expect(read.cards.find((entry) => entry.id === card.id)!.values[selfRollup]).toBe('')
  })

  it('blanks the rollup for a reader who cannot see the target board', async () => {
    const { boardA, card } = await setup()
    expect((await bundle('alice', boardA.id)).cards.find((entry) => entry.id === card.id)!.values[total]).toBe('30')
    const read = await bundle('bob', boardA.id)
    expect(read.cards.find((entry) => entry.id === card.id)!.values[total]).toBe('')
  })
})

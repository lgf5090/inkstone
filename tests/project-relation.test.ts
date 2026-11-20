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

async function reqZip(account: string, path: string, bytes: Uint8Array): Promise<Response> {
  return app.fetch(new Request(`http://localhost/api/project${path}`, {
    method: 'POST',
    headers: { Cookie: `${LEGACY_SESSION_COOKIE}=${tokens.get(account)}`, [CLIENT_HEADER]: '1', 'Content-Type': 'application/zip' },
    body: bytes as BodyInit,
  }), env)
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

async function setup(): Promise<{ boardA: ProjectBoard, boardB: ProjectBoard, relationId: string, target: ProjectCard }> {
  const boardB = await createBoard('alice', { title: 'Targets' })
  const target = await createCard('alice', boardB.id, {})
  const boardA = await createBoard('alice', { title: 'Sources' })
  const relationId = pid(1)
  const patched = await req('alice', 'PATCH', `/boards/${boardA.id}`, {
    updatedCardProperties: [{ id: relationId, name: 'Link', type: 'relation', options: [], config: { targetBoardId: boardB.id } }],
  })
  expect(patched.status, await patched.clone().text()).toBe(200)
  sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
    .run(boardA.id, 'bob', 'editor')
  return { boardA, boardB, relationId, target }
}

function relationRows(): { from_card_id: string, to_card_id: string, property_id: string }[] {
  return sqlite.prepare('SELECT from_card_id, to_card_id, property_id FROM project_card_relations').all() as { from_card_id: string, to_card_id: string, property_id: string }[]
}

describe('the relation property', () => {
  it('writes a relation value and its edge, then reads the value back from the bundle', async () => {
    const { boardA, relationId, target } = await setup()
    const card = await createCard('alice', boardA.id, { [relationId]: JSON.stringify([target.id]) })
    expect(relationRows()).toHaveLength(1)
    expect(relationRows()[0]).toMatchObject({ from_card_id: card.id, to_card_id: target.id, property_id: relationId })
    const read = await bundle('alice', boardA.id)
    expect(read.cards.find((entry) => entry.id === card.id)!.values[relationId]).toBe(JSON.stringify([target.id]))
  })

  it('answers a reverse lookup with the referring card', async () => {
    const { boardA, relationId, target } = await setup()
    const card = await createCard('alice', boardA.id, { [relationId]: JSON.stringify([target.id]) })
    const response = await req('alice', 'GET', `/cards/${target.id}/relations`)
    expect(response.status, await response.clone().text()).toBe(200)
    const body = (await response.json()) as { references: { fromCardId: string, title: string | null, visible: boolean }[] }
    expect(body.references).toHaveLength(1)
    expect(body.references[0]).toMatchObject({ fromCardId: card.id, title: 'Linked', visible: true })
  })

  it('returns a null placeholder and no target titles when the target board is hidden', async () => {
    const { boardA, boardB, relationId, target } = await setup()
    await createCard('alice', boardA.id, { [relationId]: JSON.stringify([target.id]) })
    const options = await req('bob', 'GET', `/boards/${boardB.id}/relation-cards`)
    expect(options.status, await options.clone().text()).toBe(200)
    expect((await options.json()) as { cards: unknown }).toEqual({ cards: null })
    const read = await bundle('bob', boardA.id)
    expect(read.cards.every((card) => card.values[relationId] === '')).toBe(true)
  })

  it('refuses a relation write that points at a hidden board', async () => {
    const { boardA, boardB, relationId, target } = await setup()
    const response = await req('bob', 'POST', `/boards/${boardA.id}/cards`, {
      title: 'Nope', values: { [relationId]: JSON.stringify([target.id]) },
    })
    expect(response.status).toBe(400)
    expect(boardB.id).toBeTruthy()
    expect(relationRows()).toHaveLength(0)
  })

  it('clears relation edges when a card is deleted', async () => {
    const { boardA, relationId, target } = await setup()
    const card = await createCard('alice', boardA.id, { [relationId]: JSON.stringify([target.id]) })
    expect((await req('alice', 'DELETE', `/cards/${card.id}`)).status).toBe(200)
    expect(relationRows()).toHaveLength(0)
  })

  it('clears relation edges when the property is deleted', async () => {
    const { boardA, relationId, target } = await setup()
    await createCard('alice', boardA.id, { [relationId]: JSON.stringify([target.id]) })
    const response = await req('alice', 'PATCH', `/boards/${boardA.id}`, { deletedCardProperties: [relationId] })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(relationRows()).toHaveLength(0)
  })

  it('restores relation edges after an archive round trip', async () => {
    const board = await createBoard('alice', { title: 'Self' })
    const relationId = pid(1)
    const patched = await req('alice', 'PATCH', `/boards/${board.id}`, {
      updatedCardProperties: [{ id: relationId, name: 'Peer', type: 'relation', options: [], config: { targetBoardId: board.id } }],
    })
    expect(patched.status, await patched.clone().text()).toBe(200)
    const first = await createCard('alice', board.id, {})
    const second = await createCard('alice', board.id, { [relationId]: JSON.stringify([first.id]) })
    expect(relationRows()).toHaveLength(1)
    const exported = await req('alice', 'GET', `/boards/${board.id}/archive`)
    expect(exported.status, await exported.clone().text()).toBe(200)
    const bytes = new Uint8Array(await exported.arrayBuffer())
    sqlite.exec(`DELETE FROM project_card_relations; DELETE FROM project_property_configs; DELETE FROM project_properties;
      DELETE FROM project_board_members; DELETE FROM project_boards; DELETE FROM project_cards; DELETE FROM project_card_values`)
    const imported = await reqZip('alice', '/boards/import', bytes)
    expect(imported.status, await imported.clone().text()).toBe(201)
    expect(relationRows()).toHaveLength(1)
    expect(relationRows()[0]).toMatchObject({ from_card_id: second.id, to_card_id: first.id })
  })
})

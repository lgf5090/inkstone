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
  for (const account of ['alice', 'bob', 'carol']) {
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at)
       VALUES (?, ?, 'hash', ?, ?, 'member', ?, ?)`,
    ).run(account, account, account, account, now, now)
    tokens.set(account, await createSession(env.DB, account))
  }
})

beforeEach(() => {
  sqlite.exec(`DELETE FROM project_property_configs; DELETE FROM project_properties; DELETE FROM project_board_members;
    DELETE FROM project_boards; DELETE FROM project_cards; DELETE FROM project_card_values`)
})

async function req(account: string, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${tokens.get(account)}` }
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
}

async function setup(): Promise<{ board: ProjectBoard, card: ProjectCard }> {
  const created = await req('alice', 'POST', '/boards', {
    title: 'Secrets',
    cardProperties: [
      { id: pid(1), name: 'Public', type: 'text', options: [] },
      {
        id: pid(2), name: 'Salary', type: 'number', options: [],
        config: { viewRoles: ['admin'], editRoles: ['admin'] },
      },
    ],
  })
  const board = ((await created.json()) as { board: ProjectBoard }).board
  for (const [user, role] of [['bob', 'editor'], ['carol', 'viewer']] as const) {
    sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
      .run(board.id, user, role)
  }
  const cardResponse = await req('alice', 'POST', `/boards/${board.id}/cards`, {
    title: 'Offer', values: { [pid(1)]: 'visible', [pid(2)]: '100' },
  })
  expect(cardResponse.status, await cardResponse.clone().text()).toBe(201)
  const card = ((await cardResponse.json()) as { card: ProjectCard }).card
  return { board, card }
}

async function bundle(account: string, boardId: string): Promise<ProjectBoardBundle> {
  const response = await req(account, 'GET', `/boards/${boardId}/bundle`)
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json()) as ProjectBoardBundle
}

describe('field-level permissions', () => {
  it('drops a property and its values from a reader the property hides from', async () => {
    const { board, card } = await setup()
    const asAdmin = await bundle('alice', board.id)
    expect(asAdmin.properties.map((property) => property.id)).toContain(pid(2))
    expect(asAdmin.cards.find((entry) => entry.id === card.id)!.values[pid(2)]).toBe('100')

    const asEditor = await bundle('bob', board.id)
    expect(asEditor.properties.map((property) => property.id)).toEqual([pid(1)])
    expect(asEditor.cards.find((entry) => entry.id === card.id)!.values).toEqual({ [pid(1)]: 'visible' })

    const asViewer = await bundle('carol', board.id)
    expect(asViewer.properties.map((property) => property.id)).toEqual([pid(1)])
  })

  it('refuses a write to a property the role may not edit, through one card and through a batch', async () => {
    const { board, card } = await setup()
    expect((await req('bob', 'PATCH', `/cards/${card.id}`, { values: { [pid(1)]: 'edited' } })).status).toBe(200)
    expect((await req('bob', 'PATCH', `/cards/${card.id}`, { values: { [pid(2)]: '200' } })).status).toBe(403)
    expect((await req('bob', 'PATCH', `/boards/${board.id}/batch`, { cards: [{ id: card.id, patch: { values: { [pid(2)]: '300' } } }] })).status).toBe(403)
    expect((await req('alice', 'PATCH', `/cards/${card.id}`, { values: { [pid(2)]: '400' } })).status).toBe(200)
    expect((await bundle('alice', board.id)).cards.find((entry) => entry.id === card.id)!.values[pid(2)]).toBe('400')
  })
})

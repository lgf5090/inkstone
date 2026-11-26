// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectBoardBundle, ProjectCard, ProjectProperty } from '../src/shared/project/model'
import type { ProjectAutomation } from '../src/shared/project/automation'
import { runProjectAutomations } from '../src/worker/project/automations'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const app = createApp()
let sqlite: DatabaseSync
let env: Env
const tokens = new Map<string, string>()
const pid = (n: number) => `p${String(n).padStart(26, '0')}`
const status = pid(1)
const result = pid(2)

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
  sqlite.exec(`DELETE FROM project_automations; DELETE FROM chat_notifications; DELETE FROM project_card_relations;
    DELETE FROM project_property_configs; DELETE FROM project_properties; DELETE FROM project_board_members;
    DELETE FROM project_boards; DELETE FROM project_cards; DELETE FROM project_card_values`)
})

async function req(account: string, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${tokens.get(account)}` }
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
}

async function createBoard(): Promise<{ board: ProjectBoard, card: ProjectCard }> {
  const response = await req('alice', 'POST', '/boards', {
    title: 'Flow',
    cardProperties: [
      { id: status, name: 'Status', type: 'text', options: [] },
      { id: result, name: 'Result', type: 'text', options: [] },
    ],
  })
  expect(response.status, await response.clone().text()).toBe(201)
  const board = ((await response.json()) as { board: ProjectBoard }).board
  sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
    .run(board.id, 'bob', 'editor')
  const cardResponse = await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'Task', values: {} })
  expect(cardResponse.status, await cardResponse.clone().text()).toBe(201)
  return { board, card: ((await cardResponse.json()) as { card: ProjectCard }).card }
}

async function bundle(account: string, boardId: string): Promise<ProjectBoardBundle> {
  const response = await req(account, 'GET', `/boards/${boardId}/bundle`)
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json()) as ProjectBoardBundle
}

async function createRule(boardId: string, overrides: Record<string, unknown> = {}, account = 'alice'): Promise<ProjectAutomation> {
  const response = await req(account, 'POST', `/boards/${boardId}/automations`, {
    trigger: { type: 'cardValueChanged' },
    condition: { propertyId: status, op: 'equals', value: 'go' },
    action: { type: 'setValue', propertyId: result, value: 'done' },
    enabled: true,
    ...overrides,
  })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { automation: ProjectAutomation }).automation
}

describe('project automations', () => {
  it('runs a matching rule after a card value write', async () => {
    const { board, card } = await createBoard()
    await createRule(board.id)
    const response = await req('alice', 'PATCH', `/cards/${card.id}`, { values: { [status]: 'go' } })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(((await response.json()) as { card: ProjectCard }).card.values[result]).toBe('done')
    const read = await bundle('alice', board.id)
    expect(read.cards.find((entry) => entry.id === card.id)!.values[result]).toBe('done')
  })

  it('skips a rule whose condition does not match', async () => {
    const { board, card } = await createBoard()
    await createRule(board.id)
    await req('alice', 'PATCH', `/cards/${card.id}`, { values: { [status]: 'stop' } })
    const read = await bundle('alice', board.id)
    expect(read.cards.find((entry) => entry.id === card.id)!.values[result] ?? '').toBe('')
  })

  it('does not fire a disabled rule', async () => {
    const { board, card } = await createBoard()
    const rule = await createRule(board.id, { enabled: false })
    await req('alice', 'PATCH', `/cards/${card.id}`, { values: { [status]: 'go' } })
    expect((await bundle('alice', board.id)).cards.find((entry) => entry.id === card.id)!.values[result] ?? '').toBe('')
    const enabled = await req('alice', 'PATCH', `/boards/${board.id}/automations/${rule.id}`, { enabled: true })
    expect(enabled.status, await enabled.clone().text()).toBe(200)
    await req('alice', 'PATCH', `/cards/${card.id}`, { values: { [status]: 'again' } })
    expect((await bundle('alice', board.id)).cards.find((entry) => entry.id === card.id)!.values[result] ?? '').toBe('')
  })

  it('re-checks the rule creator field permission at execution time', async () => {
    const { board, card } = await createBoard()
    sqlite.prepare('UPDATE project_board_members SET role = ? WHERE board_id = ? AND user_id = ?').run('admin', board.id, 'bob')
    await createRule(board.id, {}, 'bob')
    sqlite.prepare('UPDATE project_board_members SET role = ? WHERE board_id = ? AND user_id = ?').run('editor', board.id, 'bob')
    sqlite.prepare(`INSERT INTO project_property_configs (board_id, property_id, config, updated_at) VALUES (?, ?, ?, 1)
      ON CONFLICT(board_id, property_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`)
      .run(board.id, result, JSON.stringify({ editRoles: ['admin'] }))
    const response = await req('alice', 'PATCH', `/cards/${card.id}`, { values: { [status]: 'go' } })
    expect(response.status, await response.clone().text()).toBe(200)
    expect((await bundle('alice', board.id)).cards.find((entry) => entry.id === card.id)!.values[result] ?? '').toBe('')
  })

  it('writes relation values and their edges through the normal card pipeline', async () => {
    const boardId = 'b'.repeat(27)
    const relation = pid(3)
    const created = await req('alice', 'POST', '/boards', {
      id: boardId,
      title: 'Relations',
      cardProperties: [
        { id: status, name: 'Status', type: 'text', options: [] },
        { id: relation, name: 'Related', type: 'relation', options: [], config: { targetBoardId: boardId } },
      ],
    })
    const board = ((await created.json()) as { board: ProjectBoard }).board
    const source = ((await (await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'Source' })).json()) as { card: ProjectCard }).card
    const target = ((await (await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'Target' })).json()) as { card: ProjectCard }).card
    await createRule(board.id, { action: { type: 'setValue', propertyId: relation, value: JSON.stringify([target.id]) } })
    const response = await req('alice', 'PATCH', `/cards/${source.id}`, { values: { [status]: 'go' } })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(((await response.json()) as { card: ProjectCard }).card.values[relation]).toBe(JSON.stringify([target.id]))
    expect(sqlite.prepare('SELECT from_card_id, to_card_id, property_id FROM project_card_relations').all())
      .toEqual([{ from_card_id: source.id, to_card_id: target.id, property_id: relation }])
  })

  it('runs completion and recurrence effects when an automation changes status', async () => {
    const done = pid(4)
    const open = pid(5)
    const trigger = pid(6)
    const created = await req('alice', 'POST', '/boards', {
      title: 'Recurring automation',
      cardProperties: [
        { id: status, name: 'Status', type: 'select', options: [{ id: open, value: 'Open', color: '', category: 'todo' }, { id: done, value: 'Done', color: '', category: 'done' }] },
        { id: trigger, name: 'Trigger', type: 'text', options: [] },
      ],
    })
    const board = ((await created.json()) as { board: ProjectBoard }).board
    const card = ((await (await req('alice', 'POST', `/boards/${board.id}/cards`, {
      title: 'Repeat', values: { [status]: open }, recurrence: { freq: 'daily', interval: 1 },
    })).json()) as { card: ProjectCard }).card
    await createRule(board.id, {
      condition: { propertyId: trigger, op: 'equals', value: 'go' },
      action: { type: 'setValue', propertyId: status, value: done },
    })
    const response = await req('alice', 'PATCH', `/cards/${card.id}`, { values: { [trigger]: 'go' } })
    expect(response.status, await response.clone().text()).toBe(200)
    const fresh = ((await response.json()) as { card: ProjectCard }).card
    expect(fresh.values[status]).toBe(done)
    expect(fresh.completedAt).toBeTypeOf('number')
    expect((await bundle('alice', board.id)).cards).toHaveLength(2)
  })

  it('limits rule writes to admins but lets a viewer list them', async () => {
    const { board } = await createBoard()
    const body = { trigger: { type: 'cardValueChanged' }, condition: null, action: { type: 'notify', message: 'hello' }, enabled: true }
    expect((await req('bob', 'POST', `/boards/${board.id}/automations`, body)).status).toBe(403)
    expect((await req('bob', 'GET', `/boards/${board.id}/automations`)).status).toBe(200)
    expect((await req('alice', 'POST', `/boards/${board.id}/automations`, body)).status).toBe(201)
    const listed = await req('bob', 'GET', `/boards/${board.id}/automations`)
    expect((await listed.json()) as { automations: ProjectAutomation[] }).toMatchObject({ automations: [expect.objectContaining({ enabled: true })] })
  })

  it('runs one rule only once per card write', async () => {
    const { board, card } = await createBoard()
    const response = await req('alice', 'POST', `/boards/${board.id}/automations`, {
      trigger: { type: 'cardValueChanged' },
      condition: null,
      action: { type: 'notify', message: 'fired' },
      enabled: true,
    })
    expect(response.status, await response.clone().text()).toBe(201)
    const properties = [
      { id: status, name: 'Status', type: 'text', options: [] },
      { id: result, name: 'Result', type: 'text', options: [] },
    ] as ProjectProperty[]
    const before: ProjectCard = { ...card, values: { [status]: 'a' } }
    const after: ProjectCard = { ...card, values: { [status]: 'go' } }
    const seen = new Set<string>()
    const now = 777
    await runProjectAutomations(env.DB, env, board, before, after, properties, now, seen)
    await runProjectAutomations(env.DB, env, board, before, after, properties, now, seen)
    const rows = sqlite.prepare('SELECT COUNT(*) AS n FROM chat_notifications WHERE user_id = ?').get('alice') as { n: number }
    expect(rows.n).toBe(1)
  })
})

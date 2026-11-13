// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectCard } from '../src/shared/project/model'
import { syncTodoCompletionToCard } from '../src/worker/project/enhance'
import { pruneProjectActivity } from '../src/worker/project/scheduler'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const app = createApp()
let sqlite: DatabaseSync
let env: Env
let token: string

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite))
  await app.fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  sqlite.prepare(`INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at) VALUES ('alice','alice','hash','alice','alice','member',?,?)`).run(now, now)
  sqlite.prepare(`INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at) VALUES ('bob','bob','hash','bob','Bob','member',?,?)`).run(now, now)
  token = await createSession(env.DB, 'alice')
})

beforeEach(() => {
  sqlite.exec(`DELETE FROM chat_notifications; DELETE FROM project_card_links; DELETE FROM project_activity; DELETE FROM project_board_members; DELETE FROM project_boards; DELETE FROM project_cards; DELETE FROM project_todo_links; DELETE FROM todos_tasks`)
})

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${token}` }
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
}

async function setup(): Promise<{ board: ProjectBoard, a: ProjectCard, b: ProjectCard }> {
  const board = ((await (await req('POST', '/boards', { title: 'Enh' })).json()) as { board: ProjectBoard }).board
  const a = ((await (await req('POST', `/boards/${board.id}/cards`, { title: 'Alpha' })).json()) as { card: ProjectCard }).card
  const b = ((await (await req('POST', `/boards/${board.id}/cards`, { title: 'Beta' })).json()) as { card: ProjectCard }).card
  return { board, a, b }
}

describe('card dependencies', () => {
  it('adds a blocks edge and refuses a cycle', async () => {
    const { board, a, b } = await setup()
    expect((await req('POST', `/cards/${a.id}/links`, { toCardId: b.id, kind: 'blocks' })).status).toBe(201)
    expect((await req('POST', `/cards/${b.id}/links`, { toCardId: a.id, kind: 'blocks' })).status).toBe(409)
    const links = ((await (await req('GET', `/cards/${a.id}/links`)).json()) as { links: { fromCardId: string, toCardId: string }[] }).links
    expect(links).toHaveLength(1)
    expect((await req('DELETE', `/cards/${a.id}/links/${b.id}?kind=blocks`)).status).toBe(200)
    expect(((await (await req('GET', `/cards/${a.id}/links`)).json()) as { links: unknown[] }).links).toEqual([])
    void board
  })
})

describe('activity and markdown', () => {
  it('records writes and exports a markdown report', async () => {
    const { board } = await setup()
    const activity = ((await (await req('GET', `/boards/${board.id}/activity`)).json()) as { activity: { type: string }[] }).activity
    expect(activity.length).toBeGreaterThan(0)
    const md = await (await req('GET', `/boards/${board.id}/markdown`)).text()
    expect(md).toContain('# Enh')
    expect(md).toContain('### Alpha')
    expect(md).toContain('### Beta')
  })
})

describe('card templates', () => {
  it('saves a card as template and creates a live copy from it', async () => {
    const { board, a } = await setup()
    await req('POST', `/cards/${a.id}/contents`, { type: 'text', title: 'body text' })
    expect((await req('POST', `/cards/${a.id}/save-as-template`)).status).toBe(200)
    const created = await req('POST', `/boards/${board.id}/cards/from-template`, { templateId: a.id })
    expect(created.status).toBe(201)
    const copy = ((await created.json()) as { card: ProjectCard }).card
    expect(copy.id).not.toBe(a.id)
    expect(copy.isTemplate).toBe(false)
    expect(copy.title).toBe('Alpha')
    const bundle = ((await (await req('GET', `/boards/${board.id}/bundle`)).json()) as { contents: { cardId: string, title: string }[] })
    expect(bundle.contents.some((c) => c.cardId === copy.id && c.title === 'body text')).toBe(true)
  })
})

describe('activity retention', () => {
  it('keeps half a year and removes older rows', async () => {
    const now = Date.now()
    const insert = sqlite.prepare('INSERT INTO project_activity (board_id, id, actor_id, type, target_id, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    insert.run('b1', 'old', 'u1', 'post', '', 'old', now - 200 * 24 * 60 * 60 * 1000)
    insert.run('b1', 'fresh', 'u1', 'post', '', 'fresh', now)
    expect(await pruneProjectActivity(env, now)).toBe(1)
    const left = sqlite.prepare('SELECT id FROM project_activity').all() as { id: string }[]
    expect(left.map((row) => row.id)).toEqual(['fresh'])
  })
})

describe('assignment notices', () => {
  it('notifies a newly assigned person with a link to the card', async () => {
    const person = `p${'a'.repeat(26)}`
    const board = ((await (await req('POST', '/boards', {
      title: 'Assign',
      cardProperties: [{ id: person, name: 'Assignee', type: 'person', options: [] }],
    })).json()) as { board: ProjectBoard }).board
    sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
      .run(board.id, 'bob', 'viewer')
    const card = ((await (await req('POST', `/boards/${board.id}/cards`, { title: 'Alpha' })).json()) as { card: ProjectCard }).card
    expect((await req('PATCH', `/cards/${card.id}`, { values: { [person]: 'bob' } })).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const notice = sqlite.prepare('SELECT user_id, link, title FROM chat_notifications WHERE user_id = ?1').get('bob') as { user_id: string, link: string, title: string } | undefined
    expect(notice).toMatchObject({ user_id: 'bob', link: `project:${board.id}:${card.id}`, title: 'Assigned to Alpha' })
  })
})

describe('todo two-way completion sync (X-5)', () => {
  it('mirrors card checkbox to the task and task completion back to the card', async () => {
    const board = ((await (await req('POST', '/boards', { title: 'Sync', cardProperties: [{ id: 'p'.repeat(27), name: 'Done', type: 'checkbox', options: [] }] })).json()) as { board: ProjectBoard }).board
    const card = ((await (await req('POST', `/boards/${board.id}/cards`, { title: 'Task card' })).json()) as { card: ProjectCard }).card
    sqlite.prepare(`INSERT INTO todos_tasks (user_id, id, title, created_at, updated_at) VALUES ('alice', 't1', 'Linked task', 1, 1)`).run()
    expect((await req('POST', `/cards/${card.id}/todo-link`, { todoId: 't1' })).status).toBe(201)
    await req('PATCH', `/cards/${card.id}`, { values: { ['p'.repeat(27)]: 'true' } })
    const todo = sqlite.prepare('SELECT status, completed_at FROM todos_tasks WHERE id = ?').get('t1') as { status: string, completed_at: number | null }
    expect(todo.status).toBe('done')
    expect(todo.completed_at).not.toBeNull()
    await syncTodoCompletionToCard(env.DB, 't1', false, Date.now())
    const value = sqlite.prepare('SELECT value FROM project_card_values WHERE card_id = ?').get(card.id) as { value: string }
    expect(value.value).toBe('false')
  })

  it('recognises a Chinese done option in both sync directions', async () => {
    const status = 's'.repeat(27)
    const doneId = 'd'.repeat(27)
    const openId = 'o'.repeat(27)
    const options = [{ id: openId, value: '待办', color: '' }, { id: doneId, value: '完成', color: '' }]
    const board = ((await (await req('POST', '/boards', { title: '中文', cardProperties: [{ id: status, name: '状态', type: 'select', options }] })).json()) as { board: ProjectBoard }).board
    const card = ((await (await req('POST', `/boards/${board.id}/cards`, { title: '中文卡' })).json()) as { card: ProjectCard }).card
    sqlite.prepare(`INSERT INTO todos_tasks (user_id, id, title, created_at, updated_at) VALUES ('alice', 'zh1', 'Linked task', 1, 1)`).run()
    expect((await req('POST', `/cards/${card.id}/todo-link`, { todoId: 'zh1' })).status).toBe(201)
    await req('PATCH', `/cards/${card.id}`, { values: { [status]: doneId } })
    const todo = sqlite.prepare('SELECT status FROM todos_tasks WHERE id = ?').get('zh1') as { status: string }
    expect(todo.status).toBe('done')
    await syncTodoCompletionToCard(env.DB, 'zh1', true, Date.now())
    const value = sqlite.prepare('SELECT value FROM project_card_values WHERE card_id = ? AND property_id = ?').get(card.id, status) as { value: string }
    expect(value.value).toBe(doneId)
  })
})
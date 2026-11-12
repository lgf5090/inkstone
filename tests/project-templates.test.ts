// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectBoardBundle } from '../src/shared/project/model'
import { BUILT_IN_PROJECT_TEMPLATES } from '../src/shared/project/templates'
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
  token = await createSession(env.DB, 'alice')
})

beforeEach(() => {
  sqlite.exec(`DELETE FROM project_properties; DELETE FROM project_board_members; DELETE FROM project_boards; DELETE FROM project_cards; DELETE FROM project_card_values; DELETE FROM project_views; DELETE FROM project_card_contents`)
})

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${token}` }
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
}

describe('templates', () => {
  it('lists the seven built-ins and instantiates one with properties, views and cards', async () => {
    const list = await req('GET', '/templates')
    expect(list.status).toBe(200)
    const templates = ((await list.json()) as { templates: { id: string }[] }).templates
    expect(templates).toHaveLength(BUILT_IN_PROJECT_TEMPLATES.length)
    const created = await req('POST', '/boards/from-template', { templateId: BUILT_IN_PROJECT_TEMPLATES[0]!.id })
    expect(created.status, await created.clone().text()).toBe(201)
    const board = ((await created.json()) as { board: ProjectBoard }).board
    const bundle = ((await (await req('GET', `/boards/${board.id}/bundle`)).json()) as ProjectBoardBundle)
    expect(bundle.properties.length).toBeGreaterThan(0)
    expect(bundle.views.length).toBeGreaterThan(0)
    expect(bundle.cards.length).toBeGreaterThan(0)
    expect(bundle.contents.length).toBeGreaterThan(0)
  })

  it('saves a board as a template and lists it among own templates', async () => {
    const created = await req('POST', '/boards', { title: 'Mine' })
    const board = ((await created.json()) as { board: ProjectBoard }).board
    expect((await req('POST', `/boards/${board.id}/save-as-template`)).status).toBe(200)
    const list = ((await (await req('GET', '/templates')).json()) as { templates: { id: string, isBuiltIn: boolean }[] }).templates
    const own = list.find((t) => t.id === board.id)
    expect(own).toBeDefined()
    expect(own!.isBuiltIn).toBe(false)
    const fromOwn = await req('POST', '/boards/from-template', { templateId: board.id })
    expect(fromOwn.status).toBe(201)
    const copy = ((await fromOwn.json()) as { board: ProjectBoard }).board
    expect(copy.id).not.toBe(board.id)
  })
})
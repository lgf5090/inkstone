// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectCard } from '../src/shared/project/model'
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
  sqlite.exec(`DELETE FROM project_card_links; DELETE FROM project_activity; DELETE FROM project_board_members; DELETE FROM project_boards; DELETE FROM project_cards`)
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
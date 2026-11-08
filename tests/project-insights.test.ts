// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard } from '../src/shared/project/model'
import type { ProjectTopBoard } from '../src/worker/project/insights'
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
  sqlite.exec(`DELETE FROM project_board_members; DELETE FROM project_boards; DELETE FROM project_cards; DELETE FROM project_properties; DELETE FROM project_views`)
})

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${token}` }
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
}

async function makeBoard(title: string): Promise<ProjectBoard> {
  const created = await req('POST', '/boards', { title })
  return ((await created.json()) as { board: ProjectBoard }).board
}

describe('account export and top boards', () => {
  it('exports every readable board into one v2 zip', async () => {
    const a = await makeBoard('Alpha')
    const b = await makeBoard('Beta')
    await req('POST', `/boards/${a.id}/cards`, { title: 'Card A' })
    const response = await req('GET', '/export')
    expect(response.status).toBe(200)
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()))
    const names = Object.keys(entries)
    expect(names).toContain('version.json')
    expect(names).toContain(`${a.id}/board.jsonl`)
    expect(names).toContain(`${b.id}/board.jsonl`)
  })

  it('ranks boards by recency with card counts and paginates', async () => {
    const a = await makeBoard('Older')
    const b = await makeBoard('Newer')
    await req('POST', `/boards/${b.id}/cards`, { title: 'One' })
    await req('POST', `/boards/${b.id}/cards`, { title: 'Two' })
    sqlite.prepare('UPDATE project_boards SET update_at = 1 WHERE id = ?').run(a.id)
    sqlite.prepare('UPDATE project_boards SET update_at = 2 WHERE id = ?').run(b.id)
    const top = ((await (await req('GET', '/insights/top-boards')).json()) as { boards: ProjectTopBoard[], has_next: boolean })
    expect(top.boards.map((x) => x.id)).toEqual([b.id, a.id])
    expect(top.boards[0]!.cardCount).toBe(2)
    expect(top.has_next).toBe(false)
    const page = ((await (await req('GET', '/insights/top-boards?limit=1')).json()) as { boards: ProjectTopBoard[], has_next: boolean })
    expect(page.boards).toHaveLength(1)
    expect(page.has_next).toBe(true)
  })

  it('round-trips a whole-account export through import-account with fresh ids', async () => {
    const a = await makeBoard('Alpha')
    await makeBoard('Beta')
    await req('POST', `/boards/${a.id}/cards`, { title: 'Card A' })
    const exported = new Uint8Array(await (await req('GET', '/export')).arrayBuffer())
    const imported = await app.fetch(new Request('http://localhost/api/project/boards/import-account', {
      method: 'POST', headers: { Cookie: `${LEGACY_SESSION_COOKIE}=${token}`, [CLIENT_HEADER]: '1', 'Content-Type': 'application/zip' }, body: exported as BodyInit,
    }), env)
    expect(imported.status).toBe(201)
    const boards = ((await imported.json()) as { boards: ProjectBoard[] }).boards
    expect(boards).toHaveLength(2)
    expect(boards.map((b) => b.id)).not.toContain(a.id)
    const withCard = boards.find((b) => b.title === 'Alpha')!
    const bundle = ((await (await req('GET', `/boards/${withCard.id}/bundle`)).json()) as { cards: { title: string }[] })
    expect(bundle.cards.map((c) => c.title)).toEqual(['Card A'])
  })
})
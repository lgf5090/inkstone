// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectBoardBundle, ProjectShare } from '../src/shared/project/model'
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
  sqlite.exec(`DELETE FROM project_shares; DELETE FROM project_board_members; DELETE FROM project_boards; DELETE FROM project_cards`)
})

async function req(method: string, path: string, body?: unknown, auth = true): Promise<Response> {
  const headers: Record<string, string> = { [CLIENT_HEADER]: '1' }
  if (auth) headers.Cookie = `${LEGACY_SESSION_COOKIE}=${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
}

async function makeBoard(): Promise<ProjectBoard> {
  const created = await req('POST', '/api/project/boards', { title: 'Shared' })
  return ((await created.json()) as { board: ProjectBoard }).board
}

describe('public sharing', () => {
  it('shares a board read-only and revokes it', async () => {
    const board = await makeBoard()
    await req('POST', `/api/project/boards/${board.id}/cards`, { title: 'Visible card' })
    const put = await req('PUT', `/api/project/boards/${board.id}/share`, {})
    expect(put.status).toBe(200)
    const share = ((await put.json()) as { share: ProjectShare }).share
    expect(share.hasPassword).toBe(false)
    const read = await req('POST', `/api/project/public/${share.slug}`, {}, false)
    expect(read.status).toBe(200)
    const bundle = ((await read.json()) as ProjectBoardBundle)
    expect(bundle.role).toBe('viewer')
    expect(bundle.cards.map((c) => c.title)).toEqual(['Visible card'])
    expect((await req('DELETE', `/api/project/boards/${board.id}/share`)).status).toBe(200)
    expect((await req('POST', `/api/project/public/${share.slug}`, {}, false)).status).toBe(404)
  })

  it('gates a password-protected share and lapses an expired one', async () => {
    const board = await makeBoard()
    const put = await req('PUT', `/api/project/boards/${board.id}/share`, { password: 'secret-pass' })
    const share = ((await put.json()) as { share: ProjectShare }).share
    expect(share.hasPassword).toBe(true)
    expect((await req('POST', `/api/project/public/${share.slug}`, {}, false)).status).toBe(403)
    expect((await req('POST', `/api/project/public/${share.slug}`, { password: 'wrong' }, false)).status).toBe(403)
    expect((await req('POST', `/api/project/public/${share.slug}`, { password: 'secret-pass' }, false)).status).toBe(200)
    await req('PUT', `/api/project/boards/${board.id}/share`, { expiresAt: 1 })
    expect((await req('POST', `/api/project/public/${share.slug}`, { password: 'secret-pass' }, false)).status).toBe(404)
  })
})
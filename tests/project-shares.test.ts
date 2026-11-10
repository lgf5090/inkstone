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
  sqlite.exec(`DELETE FROM project_shares; DELETE FROM project_board_members; DELETE FROM project_boards; DELETE FROM project_cards; DELETE FROM login_attempts`)
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

// requestClientIp only trusts CF-Connecting-IP when the edge attached `cf`; without it every caller
// reads as `local`, which would hide the per-slug ceiling from a test that means to rotate addresses.
async function reqFromIp(path: string, ip: string, body: unknown): Promise<Response> {
  const request = new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { [CLIENT_HEADER]: '1', 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  })
  Object.assign(request, { cf: {} })
  return app.fetch(request, env)
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
    expect((await req('POST', `/api/project/public/${share.slug}`, {}, false)).status).toBe(401)
    expect((await req('POST', `/api/project/public/${share.slug}`, { password: 'wrong' }, false)).status).toBe(401)
    expect((await req('POST', `/api/project/public/${share.slug}`, { password: 'secret-pass' }, false)).status).toBe(200)
    await req('PUT', `/api/project/boards/${board.id}/share`, { expiresAt: 1 })
    expect((await req('POST', `/api/project/public/${share.slug}`, { password: 'secret-pass' }, false)).status).toBe(404)
  })
})

describe('the public gate budget', () => {
  it('locks the slug after the free failures and refuses even the right passcode while locked', async () => {
    const board = await makeBoard()
    const put = await req('PUT', `/api/project/boards/${board.id}/share`, { password: 'secret-pass' })
    const share = ((await put.json()) as { share: ProjectShare }).share
    const statuses: number[] = []
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await req('POST', `/api/project/public/${share.slug}`, { password: 'wrong' }, false)).status)
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429])
    const locked = await req('POST', `/api/project/public/${share.slug}`, { password: 'secret-pass' }, false)
    expect(locked.status).toBe(429)
    const body = (await locked.json()) as { error: { code: string } }
    expect(body.error.code).toBe('too_many_attempts')
  })

  it('clears the failure ledger on a correct passcode so a typo does not count toward the lock', async () => {
    const board = await makeBoard()
    const put = await req('PUT', `/api/project/boards/${board.id}/share`, { password: 'secret-pass' })
    const share = ((await put.json()) as { share: ProjectShare }).share
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await req('POST', `/api/project/public/${share.slug}`, { password: 'wrong' }, false)).status).toBe(401)
    }
    expect(sqlite.prepare('SELECT fails FROM login_attempts WHERE key = ?1').get(`project-share:${share.slug}:ip:local`)).toBeDefined()
    expect((await req('POST', `/api/project/public/${share.slug}`, { password: 'secret-pass' }, false)).status).toBe(200)
    expect(sqlite.prepare('SELECT fails FROM login_attempts WHERE key = ?1').get(`project-share:${share.slug}:ip:local`)).toBeUndefined()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await req('POST', `/api/project/public/${share.slug}`, { password: 'wrong' }, false)).status).toBe(401)
    }
  })

  it('budgets an open share too, so a password-less slug cannot be walked for free', async () => {
    const board = await makeBoard()
    const put = await req('PUT', `/api/project/boards/${board.id}/share`, {})
    const share = ((await put.json()) as { share: ProjectShare }).share
    for (let read = 0; read < 20; read += 1) {
      expect((await req('POST', `/api/project/public/${share.slug}`, {}, false)).status).toBe(200)
    }
    expect((await req('POST', `/api/project/public/${share.slug}`, {}, false)).status).toBe(429)
  })

  it('caps the slug itself, so rotating addresses cannot outrun the per-address lock', async () => {
    const board = await makeBoard()
    const put = await req('PUT', `/api/project/boards/${board.id}/share`, { password: 'secret-pass' })
    const share = ((await put.json()) as { share: ProjectShare }).share
    const statuses: number[] = []
    for (let attempt = 0; attempt < 61; attempt += 1) {
      statuses.push((await reqFromIp(`/api/project/public/${share.slug}`, `10.0.${Math.floor(attempt / 250)}.${attempt % 250 + 1}`, { password: 'wrong' })).status)
    }
    expect(statuses.slice(0, 60).every((status) => status === 401)).toBe(true)
    expect(statuses[60]).toBe(429)
    expect(sqlite.prepare('SELECT fails FROM login_attempts WHERE key = ?1').get(`project-share-work:${share.slug}`)).toMatchObject({ fails: 61 })
  }, 60_000)
})
describe('the public address', () => {
  it('serves the app shell at /p/:slug without leaking the board title to a crawler', async () => {
    const board = await makeBoard()
    const put = await req('PUT', `/api/project/boards/${board.id}/share`, {})
    const share = ((await put.json()) as { share: ProjectShare }).share
    const shell = '<html><head><title>App</title></head><body>root</body></html>'
    const assets = { fetch: async () => new Response(shell), connect: () => { throw new TypeError('no sockets') } }
    const page = await app.fetch(new Request(`http://localhost/p/${share.slug}`), { ...env, ASSETS: assets } as Env)
    expect(page.status).toBe(200)
    expect(page.headers.get('X-Robots-Tag')).toBe('noindex')
    const html = await page.text()
    expect(html).toContain('name="robots" content="noindex, nofollow"')
    expect(html).toContain('root')
    expect(html).not.toContain('Shared')
  })
})

// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { CLOUDDRIVE_SCHEMA_STATEMENTS } from '../src/worker/clouddrive/schema'
import { clouddriveRoutes } from '../src/worker/clouddrive/routes'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testDurableObjectNamespace, testR2Bucket } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
let sqlite: DatabaseSync
let db: D1Database
let env: Env

function makeVault(): DurableObjectNamespace {
  const entries = new Map<string, { scope: string; value: unknown }>()
  let sequence = 0
  return testDurableObjectNamespace(async (request) => {
    const url = new URL(request.url)
    const body = await request.json() as { scope?: string; value?: unknown; ciphertext?: string }
    if (url.pathname === '/encrypt') {
      const ciphertext = `vault-${++sequence}`
      entries.set(ciphertext, { scope: body.scope ?? '', value: body.value })
      return Response.json({ ciphertext })
    }
    if (url.pathname === '/decrypt') {
      const entry = entries.get(body.ciphertext ?? '')
      if (!entry || entry.scope !== body.scope) return Response.json({}, { status: 422 })
      return Response.json({ value: entry.value })
    }
    return new Response('not found', { status: 404 })
  })
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of CLOUDDRIVE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  env = testBindings(db, { FILES: testR2Bucket(), CREDENTIAL_VAULT: makeVault() })
})

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('user', { id: USER, username: 'owner', login: 'owner', name: 'Owner', avatarUrl: '', role: 'owner', createdAt: 1, settingsRaw: '{}' })
    await next()
  })
  instance.route('/api/clouddrive', clouddriveRoutes)
  return instance
}

async function request(method: string, path: string, body?: unknown, cookie = ''): Promise<{ status: number; body: any; cookie: string }> {
  const response = await app().fetch(new Request(`http://localhost${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'X-Inkstone-Client': '1',
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
  const setCookies = response.headers.getSetCookie?.() ?? []
  const metaCookie = setCookies.map((value) => value.split(';')[0]!).find((value) => value.startsWith('cd_meta_')) ?? ''
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
    cookie: metaCookie || cookie,
  }
}

async function folder(parentPath: string, name: string, cookie = ''): Promise<any> {
  const result = await request('POST', '/api/clouddrive/folders', { mountId: 'primary', parentPath, name }, cookie)
  expect(result.status).toBe(201)
  return result.body.entry
}

describe('cloud drive folder metadata', () => {
  it('protects a folder, inherits its password and renders header/footer', async () => {
    await request('GET', '/api/clouddrive/bootstrap')
    await folder('/', 'folder')
    const sub = await folder('/folder', 'sub')
    const saved = await request('PUT', '/api/clouddrive/meta', {
      mountId: 'primary',
      path: '/folder',
      header: '# Header',
      footer: 'Footer',
      hidePatterns: ['^secret$'],
      password: 'folder-pass',
      inheritHeader: true,
      inheritFooter: true,
      inheritHide: true,
      inheritPassword: true,
    })
    expect(saved.status).toBe(200)
    const folderEntry = await request('GET', '/api/clouddrive/meta')
    expect(folderEntry.body.meta[0]).toMatchObject({ path: '/folder', hasPassword: true, inheritPassword: true })

    expect((await request('GET', '/api/clouddrive/files?mount=primary&path=%2Ffolder%2Fsub')).status).toBe(403)
    const unlocked = await request('POST', '/api/clouddrive/meta/unlock', {
      mountId: 'primary', path: '/folder/sub', password: 'folder-pass',
    })
    expect(unlocked.status).toBe(200)
    expect(unlocked.cookie).toContain('cd_meta_')
    const listing = await request('GET', '/api/clouddrive/files?mount=primary&path=%2Ffolder%2Fsub', undefined, unlocked.cookie)
    expect(listing.status).toBe(200)
    expect(listing.body).toMatchObject({ note: '# Header', footer: 'Footer' })
    expect(listing.body.folders).toEqual([])

    await folder('/folder', 'visible', unlocked.cookie)
    await folder('/folder', 'secret', unlocked.cookie)
    const filtered = await request('GET', '/api/clouddrive/files?mount=primary&path=%2Ffolder', undefined, unlocked.cookie)
    expect(filtered.status).toBe(200)
    expect(filtered.body.folders.map((entry: any) => entry.name)).toEqual(['sub', 'visible'])
    expect(filtered.body.total).toBe(0)
    expect(sub.id).toBeTruthy()
  })

  it('does not leak a password to a child when inheritance is off', async () => {
    await request('GET', '/api/clouddrive/bootstrap')
    await folder('/', 'private')
    await folder('/private', 'open')
    await request('PUT', '/api/clouddrive/meta', {
      mountId: 'primary', path: '/private', password: 'pw', inheritPassword: false,
    })
    expect((await request('GET', '/api/clouddrive/files?mount=primary&path=%2Fprivate')).status).toBe(403)
    expect((await request('GET', '/api/clouddrive/files?mount=primary&path=%2Fprivate%2Fopen')).status).toBe(200)
  })


  it('cleans metadata when its mount is removed', async () => {
    await request('GET', '/api/clouddrive/bootstrap')
    const mount = await request('POST', '/api/clouddrive/mounts', { name: 'meta-mount', storageId: 'primary', mountPath: '/meta-mount' })
    await request('PUT', '/api/clouddrive/meta', { mountId: mount.body.mount.id, path: '/', header: 'x' })
    expect((await request('DELETE', `/api/clouddrive/mounts/${mount.body.mount.id}`)).status).toBe(200)
    expect((await request('GET', '/api/clouddrive/meta')).body.meta).toHaveLength(0)
  })

  it('deletes metadata from the admin endpoint', async () => {
    await request('GET', '/api/clouddrive/bootstrap')
    await request('PUT', '/api/clouddrive/meta', { mountId: 'primary', path: '/', header: 'hello' })
    expect((await request('DELETE', '/api/clouddrive/meta', { mountId: 'primary', path: '/' })).body.ok).toBe(true)
    expect((await request('GET', '/api/clouddrive/meta')).body.meta).toHaveLength(0)
  })
})

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
    c.set('user', { id: USER, username: 't', login: 't', name: 'T', avatarUrl: '', role: 'owner', createdAt: 1, settingsRaw: '{}' })
    await next()
  })
  instance.route('/api/clouddrive', clouddriveRoutes)
  return instance
}

async function call(method: string, path: string, body?: unknown) {
  const response = await app().fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'X-Inkstone-Client': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
  return { status: response.status, body: await response.json().catch(() => ({})) as any }
}

describe('cloud drive mounts', () => {
  it('creates, lists, renames and removes an extra mount on the primary storage', async () => {
    await call('GET', '/api/clouddrive/bootstrap')
    const created = await call('POST', '/api/clouddrive/mounts', { name: 'Photos', storageId: 'primary', mountPath: '/photos' })
    expect(created.status).toBe(200)
    expect(created.body.mount.mountPath).toBe('/photos')

    const listed = await call('GET', '/api/clouddrive/mounts')
    expect(listed.body.mounts.map((mount: any) => mount.mountPath)).toEqual(['/', '/photos'])

    const renamed = await call('PATCH', `/api/clouddrive/mounts/${created.body.mount.id}`, { name: 'Pictures', readOnly: true })
    expect(renamed.body.mount.name).toBe('Pictures')
    expect(renamed.body.mount.readOnly).toBe(true)

    const removed = await call('DELETE', `/api/clouddrive/mounts/${created.body.mount.id}`)
    expect(removed.status).toBe(200)
    const after = await call('GET', '/api/clouddrive/mounts')
    expect(after.body.mounts).toHaveLength(1)
  })

  it('rejects a nested mount path and refuses to remove the primary mount', async () => {
    await call('GET', '/api/clouddrive/bootstrap')
    expect((await call('POST', '/api/clouddrive/mounts', { name: 'Bad', storageId: 'primary', mountPath: '/a/b' })).status).toBe(400)
    expect((await call('DELETE', '/api/clouddrive/mounts/primary')).status).toBe(400)
  })

  it('rejects an unsupported storage type before touching credentials', async () => {
    const result = await call('POST', '/api/clouddrive/storages', { name: 'Nope', type: 'ftp', config: {}, credentials: {} })
    expect(result.status).toBe(400)
  })

  it('seals storage credentials and mounts an external storage read-only', async () => {
    const storage = await call('POST', '/api/clouddrive/storages', {
      name: 'dav',
      type: 'webdav',
      config: { baseUrl: 'https://dav.example.com', rootPath: '/' },
      credentials: { username: 'reader', password: 'secret' },
    })
    expect(storage.status).toBe(200)
    expect(storage.body.storage.hasCredentials).toBe(true)

    const mount = await call('POST', '/api/clouddrive/mounts', {
      name: 'dav',
      storageId: storage.body.storage.id,
      mountPath: '/dav',
      readOnly: false,
    })
    expect(mount.status).toBe(200)
    expect(mount.body.mount.readOnly).toBe(true)
  })

  it('accepts a public storage with no credentials', async () => {
    const storage = await call('POST', '/api/clouddrive/storages', {
      name: 'public',
      type: 's3',
      config: { endpoint: 'https://s3.example.com', bucketName: 'public' },
      credentials: {},
    })
    expect(storage.status).toBe(200)
    expect(storage.body.storage.hasCredentials).toBe(false)
  })
})

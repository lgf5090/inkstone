// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { CLOUDDRIVE_SCHEMA_STATEMENTS } from '../src/worker/clouddrive/schema'
import { clouddriveRoutes } from '../src/worker/clouddrive/routes'
import { clouddriveDavRoutes } from '../src/worker/clouddrive/routes-dav'
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

afterEach(() => {
  vi.unstubAllGlobals()
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
  instance.route('/clouddrive/dav', clouddriveDavRoutes)
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

async function dav(method: string, path: string, auth: string, body?: BodyInit, headers: Record<string, string> = {}) {
  return await app().fetch(new Request(`http://localhost/clouddrive/dav${path}`, {
    method,
    headers: {
      Authorization: `Basic ${btoa(auth)}`,
      ...(body === undefined ? {} : { 'content-type': 'text/plain' }),
      ...headers,
    },
    body,
  }), env)
}

async function setupWebdav() {
  await call('GET', '/api/clouddrive/bootstrap')
  expect((await call('PATCH', '/api/clouddrive/settings', {
    webdavEnabled: true, webdavUsername: 'owner', webdavPassword: 'davpass',
  })).status).toBe(200)
}

async function createMount(name: string, options: { apiKeyVisible: boolean; readOnly?: boolean; webdavPolicy?: string; webProxy?: boolean; s3?: boolean }) {
  const storage = await call('POST', '/api/clouddrive/storages', {
    name: `storage-${name}`,
    type: options.s3 ? 's3' : 'webdav',
    config: options.s3
      ? { endpoint: 'https://s3.example.com', bucketName: 'bucket', customHost: 'https://cdn.example.com' }
      : { baseUrl: 'https://dav.example.com/dav' },
    credentials: options.s3 ? { accessKeyId: 'key', secretAccessKey: 'secret' } : { username: 'u', password: 'p' },
    apiKeyVisible: options.apiKeyVisible,
  })
  expect(storage.status).toBe(200)
  const mount = await call('POST', '/api/clouddrive/mounts', {
    name: `mount-${name}`,
    storageId: storage.body.storage.id,
    mountPath: `/${name}`,
    readOnly: options.readOnly ?? false,
    webdavPolicy: options.webdavPolicy ?? 'native_proxy',
    webProxy: options.webProxy ?? false,
  })
  expect(mount.status).toBe(200)
  return mount.body.mount
}

describe('cloud drive WebDAV external mounts', () => {
  it('lists allowed external mounts at the root and hides private storage from API keys', async () => {
    await setupWebdav()
    await createMount('visible', { apiKeyVisible: true })
    await createMount('private', { apiKeyVisible: false })
    const key = await call('POST', '/api/clouddrive/api-keys', { name: 'dav', scopes: ['webdav'], pathPrefix: '/' })
    expect(key.status).toBe(201)

    const ownerRoot = await dav('PROPFIND', '/', 'owner:davpass', undefined, { Depth: '1' })
    expect(ownerRoot.status).toBe(207)
    const ownerXml = await ownerRoot.text()
    expect(ownerXml).toContain('/clouddrive/dav/visible/')
    expect(ownerXml).toContain('/clouddrive/dav/private/')

    const keyRoot = await dav('PROPFIND', '/', `apikey:${key.body.token}`, undefined, { Depth: '1' })
    expect(keyRoot.status).toBe(207)
    const keyXml = await keyRoot.text()
    expect(keyXml).toContain('/clouddrive/dav/visible/')
    expect(keyXml).not.toContain('/clouddrive/dav/private/')
    expect((await dav('PROPFIND', '/private/', `apikey:${key.body.token}`, undefined, { Depth: '0' })).status).toBe(404)
  })

  it('lists, reads and writes files on a WebDAV mount', async () => {
    await setupWebdav()
    await createMount('teracloud', { apiKeyVisible: true })
    const propfind = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/a.txt</D:href>
      <D:propstat><D:prop><D:getcontentlength>5</D:getcontentlength></D:prop></D:propstat></D:response></D:multistatus>`
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PROPFIND') return new Response(propfind, { status: 207 })
      if (init?.method === 'PUT') return new Response(null, { status: 201 })
      return new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const listing = await dav('PROPFIND', '/teracloud/', 'owner:davpass', undefined, { Depth: '1' })
    expect(listing.status).toBe(207)
    expect(await listing.text()).toContain('/clouddrive/dav/teracloud/a.txt')
    const read = await dav('GET', '/teracloud/a.txt', 'owner:davpass')
    expect(read.status).toBe(200)
    expect(await read.text()).toBe('hello')
    const written = await dav('PUT', '/teracloud/new.txt', 'owner:davpass', 'written')
    expect(written.status).toBe(201)
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(putCall?.[0]).toBe('https://dav.example.com/dav/new.txt')
    const removed = await dav('DELETE', '/teracloud/new.txt', 'owner:davpass')
    expect(removed.status).toBe(204)
  })

  it('redirects external content through the mount policy', async () => {
    await setupWebdav()
    await createMount('s3', { apiKeyVisible: true, s3: true, webdavPolicy: '302_redirect' })
    const response = await dav('GET', '/s3/file.txt', 'owner:davpass')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://cdn.example.com/file.txt')
  })

  it('refuses writes to a read-only external mount', async () => {
    await setupWebdav()
    await createMount('readonly', { apiKeyVisible: true, readOnly: true })
    expect((await dav('PUT', '/readonly/x.txt', 'owner:davpass', 'x')).status).toBe(403)
    expect((await dav('MKCOL', '/readonly/folder', 'owner:davpass')).status).toBe(403)
  })
})

// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { CLOUDDRIVE_SCHEMA_STATEMENTS } from '../src/worker/clouddrive/schema'
import { clouddriveRoutes } from '../src/worker/clouddrive/routes'
import { externalEntryId } from '../src/worker/clouddrive/external'
import { decryptCloudDriveCredentials } from '../src/worker/lib/crypto'
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

async function raw(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
  return await app().fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { 'X-Inkstone-Client': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body,
  }), env)
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

  it('refuses to remove a mount that still holds files', async () => {
    await call('GET', '/api/clouddrive/bootstrap')
    const mount = await call('POST', '/api/clouddrive/mounts', { name: 'Photos', storageId: 'primary', mountPath: '/photos' })
    expect((await call('POST', '/api/clouddrive/folders', { mountId: mount.body.mount.id, parentPath: '/', name: 'keep' })).status).toBe(201)
    expect((await call('DELETE', `/api/clouddrive/mounts/${mount.body.mount.id}`)).status).toBe(409)
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

  it('seals storage credentials and mounts a writable WebDAV storage', async () => {
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
    expect(mount.body.mount.readOnly).toBe(false)
  })

  it('lets S3 and WebDAV mounts be writable while read-only drivers stay read-only', async () => {
    const storage = await call('POST', '/api/clouddrive/storages', {
      name: 'parts',
      type: 's3',
      config: { endpoint: 'https://s3.example.com', bucketName: 'parts', region: 'auto' },
      credentials: {},
    })
    expect(storage.status).toBe(200)
    const mount = await call('POST', '/api/clouddrive/mounts', {
      name: 'parts',
      storageId: storage.body.storage.id,
      mountPath: '/parts',
      readOnly: false,
    })
    expect(mount.status).toBe(200)
    expect(mount.body.mount.readOnly).toBe(false)
    const webdav = await call('POST', '/api/clouddrive/storages', {
      name: 'dav', type: 'webdav', config: { baseUrl: 'https://dav.example.com' }, credentials: {},
    })
    expect((await call('POST', '/api/clouddrive/mounts', {
      name: 'dav', storageId: webdav.body.storage.id, mountPath: '/dav', readOnly: false,
    })).body.mount.readOnly).toBe(false)
    const github = await call('POST', '/api/clouddrive/storages', {
      name: 'gh', type: 'github', config: { repo: 'owner/repo' }, credentials: {},
    })
    expect((await call('POST', '/api/clouddrive/mounts', {
      name: 'gh', storageId: github.body.storage.id, mountPath: '/gh', readOnly: false,
    })).body.mount.readOnly).toBe(true)
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

  it('makes the first storage the default and lets another one replace it', async () => {
    const first = await call('POST', '/api/clouddrive/storages', {
      name: 'first',
      type: 'webdav',
      config: { baseUrl: 'https://dav.example.com' },
      credentials: {},
    })
    const second = await call('POST', '/api/clouddrive/storages', {
      name: 'second',
      type: 'webdav',
      config: { baseUrl: 'https://dav2.example.com' },
      credentials: {},
    })
    expect(first.body.storage.isDefault).toBe(true)
    expect(second.body.storage.isDefault).toBe(false)
    expect((await call('POST', `/api/clouddrive/storages/${second.body.storage.id}/default`)).status).toBe(200)
    const listed = await call('GET', '/api/clouddrive/storages')
    expect(listed.body.storages.map((storage: any) => [storage.name, storage.isDefault])).toEqual([
      ['second', true],
      ['first', false],
    ])
  })

  it('edits a storage configuration and merges credential fields that were left blank', async () => {
    const storage = await call('POST', '/api/clouddrive/storages', {
      name: 'dav',
      type: 'webdav',
      config: { baseUrl: 'https://dav.example.com', rootPath: '/' },
      credentials: { username: 'reader', password: 'secret' },
    })
    const patched = await call('PATCH', `/api/clouddrive/storages/${storage.body.storage.id}`, {
      name: 'dav renamed',
      config: { baseUrl: 'https://dav.example.com', rootPath: '/team' },
      credentials: { password: 'rotated' },
    })
    expect(patched.status).toBe(200)
    expect(patched.body.storage.name).toBe('dav renamed')
    expect(patched.body.storage.config.rootPath).toBe('/team')
    const row = await db.prepare(`SELECT credentials FROM CloudDrive_storages WHERE id = ?`).bind(storage.body.storage.id).first<{ credentials: string }>()
    const decrypted = await decryptCloudDriveCredentials(env, storage.body.storage.id, row!.credentials)
    expect(decrypted).toEqual({ username: 'reader', password: 'rotated' })
    expect((await call('PATCH', `/api/clouddrive/storages/${storage.body.storage.id}`, { type: 's3' })).status).toBe(400)
  })

  it('rejects an invalid configuration and a disabled storage at mount time', async () => {
    expect((await call('POST', '/api/clouddrive/storages', {
      name: 'bad', type: 's3', config: { endpoint: 'not-a-url', bucketName: 'x' }, credentials: {},
    })).status).toBe(400)
    const storage = await call('POST', '/api/clouddrive/storages', {
      name: 'dav', type: 'webdav', config: { baseUrl: 'https://dav.example.com' }, credentials: {},
    })
    expect((await call('PATCH', `/api/clouddrive/storages/${storage.body.storage.id}`, { status: 'disabled' })).status).toBe(200)
    expect((await call('POST', '/api/clouddrive/mounts', {
      name: 'dav', storageId: storage.body.storage.id, mountPath: '/dav',
    })).status).toBe(400)
  })

  it('still edits a mount whose storage was disabled', async () => {
    const storage = await call('POST', '/api/clouddrive/storages', {
      name: 'dav', type: 'webdav', config: { baseUrl: 'https://dav.example.com' }, credentials: {},
    })
    const mount = await call('POST', '/api/clouddrive/mounts', {
      name: 'dav', storageId: storage.body.storage.id, mountPath: '/dav',
    })
    await call('PATCH', `/api/clouddrive/storages/${storage.body.storage.id}`, { status: 'disabled' })
    const patched = await call('PATCH', `/api/clouddrive/mounts/${mount.body.mount.id}`, {
      storageId: storage.body.storage.id, remark: 'kept', enabled: false,
    })
    expect(patched.status).toBe(200)
    expect(patched.body.mount.remark).toBe('kept')
  })

  it('edits a mount remark, order, path, state and storage', async () => {
    const storage = await call('POST', '/api/clouddrive/storages', {
      name: 'dav', type: 'webdav', config: { baseUrl: 'https://dav.example.com' }, credentials: {},
    })
    const other = await call('POST', '/api/clouddrive/storages', {
      name: 'dav2', type: 'webdav', config: { baseUrl: 'https://dav2.example.com' }, credentials: {},
    })
    const mount = await call('POST', '/api/clouddrive/mounts', {
      name: 'dav', storageId: storage.body.storage.id, mountPath: '/dav', remark: 'notes',
    })
    const patched = await call('PATCH', `/api/clouddrive/mounts/${mount.body.mount.id}`, {
      name: 'dav2', mountPath: '/dav2', storageId: other.body.storage.id, remark: 'team drive',
      sortOrder: 9, cacheTtl: 0, enabled: false,
    })
    expect(patched.status).toBe(200)
    expect(patched.body.mount).toMatchObject({
      name: 'dav2', mountPath: '/dav2', storageId: other.body.storage.id,
      remark: 'team drive', sortOrder: 9, cacheTtl: 0, enabled: false, readOnly: false,
    })
    const listed = await call('GET', '/api/clouddrive/mounts')
    expect(listed.body.mounts.find((item: any) => item.id === mount.body.mount.id)).toMatchObject({ remark: 'team drive', enabled: false })
  })

  it('stores capacity, defaults, proxy and quota settings on a storage', async () => {
    const capacityBytes = 25 * 1024 ** 3
    const storage = await call('POST', '/api/clouddrive/storages', {
      name: 's3',
      type: 's3',
      config: {
        endpoint: 'https://s3.example.com', bucketName: 'bucket', capacityBytes,
        urlProxy: 'https://proxy.example.com', customHost: 'https://cdn.example.com',
      },
      credentials: {},
      defaultPath: '/uploads',
      readQuota: true,
      apiKeyVisible: true,
    })
    expect(storage.status).toBe(200)
    expect(storage.body.storage.config).toMatchObject({
      capacityBytes, urlProxy: 'https://proxy.example.com', customHost: 'https://cdn.example.com',
    })
    expect(storage.body.storage).toMatchObject({ defaultPath: '/uploads', readQuota: true, apiKeyVisible: true })
    const listed = await call('GET', '/api/clouddrive/storages')
    expect(listed.body.storages[0]).toMatchObject({ usedBytes: 0, defaultPath: '/uploads', readQuota: true, apiKeyVisible: true })
  })

  it('stores mount computation, proxy and WebDAV policy settings', async () => {
    const storage = await call('POST', '/api/clouddrive/storages', {
      name: 'dav', type: 'webdav',
      config: { baseUrl: 'https://dav.example.com', urlProxy: 'https://proxy.example.com' }, credentials: {},
    })
    const mount = await call('POST', '/api/clouddrive/mounts', {
      name: 'dav', storageId: storage.body.storage.id, mountPath: '/dav',
      folderSummary: true, webProxy: true, webdavPolicy: 'use_proxy_url',
    })
    expect(mount.status).toBe(200)
    expect(mount.body.mount).toMatchObject({
      folderSummary: true, webProxy: true, webdavPolicy: 'use_proxy_url', readOnly: false,
    })
    const patched = await call('PATCH', `/api/clouddrive/mounts/${mount.body.mount.id}`, {
      webdavPolicy: 'native_proxy', webProxy: false, folderSummary: false,
    })
    expect(patched.body.mount).toMatchObject({ folderSummary: false, webProxy: false, webdavPolicy: 'native_proxy' })
    expect((await call('PATCH', `/api/clouddrive/mounts/${mount.body.mount.id}`, { webdavPolicy: 'nope' })).status).toBe(400)
  })

  it('reads a WebDAV quota when the storage opts in', async () => {
    const quotaXml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response>
      <D:href>/dav/</D:href><D:propstat><D:prop>
      <D:quota-used-bytes>1024</D:quota-used-bytes>
      <D:quota-available-bytes>9216</D:quota-available-bytes>
      </D:prop></D:propstat></D:response></D:multistatus>`
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(quotaXml, { status: 207, headers: { 'content-type': 'application/xml' } }))
    vi.stubGlobal('fetch', fetchMock)
    const storage = await call('POST', '/api/clouddrive/storages', {
      name: 'dav', type: 'webdav', config: { baseUrl: 'https://dav.example.com/dav' }, credentials: {}, readQuota: true,
    })
    const tested = await call('POST', `/api/clouddrive/storages/${storage.body.storage.id}/test`)
    expect(tested.status).toBe(200)
    expect(tested.body).toMatchObject({ ok: true, quota: { used: 1024, total: 10240 } })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://dav.example.com/dav/')
    expect(String(init.body)).toContain('quota-used-bytes')
    expect((init.headers as Record<string, string>)['Content-Type']).toContain('application/xml')
  })

  it('only calculates folder sizes when the mount opts in', async () => {
    await call('GET', '/api/clouddrive/bootstrap')
    const mount = await call('POST', '/api/clouddrive/mounts', { name: 'Photos', storageId: 'primary', mountPath: '/photos' })
    const folder = await call('POST', '/api/clouddrive/folders', { mountId: mount.body.mount.id, parentPath: '/', name: 'empty' })
    expect((await call('GET', `/api/clouddrive/files/${folder.body.entry.id}/folder-size`)).status).toBe(403)
    await call('PATCH', `/api/clouddrive/mounts/${mount.body.mount.id}`, { folderSummary: true })
    const sized = await call('GET', `/api/clouddrive/files/${folder.body.entry.id}/folder-size`)
    expect(sized.status).toBe(200)
    expect(sized.body).toEqual({ bytes: 0, truncated: false })
  })

  it('redirects external content according to the mount policy', async () => {
    const storage = await call('POST', '/api/clouddrive/storages', {
      name: 's3', type: 's3',
      config: {
        endpoint: 'https://s3.example.com', bucketName: 'bucket',
        customHost: 'https://cdn.example.com', urlProxy: 'https://proxy.example.com/fetch',
      },
      credentials: {},
    })
    const mount = await call('POST', '/api/clouddrive/mounts', {
      name: 's3', storageId: storage.body.storage.id, mountPath: '/s3', readOnly: false, webProxy: false, webdavPolicy: '302_redirect',
    })
    const id = encodeURIComponent(externalEntryId(mount.body.mount.id, '/readme.txt'))
    const direct = await raw('GET', `/api/clouddrive/files/${id}/content`)
    expect(direct.status).toBe(302)
    expect(direct.headers.get('location')).toBe('https://cdn.example.com/readme.txt')
    await call('PATCH', `/api/clouddrive/mounts/${mount.body.mount.id}`, { webdavPolicy: 'use_proxy_url' })
    const proxied = await raw('GET', `/api/clouddrive/files/${id}/content`)
    expect(proxied.status).toBe(302)
    expect(proxied.headers.get('location')).toBe(`https://proxy.example.com/fetch?url=${encodeURIComponent('https://cdn.example.com/readme.txt')}`)
  })

  it('rejects an external upload that would exceed the storage capacity', async () => {
    const storage = await call('POST', '/api/clouddrive/storages', {
      name: 'small', type: 'webdav',
      config: { baseUrl: 'https://dav.example.com/dav', capacityBytes: 5 },
      credentials: {},
    })
    const mount = await call('POST', '/api/clouddrive/mounts', {
      name: 'small', storageId: storage.body.storage.id, mountPath: '/small', readOnly: false,
    })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('<D:multistatus xmlns:D="DAV:"/>', { status: 207 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await raw('POST', `/api/clouddrive/external/${mount.body.mount.id}/upload?path=${encodeURIComponent('/big.txt')}`, '0123456789', { 'content-type': 'text/plain' })
    expect(result.status).toBe(403)
    expect(await result.json()).toMatchObject({ error: { code: 'clouddrive_quota_exceeded' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![1] as RequestInit).toMatchObject({ method: 'PROPFIND' })
  })

  it('writes, creates, moves and deletes files on a writable WebDAV mount', async () => {
    const storage = await call('POST', '/api/clouddrive/storages', {
      name: 'dav', type: 'webdav', config: { baseUrl: 'https://dav.example.com/dav' }, credentials: { username: 'u', password: 'p' },
    })
    const mount = await call('POST', '/api/clouddrive/mounts', {
      name: 'dav', storageId: storage.body.storage.id, mountPath: '/dav', readOnly: false,
    })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const mountId = mount.body.mount.id
    const uploaded = await raw('POST', `/api/clouddrive/external/${mountId}/upload?path=${encodeURIComponent('/a.txt')}`, 'hello', { 'content-type': 'text/plain' })
    expect(uploaded.status).toBe(201)
    expect(fetchMock.mock.calls[0]![0]).toBe('https://dav.example.com/dav/a.txt')
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('PUT')
    expect((await raw('POST', `/api/clouddrive/external/${mountId}/folders`, JSON.stringify({ path: '/folder' }))).status).toBe(201)
    expect((fetchMock.mock.calls.at(-1)![1] as RequestInit).method).toBe('MKCOL')
    expect((await raw('POST', `/api/clouddrive/external/${mountId}/move`, JSON.stringify({ from: '/a.txt', to: '/folder/a.txt' }))).status).toBe(200)
    expect((fetchMock.mock.calls.at(-1)![1] as RequestInit).method).toBe('MOVE')
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const deleted = await raw('DELETE', `/api/clouddrive/external/${mountId}/files`, JSON.stringify({ paths: ['/folder/a.txt'] }))
    expect(deleted.status).toBe(200)
    expect((fetchMock.mock.calls.at(-1)![1] as RequestInit).method).toBe('DELETE')
    await call('PATCH', `/api/clouddrive/mounts/${mountId}`, { readOnly: true })
    expect((await raw('POST', `/api/clouddrive/external/${mountId}/folders`, JSON.stringify({ path: '/x' }))).status).toBe(403)
  })
})

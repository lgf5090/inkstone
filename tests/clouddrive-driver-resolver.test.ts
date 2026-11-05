// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { CLOUDDRIVE_SCHEMA_STATEMENTS } from '../src/worker/clouddrive/schema'
import { createStorageDriver } from '../src/worker/clouddrive/drivers/factory'
import { encryptCloudDriveCredentials } from '../src/worker/lib/crypto'
import { newId } from '../src/worker/lib/id'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testDurableObjectNamespace, testR2Bucket } from './doubles/bindings'

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

let sqlite: DatabaseSync
let db: D1Database
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of CLOUDDRIVE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  env = testBindings(db, { FILES: testR2Bucket(), CREDENTIAL_VAULT: makeVault() })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function insertMount(options: {
  userId: string
  type: string
  config: Record<string, unknown>
  credentials?: Record<string, string>
  mountPath: string
  storageStatus?: string
  mountEnabled?: boolean
}): Promise<{ storageId: string; mountId: string }> {
  const storageId = newId()
  const mountId = newId()
  const now = Date.now()
  const secret = options.credentials && Object.keys(options.credentials).length > 0
    ? await encryptCloudDriveCredentials(env, storageId, options.credentials)
    : ''
  await db.prepare(
    `INSERT INTO CloudDrive_storages
       (user_id, id, name, type, config, credentials, status, is_default, api_key_visible, read_quota,
        default_path, last_used_at, last_test_at, last_test_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, '/', NULL, NULL, NULL, ?, ?)`,
  ).bind(
    options.userId, storageId, options.mountPath, options.type, JSON.stringify(options.config), secret,
    options.storageStatus ?? 'enabled', now, now,
  ).run()
  await db.prepare(
    `INSERT INTO CloudDrive_mounts
       (user_id, id, storage_id, name, mount_path, read_only, cache_ttl, web_proxy, webdav_policy, weight,
        sort_order, enabled, created_at, updated_at)
     VALUES (?, ?, ?, 'Drive', ?, 1, 300, 0, 'native_proxy', 1, 0, ?, ?, ?)`,
  ).bind(
    options.userId, mountId, storageId, options.mountPath,
    options.mountEnabled === false ? 0 : 1, now, now,
  ).run()
  return { storageId, mountId }
}

function rowOf(storageId: string, userId: string, type: string, config: Record<string, unknown>, credentials: Record<string, string> = {}) {
  return {
    id: storageId,
    user_id: userId,
    type,
    config: JSON.stringify(config),
    credentials: Object.keys(credentials).length > 0 ? JSON.stringify(credentials) : '',
  }
}

describe('cross-mount resolver', () => {
  it('resolves an owned enabled mount and lists its entries', async () => {
    const owner = 'user-a'
    const target = await insertMount({
      userId: owner,
      type: 'virtual',
      config: { numFile: 3, numFolder: 2, minFileSize: 0, maxFileSize: 100, rootPath: '/' },
      mountPath: '/target',
    })
    const chunk = await insertMount({
      userId: owner,
      type: 'chunk',
      config: { remotePath: '/target', partSize: 1024, rootPath: '/' },
      mountPath: '/chunk',
    })
    const driver = await createStorageDriver(
      env,
      rowOf(chunk.storageId, owner, 'chunk', { remotePath: '/target', partSize: 1024, rootPath: '/' }),
      { id: chunk.mountId, mountPath: '/chunk' },
    )
    expect(driver).not.toBeNull()
    expect((await driver!.test()).ok).toBe(true)
    const listing = await driver!.list('/')
    expect(listing.entries.some((entry) => entry.name === 'folder_0')).toBe(true)
    expect(target.mountId).toBeTruthy()
  })

  it('rejects a self reference as a circular mount', async () => {
    const owner = 'user-a'
    const chunk = await insertMount({
      userId: owner,
      type: 'chunk',
      config: { remotePath: '/chunk', partSize: 1024, rootPath: '/' },
      mountPath: '/chunk',
    })
    const driver = await createStorageDriver(
      env,
      rowOf(chunk.storageId, owner, 'chunk', { remotePath: '/chunk', partSize: 1024, rootPath: '/' }),
      { id: chunk.mountId, mountPath: '/chunk' },
    )
    const result = await driver!.test()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Circular mount reference')
  })

  it('refuses a mount owned by another user', async () => {
    const owner = 'user-a'
    await insertMount({
      userId: 'user-b',
      type: 'virtual',
      config: { numFile: 1, numFolder: 1, minFileSize: 0, maxFileSize: 10, rootPath: '/' },
      mountPath: '/foreign',
    })
    const chunk = await insertMount({
      userId: owner,
      type: 'chunk',
      config: { remotePath: '/foreign', partSize: 1024, rootPath: '/' },
      mountPath: '/chunk',
    })
    const driver = await createStorageDriver(
      env,
      rowOf(chunk.storageId, owner, 'chunk', { remotePath: '/foreign', partSize: 1024, rootPath: '/' }),
      { id: chunk.mountId, mountPath: '/chunk' },
    )
    const result = await driver!.test()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('No enabled mount')
  })

  it('refuses the primary mount so wrapper drivers never expose raw R2 keys', async () => {
    const owner = 'user-a'
    const now = Date.now()
    await db.prepare(
      `INSERT INTO CloudDrive_mounts
         (user_id, id, storage_id, name, mount_path, read_only, cache_ttl, web_proxy, webdav_policy, weight,
          sort_order, enabled, created_at, updated_at)
       VALUES (?, 'primary', 'primary', 'Primary', '/', 0, 300, 0, 'native_proxy', 1, 0, 1, ?, ?)`,
    ).bind(owner, now, now).run()
    const chunk = await insertMount({
      userId: owner,
      type: 'chunk',
      config: { remotePath: '/', partSize: 1024, rootPath: '/' },
      mountPath: '/chunk-primary',
    })
    const driver = await createStorageDriver(
      env,
      rowOf(chunk.storageId, owner, 'chunk', { remotePath: '/', partSize: 1024, rootPath: '/' }),
      { id: chunk.mountId, mountPath: '/chunk-primary' },
    )
    const result = await driver!.test()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('logical D1 view')
  })

  it('refuses a mount whose storage is disabled', async () => {
    const owner = 'user-a'
    await insertMount({
      userId: owner,
      type: 'virtual',
      config: { numFile: 1, numFolder: 1, minFileSize: 0, maxFileSize: 10, rootPath: '/' },
      mountPath: '/disabled',
      storageStatus: 'disabled',
    })
    const chunk = await insertMount({
      userId: owner,
      type: 'chunk',
      config: { remotePath: '/disabled', partSize: 1024, rootPath: '/' },
      mountPath: '/chunk',
    })
    const driver = await createStorageDriver(
      env,
      rowOf(chunk.storageId, owner, 'chunk', { remotePath: '/disabled', partSize: 1024, rootPath: '/' }),
      { id: chunk.mountId, mountPath: '/chunk' },
    )
    const result = await driver!.test()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('disabled storage')
  })
})

describe('config write-back', () => {
  it('persists url_tree edits into the storage config row', async () => {
    const owner = 'user-a'
    const tree = await insertMount({
      userId: owner,
      type: 'url_tree',
      config: { urlStructure: 'Movies:\n  readme:https://cdn.example/readme.txt', writable: true, rootPath: '/' },
      mountPath: '/tree',
    })
    const config = { urlStructure: 'Movies:\n  readme:https://cdn.example/readme.txt', writable: true, rootPath: '/' }
    const driver = await createStorageDriver(env, rowOf(tree.storageId, owner, 'url_tree', config), { id: tree.mountId, mountPath: '/tree' })
    await driver!.mkdir('/New')
    const stored = await db.prepare('SELECT config FROM CloudDrive_storages WHERE id = ?')
      .bind(tree.storageId).first<{ config: string }>()
    expect(stored!.config).toContain('New:')
    const reloaded = await createStorageDriver(env, {
      id: tree.storageId, user_id: owner, type: 'url_tree', config: stored!.config, credentials: '',
    }, { id: tree.mountId, mountPath: '/tree' })
    const listing = await reloaded!.list('/')
    expect(listing.entries.map((entry) => entry.name)).toContain('New')
  })
})

describe('R2 binding mode', () => {
  it('serves the primary bucket through the driver contract', async () => {
    const owner = 'user-a'
    const r2 = await insertMount({
      userId: owner,
      type: 'r2',
      config: { mode: 'binding', rootPath: '/' },
      mountPath: '/r2',
    })
    const driver = await createStorageDriver(
      env,
      rowOf(r2.storageId, owner, 'r2', { mode: 'binding', rootPath: '/' }),
      { id: r2.mountId, mountPath: '/r2' },
    )
    await driver!.upload('/a.txt', new TextEncoder().encode('hello'), { size: 5, contentType: 'text/plain' })
    const listing = await driver!.list('/')
    expect(listing.entries.map((entry) => entry.name)).toContain('a.txt')
    const response = await driver!.read('/a.txt', 'bytes=1-3')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('ell')
    expect(await driver!.directLink!('/a.txt')).toBeNull()
  })
})

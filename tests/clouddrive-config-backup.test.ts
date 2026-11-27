// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { CLOUDDRIVE_SCHEMA_STATEMENTS } from '../src/worker/clouddrive/schema'
import { clouddriveRoutes } from '../src/worker/clouddrive/routes'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'
import { createUsersTable } from './doubles/users-table'

const USER = '0123456789abcdefghjkmnpqrs'
let sqlite: DatabaseSync
let db: D1Database
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of CLOUDDRIVE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  createUsersTable(sqlite)
  db = makeD1(sqlite)
  env = testBindings(db)
})

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((error, c) => errorResponse(c, error))
  instance.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('user', {
      id: USER,
      username: 'tester',
      login: 'tester',
      name: 'Tester',
      avatarUrl: '',
      role: 'owner',
      createdAt: 1,
      settingsRaw: '{}',
    })
    await next()
  })
  instance.route('/api/clouddrive', clouddriveRoutes)
  return instance
}

describe('CloudDrive config backup', () => {
  it('exports mappings and policies without credentials or password hashes', async () => {
    await db.prepare(
      `INSERT INTO CloudDrive_storages
        (user_id, id, name, type, config, credentials, status, is_default, created_at, updated_at)
       VALUES (?, 'storage-1', 'Archive', 's3', '{"endpoint":"https://s3.example.com"}', 'encrypted-secret', 'enabled', 0, 1, 1)`,
    ).bind(USER).run()
    await db.prepare(
      `INSERT INTO CloudDrive_settings (user_id, key, value, updated_at) VALUES (?, 'webdav.passwordHash', 'password-hash', 1)`,
    ).bind(USER).run()
    await db.prepare(
      `INSERT INTO CloudDrive_shares
        (slug, user_id, target_kind, file_id, mount_id, path, name, password_hash, created_at)
       VALUES ('share-1', ?, 'file', 'file-1', 'primary', '/a.txt', 'a.txt', 'share-hash', 1)`,
    ).bind(USER).run()
    await db.prepare(
      `INSERT INTO CloudDrive_meta
        (user_id, mount_id, path, password_hash, created_at, updated_at)
       VALUES (?, 'primary', '/private', 'meta-hash', 1, 1)`,
    ).bind(USER).run()

    const response = await app().fetch(new Request('http://localhost/api/clouddrive/config/export'), env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="clouddrive-config-/)
    const text = await response.text()
    const backup = JSON.parse(text) as {
      version: number
      storages: Array<{ credentials?: string }>
      shares: Array<{ password_hash?: string }>
      meta: Array<{ password_hash?: string }>
      settings: { webdavHasPassword?: boolean }
    }
    expect(backup.version).toBe(1)
    expect(backup.storages).toHaveLength(1)
    expect(backup.storages[0]).not.toHaveProperty('credentials')
    expect(backup.shares[0]).not.toHaveProperty('password_hash')
    expect(backup.meta[0]).not.toHaveProperty('password_hash')
    expect(backup.settings.webdavHasPassword).toBe(true)
    expect(text).not.toContain('encrypted-secret')
    expect(text).not.toContain('password-hash')
    expect(text).not.toContain('share-hash')
    expect(text).not.toContain('meta-hash')
  })
})

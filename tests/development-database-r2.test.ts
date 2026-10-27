// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEVELOPMENT_DATABASE_SCHEMA_STATEMENTS } from '../src/worker/development/database/schema'
import {
  cleanupExpiredExports,
  deleteExportObject,
  exportContentDisposition,
  exportKey,
  putExport,
  readExportObject,
} from '../src/worker/development/database/r2'
import {
  findExport,
  insertExport,
  listExpiredExports,
} from '../src/worker/development/database/store'
import { EXPORT_TTL_MS, MAX_EXPORT_BYTES } from '../src/shared/development/database/types'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket } from './doubles/bindings'
import type { TestR2Bucket } from './doubles/bindings'

const USER = 'user-a'

let sqlite: DatabaseSync
let db: D1Database
let bucket: TestR2Bucket
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of DEVELOPMENT_DATABASE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  bucket = testR2Bucket()
  env = testBindings(db, { FILES: bucket })
})

afterEach(() => {
  sqlite.close()
})

describe('export keys and objects', () => {
  it('uses the documented key path and content type', async () => {
    expect(exportKey('csv', 'user-a', 'file-1')).toBe('development/database/csv/user-a/file-1.csv')
    expect(exportKey('json', 'user-a', 'file-2')).toBe(
      'development/database/json/user-a/file-2.json',
    )
    expect(exportKey('sql', 'user-a', 'file-3')).toBe('development/database/sql/user-a/file-3.sql')
    expect(exportKey('txt', 'user-a', 'file-4')).toBe('development/database/txt/user-a/file-4.txt')

    const written = await putExport(env, {
      userId: USER,
      id: 'file-1',
      format: 'csv',
      content: 'id,name\n1,alpha\n',
    })
    expect(written.key).toBe('development/database/csv/user-a/file-1.csv')
    expect(written.size).toBe(16)
    expect(bucket.objects.get(written.key)).toEqual(new TextEncoder().encode('id,name\n1,alpha\n'))
    expect(bucket.types.get(written.key)).toBe('text/csv; charset=utf-8')

    const object = await readExportObject(env, written.key)
    expect(await object.text()).toBe('id,name\n1,alpha\n')

    await deleteExportObject(env, written.key)
    expect(bucket.objects.has(written.key)).toBe(false)
  })

  it('refuses unknown owners and missing objects', async () => {
    await expect(
      putExport(env, { userId: '../escape', id: 'file-1', format: 'csv', content: 'x' }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(readExportObject(env, 'development/database/csv/user-a/none.csv')).rejects.toMatchObject(
      { status: 404, code: 'not_found' },
    )
  })

  it('enforces the 8 MB byte limit even for multibyte content', async () => {
    const content = '数'.repeat(3_000_000)
    expect(new TextEncoder().encode(content).byteLength).toBeGreaterThan(MAX_EXPORT_BYTES)
    await expect(
      putExport(env, { userId: USER, id: 'big', format: 'txt', content }),
    ).rejects.toMatchObject({ status: 413 })
    expect(bucket.objects.size).toBe(0)
  })

  it('answers 503 when the FILES binding is missing', async () => {
    const withoutFiles = testBindings(db)
    await expect(
      putExport(withoutFiles, { userId: USER, id: 'file-1', format: 'csv', content: 'x' }),
    ).rejects.toMatchObject({ status: 503, code: 'storage_unavailable' })
    await expect(readExportObject(withoutFiles, 'any')).rejects.toMatchObject({
      status: 503,
      code: 'storage_unavailable',
    })
  })
})

describe('export cleanup', () => {
  it('removes records and objects older than 24 hours only', async () => {
    const now = Date.now()
    const oldKey = exportKey('txt', USER, 'old')
    const freshKey = exportKey('txt', USER, 'fresh')
    await bucket.put(oldKey, 'old')
    await bucket.put(freshKey, 'fresh')
    await insertExport(db, USER, {
      id: 'old',
      filename: 'old.txt',
      format: 'txt',
      r2Key: oldKey,
      size: 3,
      createdAt: now - EXPORT_TTL_MS - 1_000,
    })
    await insertExport(db, USER, {
      id: 'fresh',
      filename: 'fresh.txt',
      format: 'txt',
      r2Key: freshKey,
      size: 5,
      createdAt: now - 1_000,
    })

    expect((await listExpiredExports(db, USER, now - EXPORT_TTL_MS)).map((record) => record.id)).toEqual(
      ['old'],
    )
    await cleanupExpiredExports(env, db, USER)

    expect(bucket.objects.has(oldKey)).toBe(false)
    expect(bucket.objects.has(freshKey)).toBe(true)
    expect(await findExport(db, USER, 'old')).toBeNull()
    expect(await findExport(db, USER, 'fresh')).not.toBeNull()
  })
})

describe('content disposition', () => {
  it('offers an ASCII fallback and an RFC 5987 UTF-8 name', () => {
    expect(exportContentDisposition('data.csv')).toBe(
      'attachment; filename="data.csv"; filename*=UTF-8\'\'data.csv',
    )

    const header = exportContentDisposition('数据"\r\n.csv')
    expect(header.startsWith('attachment; filename="')).toBe(true)
    expect(header).toContain('filename="___.csv"')
    expect(header).toContain("filename*=UTF-8''%E6%95%B0%E6%8D%AE_.csv")
    expect(header).not.toContain('\r')
    expect(header).not.toContain('\n')
  })

  it('falls back to a non-empty name', () => {
    expect(exportContentDisposition('   ')).toBe(
      'attachment; filename="export"; filename*=UTF-8\'\'export',
    )
  })
})

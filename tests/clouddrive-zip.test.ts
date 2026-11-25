// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { CLOUDDRIVE_SCHEMA_STATEMENTS } from '../src/worker/clouddrive/schema'
import { buildFolderZip } from '../src/worker/clouddrive/zip'
import type { CloudDriveMountInfo } from '../src/worker/clouddrive/lib'
import { initialsOf } from '../src/worker/clouddrive/lib'
import { foldedName } from '../src/shared/clouddrive/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testR2Bucket } from './doubles/bindings'
import type { Env } from '../src/worker/env'

const USER = '0123456789abcdefghjkmnpqrs'
const mount: CloudDriveMountInfo = {
  id: 'primary',
  name: 'Cloud Drive',
  mountPath: '/',
  storageId: 'primary',
  storageType: 'r2',
  readOnly: false,
  enabled: true,
  webProxy: false,
  webdavPolicy: 'native_proxy',
  folderSummary: false,
  cacheTtl: 300,
  signExpires: null,
}

describe('CloudDrive ZIP streaming', () => {
  it('opens objects lazily with bounded prefetch', async () => {
    const sqlite = new DatabaseSync(':memory:')
    for (const statement of CLOUDDRIVE_SCHEMA_STATEMENTS) sqlite.exec(statement)
    const db = makeD1(sqlite)
    const bucket = testR2Bucket()
    let opened = 0
    const originalGet = bucket.get.bind(bucket)
    bucket.get = (async (...args: Parameters<typeof bucket.get>) => {
      opened++
      return originalGet(...args)
    }) as typeof bucket.get

    for (let index = 0; index < 20; index++) {
      const name = `${index}.txt`
      const key = `CloudDrive/txt/${index}`
      await bucket.put(key, new TextEncoder().encode(name))
      await db.prepare(
        `INSERT INTO CloudDrive_files
          (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path,
           category, mime, size, storage_kind, storage_key, created_at, updated_at, uploaded_at, modified_at)
         VALUES (?, ?, 'primary', '', 'file', ?, ?, ?, ?, 'txt', 'text/plain', ?, 'r2', ?, 1, 1, 1, 1)`,
      ).bind(`file-${index}`, USER, name, foldedName(name), initialsOf(name), `/${name}`, name.length, key).run()
    }

    const env = { DB: db, FILES: bucket } as Env
    const archive = await buildFolderZip(env, db, USER, mount, '/', () => false)
    expect(opened).toBeLessThanOrEqual(8)
    const reader = archive.stream.getReader()
    while (!(await reader.read()).done) {}
    expect(opened).toBe(20)
  })
})

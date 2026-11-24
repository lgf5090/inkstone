// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { OFFICE_BACKUP_PREFIX, writeOfficeBackup } from '../src/worker/office/backup'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket } from './doubles/bindings'

/**
 * One backup is a manifest plus the bytes it points at, written under its own stamp.
 *
 * The assertions read the objects back: a manifest that names a file whose bytes were never copied
 * would restore into a file that cannot open.
 */

const USER = 'user-alpha'
const NOW = Date.UTC(2026, 10, 24, 3, 0, 0)
const ASSET = 'asset0000000000000000000001'

let sqlite: DatabaseSync
let bucket: ReturnType<typeof testR2Bucket>
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  bucket = testR2Bucket()
  env = testBindings(makeD1(sqlite), { FILES: bucket }) as unknown as Env

  sqlite.prepare(
    `INSERT INTO office_file (user_id, id, type, title, snapshot_key, rev, size, content_hash, created_at, updated_at)
     VALUES (?, 'file0000000000000000000001', 'sheets', 'Sheet', 'office/txt/snap-1', 1, 40, '', ?, ?)`,
  ).run(USER, NOW - 1000, NOW - 1000)
  sqlite.prepare(
    `INSERT INTO office_asset (user_id, id, name, mime, size, object_key, created_at, last_used_at)
     VALUES (?, ?, 'image.png', 'image/png', 3, 'office/asset/x.png', ?, ?)`,
  ).run(USER, ASSET, NOW - 1000, NOW - 1000)
})

describe('writeOfficeBackup', () => {
  it('writes the manifest, the snapshots and the assets it names', async () => {
    await bucket.put('office/txt/snap-1', `<img src="/api/office/assets/${ASSET}">`)
    await bucket.put('office/asset/x.png', 'png')

    const result = await writeOfficeBackup(env, USER, NOW)

    expect(result.files).toBe(1)
    expect(result.objects).toBe(1)
    expect(result.key.startsWith(OFFICE_BACKUP_PREFIX)).toBe(true)
    const manifest = await bucket.get(result.key)
    expect(manifest).not.toBeNull()
    const parsed = JSON.parse(await manifest!.text()) as { files: unknown[]; objects: Array<{ key: string }> }
    expect(parsed.files).toHaveLength(1)
    expect(parsed.objects.map((entry) => entry.key)).toContain(`${OFFICE_BACKUP_PREFIX}${new Date(NOW).toISOString().replace(/[:.]/g, '-')}/assets/${ASSET}`)
  })

  it('keeps going when a snapshot object is missing', async () => {
    const result = await writeOfficeBackup(env, USER, NOW)
    expect(result.files).toBe(1)
    expect(result.objects).toBe(0)
  })
})

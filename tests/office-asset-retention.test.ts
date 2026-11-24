// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { OFFICE_ASSET_GRACE_MS, collectAssetIds, runOfficeAssetRetention } from '../src/worker/office/asset-retention'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket } from './doubles/bindings'

/**
 * The asset sweep: an unreferenced asset goes, a referenced one stays, and a young one is left alone.
 *
 * Reference is read from the snapshot itself — the asset table has no back-reference — so the test
 * writes the same `/api/office/assets/<id>` shape an image node stores.
 */

const USER = 'user-alpha'
const NOW = 1_800_000_000_000
const OLD = NOW - OFFICE_ASSET_GRACE_MS - 1
const FRESH = NOW - 1_000

let sqlite: DatabaseSync
let bucket: ReturnType<typeof testR2Bucket>
let env: Env

function insertAsset(id: string, lastUsedAt: number): string {
  const key = `office/asset/${USER}/${id}.png`
  sqlite.prepare(
    `INSERT INTO office_asset (user_id, id, name, mime, size, object_key, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(USER, id, 'image.png', 'image/png', 10, key, OLD, lastUsedAt)
  return key
}

function insertFile(id: string, snapshotKey: string): void {
  sqlite.prepare(
    `INSERT INTO office_file (user_id, id, type, title, snapshot_key, rev, size, content_hash, created_at, updated_at)
     VALUES (?, ?, 'sheets', 'Sheet', ?, 1, 10, '', ?, ?)`,
  ).run(USER, id, snapshotKey, OLD, OLD)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  bucket = testR2Bucket()
  env = testBindings(makeD1(sqlite), { FILES: bucket }) as unknown as Env
})

describe('collectAssetIds', () => {
  it('reads the ids a snapshot mentions, once each', () => {
    const ids = collectAssetIds('{"src":"/api/office/assets/abc123def456gh"} {"src":"/api/office/assets/abc123def456gh"}')
    expect([...ids]).toEqual(['abc123def456gh'])
  })

  it('ignores text that is not an asset url', () => {
    expect(collectAssetIds('/api/office/files/01m7zbhpq544r0tw3dzjnhmsex').size).toBe(0)
  })
})

describe('runOfficeAssetRetention', () => {
  it('deletes an old asset no snapshot shows, and keeps what is shown', async () => {
    const kept = insertAsset('keptasset0000000000000001', OLD)
    const orphan = insertAsset('orphanasset00000000000001', OLD)
    await bucket.put(kept, 'png')
    await bucket.put(orphan, 'png')
    insertFile('file0000000000000000000001', 'office/txt/snap-1')
    await bucket.put('office/txt/snap-1', `<img src="/api/office/assets/keptasset0000000000000001">`)

    const result = await runOfficeAssetRetention(env, NOW)

    expect(result).toEqual({ candidates: 2, deleted: 1 })
    const remaining = sqlite.prepare(`SELECT id FROM office_asset ORDER BY id`).all() as { id: string }[]
    expect(remaining.map((row) => row.id)).toEqual(['keptasset0000000000000001'])
    expect(await bucket.get(orphan)).toBeNull()
    expect(await bucket.get(kept)).not.toBeNull()
  })

  it('leaves an asset inside the grace period alone', async () => {
    insertAsset('youngasset0000000000000001', FRESH)
    const result = await runOfficeAssetRetention(env, NOW)
    expect(result).toEqual({ candidates: 0, deleted: 0 })
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM office_asset`).get()).toEqual({ n: 1 })
  })
})

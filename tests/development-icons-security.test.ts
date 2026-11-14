// @vitest-environment node
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/worker/db/schema'
import {
  createJob,
  deleteAsset,
  getAsset,
  recordJobOutput,
  usageFor,
} from '../src/worker/development/icons/store'
import { createMinuteBudget } from '../src/worker/lib/rate-limit'
import { iconFormatFromMime } from '../src/shared/development/icons/formats'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

let sqlite: DatabaseSync
let db: ReturnType<typeof makeD1>

async function seedAsset(userId: string, id: string, bytes = 100): Promise<void> {
  const sha = createHash('sha256').update(`${userId}:${id}`).digest('hex')
  await db.prepare(
    `INSERT INTO development_icons_assets
       (user_id, id, collection_id, name, name_key, format, mime, bytes, width, height, view_box, sha256, r2_key, thumb_key, keywords, color_mode, license, source_url, sanitized, created_at, updated_at)
     VALUES (?1, ?2, NULL, ?2, ?2, 'svg', 'image/svg+xml', ?3, NULL, NULL, NULL, ?4, ?5, NULL, '', 'mono', '', '', 1, 1, 1)`,
  ).bind(userId, id, bytes, sha, `development/icons/svg/u00000000/00/00/${id}.svg`).run()
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  db = makeD1(sqlite)
  await initializeDatabase(testBindings(db))
  await seedAsset('user-a', 'asset-a')
  await seedAsset('user-b', 'asset-b')
})

describe('icon ownership', () => {
  it('refuses to read another user’s asset', async () => {
    await expect(getAsset(db, 'user-a', 'asset-b')).rejects.toThrow()
    await expect(getAsset(db, 'user-a', 'asset-a')).resolves.toMatchObject({ id: 'asset-a' })
  })

  it('refuses to delete another user’s asset', async () => {
    await expect(deleteAsset(db, 'user-a', 'asset-b')).rejects.toThrow()
    expect(await db.prepare(`SELECT id FROM development_icons_assets WHERE id='asset-b'`).first()).toBeTruthy()
  })

  it('refuses a conversion task that names an asset the caller does not own', async () => {
    await expect(createJob(db, 'user-a', ['asset-a', 'asset-b'], { kind: 'png', sizes: [24] }, 'browser')).rejects.toThrow()
    const rows = await db.prepare(`SELECT COUNT(*) AS n FROM development_icons_jobs WHERE user_id='user-a'`).first<{ n: number }>()
    expect(Number(rows?.n ?? 0)).toBe(0)
  })

  it('creates a task for owned assets', async () => {
    const job = await createJob(db, 'user-a', ['asset-a'], { kind: 'png', sizes: [24] }, 'browser')
    expect(job).toMatchObject({ mode: 'browser', status: 'queued', totalItems: 1 })
  })

  it('chunks ownership checks and item inserts past the D1 parameter ceiling', async () => {
    const ids = Array.from({ length: 120 }, (_, index) => `bulk-${index}`)
    for (const id of ids) await seedAsset('user-a', id)
    const job = await createJob(db, 'user-a', ids, { kind: 'png', sizes: [24] }, 'browser')
    expect(job.totalItems).toBe(120)
    const count = await db.prepare(`SELECT COUNT(*) AS n FROM development_icons_job_items WHERE user_id='user-a' AND job_id=?1`).bind(job.id).first<{ n: number }>()
    expect(Number(count?.n ?? 0)).toBe(120)
  })
})

describe('icon quota accounting', () => {
  it('counts outputs and unexpired exports', async () => {
    const before = await usageFor(db, 'user-a')
    expect(before.usedBytes).toBe(100)
    await recordJobOutput(db, 'user-a', 'job-1', 'asset-a', '24', 'development/icons/png/u00000000/00/00/a-w24.png', 40, 'a'.repeat(64))
    await db.prepare(
      `INSERT INTO development_icons_exports (user_id,id,format,filename,r2_key,bytes,asset_count,status,error,created_at,expires_at)
       VALUES ('user-a','export-1','zip','x.zip','key',60,1,'done','',1,?1)`,
    ).bind(Date.now() + 60_000).run()
    const after = await usageFor(db, 'user-a')
    expect(after).toMatchObject({ usedBytes: 200, assetsBytes: 100, outputsBytes: 40, exportsBytes: 60, overQuota: false })
  })
})

describe('icon rate limit', () => {
  it('answers 429 after the per-minute budget', () => {
    const spend = createMinuteBudget(2, 'too many')
    spend('user-a')
    spend('user-a')
    expect(() => spend('user-a')).toThrowError(/too many/)
    expect(() => spend('user-b')).not.toThrow()
  })
})

describe('ZIP is not an upload format', () => {
  it('rejects archive MIME types before any unpacking can happen', () => {
    expect(iconFormatFromMime('application/zip')).toBeNull()
    expect(iconFormatFromMime('application/x-zip-compressed')).toBeNull()
    expect(iconFormatFromMime('image/png')).toBe('png')
  })
})

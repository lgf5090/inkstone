// @vitest-environment node
// Recording retention marks the D1 row before deleting the R2 object, retries a failed delete, and
// is safe to run repeatedly. The cron entry point (`runWebsshRetention`) drives the same sweep.

import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeD1 } from './doubles/d1-sqlite'
import { testR2Bucket } from './doubles/bindings'
import type { Env } from '../src/worker/env'
import { runWebsshRetention } from '../src/worker/webssh/retention'
import { purgeExpiredRecordings } from '../src/worker/webssh/recording/retention'
import { newId } from '../src/worker/lib/id'

let sqlite: DatabaseSync
let db: D1Database
let bucket: ReturnType<typeof testR2Bucket>
let env: Env

function insertRecording(input: {
  id?: string
  r2Key: string
  status?: string
  expiresAt: number
  deletedAt?: number | null
}): string {
  const id = input.id ?? newId()
  sqlite.prepare(
    `INSERT INTO webssh_recordings
       (id, user_id, session_id, host_id, format, r2_key, size_bytes, duration_ms, cols, rows,
        status, visibility, created_at, finalized_at, expires_at, deleted_at)
     VALUES (?, ?, ?, ?, 'cast', ?, 10, 1000, 100, 30, ?, 'private', 100, 200, ?, ?)`,
  ).run(
    id,
    newId(),
    newId(),
    newId(),
    input.r2Key,
    input.status ?? 'ready',
    input.expiresAt,
    input.deletedAt ?? null,
  )
  return id
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE webssh_session_tickets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
    CREATE TABLE webssh_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      ended_at INTEGER,
      close_reason TEXT NOT NULL DEFAULT '',
      error_code TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE webssh_recordings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'cast',
      r2_key TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      cols INTEGER NOT NULL DEFAULT 0,
      rows INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'recording',
      visibility TEXT NOT NULL DEFAULT 'private',
      created_at INTEGER NOT NULL,
      finalized_at INTEGER,
      expires_at INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER
    );
    CREATE TABLE webssh_audit_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      host_id TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      ip_hash TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `)
  db = makeD1(sqlite)
  bucket = testR2Bucket()
  env = { DB: db, FILES: bucket } as unknown as Env
})

afterEach(() => {
  sqlite.close()
})

describe('recording retention', () => {
  it('removes only expired objects, marking rows before deleting', async () => {
    const now = 1_000_000
    const expiredReady = insertRecording({ r2Key: 'webssh/txt/recordings/a.cast', expiresAt: now - 1 })
    const expiredRecording = insertRecording({
      r2Key: 'webssh/txt/recordings/b.cast',
      status: 'recording',
      expiresAt: now - 1,
    })
    const fresh = insertRecording({ r2Key: 'webssh/txt/recordings/c.cast', expiresAt: now + 1_000 })
    bucket.objects.set('webssh/txt/recordings/a.cast', new Uint8Array([1]))
    bucket.objects.set('webssh/txt/recordings/b.cast', new Uint8Array([2]))
    bucket.objects.set('webssh/txt/recordings/c.cast', new Uint8Array([3]))

    expect(await purgeExpiredRecordings(env, now)).toBe(2)
    expect(bucket.objects.has('webssh/txt/recordings/a.cast')).toBe(false)
    expect(bucket.objects.has('webssh/txt/recordings/b.cast')).toBe(false)
    expect(bucket.objects.has('webssh/txt/recordings/c.cast')).toBe(true)

    const rows = sqlite.prepare('SELECT id, status, deleted_at FROM webssh_recordings ORDER BY id').all() as Array<{
      id: string
      status: string
      deleted_at: number | null
    }>
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get(expiredReady)).toMatchObject({ status: 'deleted', deleted_at: now })
    expect(byId.get(expiredRecording)).toMatchObject({ status: 'deleted', deleted_at: now })
    expect(byId.get(fresh)).toMatchObject({ status: 'ready', deleted_at: null })

    // A second fire finds nothing left and does not rewrite the fresh row.
    expect(await purgeExpiredRecordings(env, now)).toBe(0)
  })

  it('marks the row first, retries an R2 failure, and completes once the store answers', async () => {
    const now = 2_000_000
    const key = 'webssh/txt/recordings/d.cast'
    const id = insertRecording({ r2Key: key, expiresAt: now - 1 })
    bucket.objects.set(key, new Uint8Array([4]))

    const failing = Object.create(bucket) as typeof bucket
    ;(failing as unknown as { delete: (key: string) => Promise<void> }).delete = async () => {
      throw new Error('r2 unavailable')
    }
    env.FILES = failing
    expect(await purgeExpiredRecordings(env, now)).toBe(0)
    const afterFailure = sqlite.prepare('SELECT status, deleted_at FROM webssh_recordings WHERE id = ?').get(id)
    expect(afterFailure).toMatchObject({ status: 'ready', deleted_at: now })
    expect(bucket.objects.has(key)).toBe(true)
    expect(sqlite.prepare("SELECT event_type, metadata FROM webssh_audit_events WHERE event_type = 'retention_fail'").get())
      .toMatchObject({ event_type: 'retention_fail' })

    env.FILES = bucket
    expect(await purgeExpiredRecordings(env, now)).toBe(1)
    expect(sqlite.prepare('SELECT status FROM webssh_recordings WHERE id = ?').get(id)).toEqual({ status: 'deleted' })
    expect(bucket.objects.has(key)).toBe(false)
  })

  it('runs the recording sweep from the cron entry point', async () => {
    const now = 3_000_000
    const key = 'webssh/txt/recordings/e.cast'
    const id = insertRecording({ r2Key: key, expiresAt: now - 1 })
    bucket.objects.set(key, new Uint8Array([5]))

    const removed = await runWebsshRetention(env, now)
    expect(removed).toBe(1)
    expect(sqlite.prepare('SELECT status FROM webssh_recordings WHERE id = ?').get(id)).toEqual({ status: 'deleted' })
    expect(bucket.objects.has(key)).toBe(false)
  })
})

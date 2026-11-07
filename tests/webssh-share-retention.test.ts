// @vitest-environment node
// W7 retention: a link never outlives its recording, expired links are collected in the same hourly
// fire, and abandoned SFTP staging objects are swept only when the transfer is old and its account
// has no live session.

import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeD1 } from './doubles/d1-sqlite'
import { testR2Bucket } from './doubles/bindings'
import type { Env } from '../src/worker/env'
import { runWebsshRetention } from '../src/worker/webssh/retention'
import {
  purgeStagingUploads,
  WEBSSH_STAGING_UPLOAD_PREFIX,
  WEBSSH_STAGING_UPLOAD_TTL_MS,
} from '../src/worker/webssh/staging'

let sqlite: DatabaseSync
let db: D1Database
let bucket: ReturnType<typeof testR2Bucket>
let env: Env

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
      status TEXT NOT NULL DEFAULT 'recording',
      expires_at INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER
    );
    CREATE TABLE webssh_shares (
      slug TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      recording_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      passcode_hash TEXT NOT NULL DEFAULT '',
      expires_at INTEGER NOT NULL DEFAULT 0,
      max_views INTEGER NOT NULL DEFAULT 0,
      views INTEGER NOT NULL DEFAULT 0,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_viewed_at INTEGER
    );
    CREATE TABLE share_asset_sessions (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
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

function insertRecording(input: {
  recordingId: string
  userId: string
  r2Key: string
  expiresAt: number
  status?: string
  deletedAt?: number | null
}): void {
  sqlite.prepare(
    `INSERT INTO webssh_recordings
       (id, user_id, session_id, host_id, r2_key, status, expires_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.recordingId,
    input.userId,
    'session-1',
    'host-1',
    input.r2Key,
    input.status ?? 'ready',
    input.expiresAt,
    input.deletedAt ?? null,
  )
}

function insertShare(input: { slug: string; userId: string; recordingId: string; expiresAt: number }): void {
  sqlite.prepare(
    `INSERT INTO webssh_shares (slug, user_id, recording_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, 1)`,
  ).run(input.slug, input.userId, input.recordingId, input.expiresAt)
  sqlite.prepare(
    `INSERT INTO share_asset_sessions (id, slug, password_hash, expires_at, created_at)
     VALUES (?, ?, '', ?, 1)`,
  ).run(`token-${input.slug}`, input.slug, input.expiresAt)
}

describe('share retention', () => {
  it('removes the link and its tokens when the recording expires in the same fire', async () => {
    const now = 2_000_000
    insertRecording({ recordingId: 'rec-1', userId: 'u1', r2Key: 'webssh/txt/recordings/u1/x.cast', expiresAt: now - 1 })
    insertShare({ slug: 'expired-recording', userId: 'u1', recordingId: 'rec-1', expiresAt: now + 10 })

    await runWebsshRetention(env, now)

    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM webssh_shares').get()).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM share_asset_sessions').get()).toEqual({ count: 0 })
    expect(sqlite.prepare("SELECT status FROM webssh_recordings WHERE id = 'rec-1'").get()).toEqual({ status: 'deleted' })
  })

  it('removes a link that is already gone or whose recording row is deleted, and keeps a live one', async () => {
    const now = 3_000_000
    insertRecording({ recordingId: 'rec-live', userId: 'u1', r2Key: 'k1', expiresAt: now + 100 })
    insertRecording({ recordingId: 'rec-deleted', userId: 'u1', r2Key: 'k2', expiresAt: now + 100, status: 'deleted' })
    insertShare({ slug: 'live', userId: 'u1', recordingId: 'rec-live', expiresAt: now + 100 })
    insertShare({ slug: 'expired', userId: 'u1', recordingId: 'rec-live', expiresAt: now - 1 })
    insertShare({ slug: 'gone-recording', userId: 'u1', recordingId: 'rec-deleted', expiresAt: now + 100 })
    insertShare({ slug: 'no-recording', userId: 'u1', recordingId: 'rec-missing', expiresAt: now + 100 })

    await runWebsshRetention(env, now)

    const slugs = (sqlite.prepare('SELECT slug FROM webssh_shares ORDER BY slug').all() as Array<{ slug: string }>)
      .map((row) => row.slug)
    expect(slugs).toEqual(['live'])
  })
})

describe('staging sweep', () => {
  const old = Date.now() - WEBSSH_STAGING_UPLOAD_TTL_MS - 1_000

  function stageTransfer(input: { userId: string; transferId: string; createdAt: number }): string {
    const prefix = `${WEBSSH_STAGING_UPLOAD_PREFIX}/${input.userId}/${input.transferId}`
    bucket.objects.set(`${prefix}/meta.json`, new TextEncoder().encode(JSON.stringify({
      path: '/tmp/file.bin',
      size: 10,
      transferId: input.transferId,
      createdAt: input.createdAt,
    })))
    bucket.objects.set(`${prefix}/parts/000000000000`, new TextEncoder().encode('0123456789'))
    return prefix
  }

  it('deletes an old interrupted transfer and is safe to run twice', async () => {
    const prefix = stageTransfer({ userId: 'u1', transferId: 'transfer-old', createdAt: old })
    expect(await purgeStagingUploads(env, Date.now())).toBe(1)
    expect([...bucket.objects.keys()].some((key) => key.startsWith(prefix))).toBe(false)
    expect(await purgeStagingUploads(env, Date.now())).toBe(0)
  })

  it('keeps a fresh transfer and one whose account still has a live session', async () => {
    const freshPrefix = stageTransfer({ userId: 'u1', transferId: 'transfer-fresh', createdAt: Date.now() })
    stageTransfer({ userId: 'u2', transferId: 'transfer-busy', createdAt: old })
    sqlite.prepare(
      `INSERT INTO webssh_sessions (id, user_id, host_id, status, started_at, last_activity_at)
       VALUES ('s1', 'u2', 'h1', 'active', 1, 1)`,
    ).run()

    expect(await purgeStagingUploads(env, Date.now())).toBe(0)
    expect([...bucket.objects.keys()].some((key) => key.startsWith(freshPrefix))).toBe(true)
    expect([...bucket.objects.keys()].some((key) => key.includes('transfer-busy'))).toBe(true)
  })

  it('falls back to the objects write time when the meta file is missing', async () => {
    const prefix = `${WEBSSH_STAGING_UPLOAD_PREFIX}/u1/transfer-orphan`
    bucket.objects.set(`${prefix}/parts/000000000000`, new TextEncoder().encode('01'))
    // The test bucket stamps uploads with "now", so a fresh orphan is still inside the window.
    expect(await purgeStagingUploads(env, Date.now())).toBe(0)
  })
})

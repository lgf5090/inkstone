// @vitest-environment node
// W2 retention: expired tickets disappear and abandoned session rows stop counting against the
// owner's live-session ceiling.

import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeD1 } from './doubles/d1-sqlite'
import type { Env } from '../src/worker/env'
import { runWebsshRetention } from '../src/worker/webssh/retention'
import { WEBSSH_IDLE_TIMEOUT_MS } from '../src/worker/webssh/constants'

let sqlite: DatabaseSync
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
  `)
  env = { DB: makeD1(sqlite) } as Env
})

afterEach(() => {
  sqlite.close()
})

describe('runWebsshRetention', () => {
  it('removes expired and long-consumed tickets but keeps a fresh consumed one', async () => {
    const now = 1_000_000
    const insert = sqlite.prepare(
      'INSERT INTO webssh_session_tickets (id, user_id, session_id, expires_at, created_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    insert.run('expired', 'u', 's', now - 1, now - 61_000, null)
    insert.run('old-consumed', 'u', 's', now + 100, now - 3_600_001, now - 3_600_001)
    insert.run('fresh-consumed', 'u', 's', now + 100, now - 60_000, now - 60_000)
    insert.run('live', 'u', 's', now + 100, now, null)

    const removed = await runWebsshRetention(env, now)
    expect(removed).toBe(2)
    const ids = (sqlite.prepare('SELECT id FROM webssh_session_tickets ORDER BY id').all() as Array<{ id: string }>).map((row) => row.id)
    expect(ids).toEqual(['fresh-consumed', 'live'])
  })

  it('closes abandoned pending/connecting and active rows idle past the window', async () => {
    const now = 2_000_000
    const insert = sqlite.prepare(
      'INSERT INTO webssh_sessions (id, user_id, host_id, status, started_at, last_activity_at, close_reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    insert.run('pending-stale', 'u', 'h', 'pending', now - WEBSSH_IDLE_TIMEOUT_MS - 1, now - WEBSSH_IDLE_TIMEOUT_MS - 1, '')
    insert.run('active-stale', 'u', 'h', 'active', now - WEBSSH_IDLE_TIMEOUT_MS - 1, now - WEBSSH_IDLE_TIMEOUT_MS - 1, '')
    insert.run('active-live', 'u', 'h', 'active', now - 60_000, now - 60_000, '')

    await runWebsshRetention(env, now)
    const rows = sqlite.prepare('SELECT id, status, close_reason FROM webssh_sessions ORDER BY id').all() as Array<{ id: string; status: string; close_reason: string }>
    expect(rows).toEqual([
      { id: 'active-live', status: 'active', close_reason: '' },
      { id: 'active-stale', status: 'closed', close_reason: 'idle' },
      { id: 'pending-stale', status: 'closed', close_reason: 'stale' },
    ])
  })
})

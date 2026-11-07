// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { WebsshAuditListResponse, WebsshHealthReport } from '../src/shared/webssh/types'
import { createApp } from '../src/worker/app'
import type { Env } from '../src/worker/env'
import { hashToken } from '../src/worker/lib/session-store'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const OWNER_ID = 'user-owner'
const OTHER_ID = 'user-other'
const OWNER_TOKEN = 'a'.repeat(64)
const OTHER_TOKEN = 'b'.repeat(64)

const app = createApp()
const ctx = {
  waitUntil(promise: Promise<unknown>) {
    void promise
  },
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext

let sqlite: DatabaseSync
let env: Env

function insertUser(id: string, username: string): void {
  const now = Date.now()
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, ?, 'hash', ?, ?, '', 'owner', '{}', ?, ?)`,
  ).run(id, username, username, username, now, now)
}

async function insertSessionRow(token: string, userId: string): Promise<void> {
  const now = Date.now()
  sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(await hashToken(token), userId, now + 3_600_000, now)
}

async function call(path: string, options: { session?: string | null } = {}): Promise<Response> {
  const token = options.session === undefined ? OWNER_TOKEN : options.session
  const headers: Record<string, string> = token ? { Cookie: `inkstone_session=${token}` } : {}
  return app.fetch(new Request(`http://localhost${path}`, { headers }), env, ctx)
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

function insertAudit(id: string, userId: string, eventType: string, createdAt: number, sessionId = ''): void {
  sqlite.prepare(
    `INSERT INTO webssh_audit_events (id, user_id, session_id, host_id, event_type, metadata, ip_hash, created_at)
     VALUES (?, ?, ?, '', ?, '{"action":"check"}', '', ?)`,
  ).run(id, userId, sessionId, eventType, createdAt)
}

function insertSession(id: string, userId: string, status: string, startedAt: number): void {
  sqlite.prepare(
    `INSERT INTO webssh_sessions (id, user_id, host_id, status, client_ip_hash, user_agent_hash,
       started_at, connected_at, ended_at, last_activity_at, bytes_in, bytes_out, close_reason, error_code, recording_id)
     VALUES (?, ?, '01m6ta00000000000000000001', ?, '', '', ?, NULL, NULL, ?, 0, 0, '', '', '')`,
  ).run(id, userId, status, startedAt, startedAt)
}

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite))
  await call('/api/health')
})

beforeEach(async () => {
  for (const table of [
    'webssh_snippets', 'webssh_hosts', 'webssh_host_groups', 'webssh_credentials', 'webssh_keys',
    'webssh_host_keys', 'webssh_sessions', 'webssh_session_tickets', 'webssh_recordings',
    'webssh_shares', 'webssh_audit_events', 'webssh_settings',
  ]) {
    sqlite.exec(`DELETE FROM ${table}`)
  }
  sqlite.exec('DELETE FROM sessions')
  sqlite.exec('DELETE FROM users')
  insertUser(OWNER_ID, 'owner')
  insertUser(OTHER_ID, 'other')
  await insertSessionRow(OWNER_TOKEN, OWNER_ID)
  await insertSessionRow(OTHER_TOKEN, OTHER_ID)
})

describe('audit retrieval', () => {
  it('requires a session and pages newest first', async () => {
    expect((await call('/api/webssh/audit', { session: null })).status).toBe(401)
    expect((await call('/api/webssh/audit/health', { session: null })).status).toBe(401)

    const now = Date.now()
    for (let index = 0; index < 25; index += 1) {
      insertAudit(`audit-${index}`, OWNER_ID, index % 2 ? 'connect' : 'disconnect', now + index)
    }
    const first = await json<WebsshAuditListResponse>(await call('/api/webssh/audit?pageSize=10&page=1'))
    expect(first.total).toBe(25)
    expect(first.items).toHaveLength(10)
    expect(first.items[0]?.eventType).toBe('disconnect')
    expect(first.items[0]?.metadata).toEqual({ action: 'check' })

    const filtered = await json<WebsshAuditListResponse>(await call('/api/webssh/audit?eventType=connect&pageSize=10'))
    expect(filtered.total).toBe(12)
    expect(filtered.items.every((item) => item.eventType === 'connect')).toBe(true)

    const ranged = await json<WebsshAuditListResponse>(
      await call(`/api/webssh/audit?from=${now + 20}&to=${now + 24}`),
    )
    expect(ranged.total).toBe(5)
  })

  it('keeps another account\'s events out of the list and the health report', async () => {
    insertAudit('other-audit', OTHER_ID, 'host_key_changed', Date.now())
    insertSession('other-session', OTHER_ID, 'error', Date.now())
    const list = await json<WebsshAuditListResponse>(await call('/api/webssh/audit'))
    expect(list.total).toBe(0)
    const health = await json<WebsshHealthReport>(await call('/api/webssh/audit/health'))
    expect(health.sessions.total).toBe(0)
    expect(health.signals.hostKeyChanged).toBe(0)
  })

  it('rejects an unknown event type', async () => {
    expect((await call('/api/webssh/audit?eventType=nope')).status).toBe(400)
  })
})

describe('health signals', () => {
  it('raises all four local alerts when the thresholds are crossed', async () => {
    const now = Date.now()
    for (let index = 0; index < 6; index += 1) {
      insertSession(`session-${index}`, OWNER_ID, index < 3 ? 'error' : 'closed', now)
    }
    insertAudit('host-key', OWNER_ID, 'host_key_changed', now)
    insertAudit('retention', OWNER_ID, 'retention_fail', now)
    insertAudit('ticket', OWNER_ID, 'ticket_rejected', now)
    const report = await json<WebsshHealthReport>(await call('/api/webssh/audit/health'))
    expect(report.sessions).toMatchObject({ total: 6, failed: 3 })
    expect(report.sessions.failureRate).toBeCloseTo(0.5)
    expect(report.signals).toEqual({ hostKeyChanged: 1, retentionFailed: 1, ticketRejected: 1 })
    expect(report.alerts.map((alert) => alert.code).sort()).toEqual([
      'host_key_changed',
      'retention_failed',
      'session_failures',
      'ticket_anomaly',
    ])
  })

  it('stays quiet below the failure-rate floor and outside the signal windows', async () => {
    const now = Date.now()
    insertSession('s1', OWNER_ID, 'error', now)
    insertSession('s2', OWNER_ID, 'closed', now)
    const old = now - 10 * 24 * 60 * 60 * 1000
    insertAudit('old-key', OWNER_ID, 'host_key_changed', old)
    insertAudit('old-retention', OWNER_ID, 'retention_fail', old)
    insertAudit('old-ticket', OWNER_ID, 'ticket_rejected', old)
    const report = await json<WebsshHealthReport>(await call('/api/webssh/audit/health'))
    expect(report.alerts).toEqual([])
    expect(report.signals).toEqual({ hostKeyChanged: 0, retentionFailed: 0, ticketRejected: 0 })
  })
})

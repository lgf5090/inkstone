// @vitest-environment node
// Replay API: owner-only metadata and bounded byte slices. Re-encoding every returned event must
// reproduce the whole object, and a second account must never see the first account's recording.

import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeD1 } from './doubles/d1-sqlite'
import { testR2Bucket } from './doubles/bindings'
import type { AppBindings, Env, Variables } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { newId } from '../src/worker/lib/id'
import { websshRoutes } from '../src/worker/webssh/routes'
import {
  encodeCastEvent,
  encodeCastHeader,
} from '../src/worker/webssh/recording/cast'
import type { WebsshCastEvent, WebsshCastHeader, WebsshRecordingFrames } from '../src/shared/webssh/types'

const ORIGIN = 'https://notes.example.com'

let sqlite: DatabaseSync
let db: D1Database
let bucket: ReturnType<typeof testR2Bucket>
let env: Env
let userId: string

function makeApp(ownerId: string): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.use('*', async (c, next) => {
    c.set('userId', ownerId)
    c.set('user', {
      id: ownerId,
      username: 'owner',
      login: 'owner',
      name: 'Owner',
      avatarUrl: '',
      role: 'owner',
      createdAt: 0,
      settingsRaw: '{}',
    } as Variables['user'])
    await next()
  })
  instance.route('/api/webssh', websshRoutes)
  instance.onError((error, c) => errorResponse(c, error))
  return instance
}

const HEADER: WebsshCastHeader = { version: 2, width: 100, height: 30, timestamp: 100, env: { TERM: 'xterm' } }
const EVENTS: WebsshCastEvent[] = [
  [0, 'o', 'first'.repeat(40)],
  [0.5, 'r', '90x28'],
  [0.75, 'o', 'second'.repeat(40)],
  [1, 'o', 'third'.repeat(40)],
]

function insertSession(ownerId: string, id = newId()): string {
  sqlite.prepare(
    `INSERT INTO webssh_sessions
       (id, user_id, host_id, status, started_at, last_activity_at, recording_id)
     VALUES (?, ?, ?, 'closed', 100, 100, '')`,
  ).run(id, ownerId, newId())
  return id
}

function insertRecording(input: {
  ownerId: string
  sessionId: string
  object: Uint8Array
  status?: string
  expiresAt?: number
}): { recordingId: string; r2Key: string } {
  const recordingId = newId()
  const r2Key = `webssh/txt/recordings/${input.ownerId}/2026/11/${input.sessionId}.cast`
  bucket.objects.set(r2Key, input.object)
  sqlite.prepare(
    `INSERT INTO webssh_recordings
       (id, user_id, session_id, host_id, format, r2_key, size_bytes, duration_ms, cols, rows,
        status, visibility, created_at, finalized_at, expires_at, deleted_at)
     VALUES (?, ?, ?, ?, 'cast', ?, ?, 1000, 100, 30, ?, 'private', 100, 200, ?, NULL)`,
  ).run(
    recordingId,
    input.ownerId,
    input.sessionId,
    newId(),
    r2Key,
    input.object.byteLength,
    input.status ?? 'ready',
    input.expiresAt ?? Date.now() + 1_000_000,
  )
  return { recordingId, r2Key }
}

function wholeCast(): Uint8Array {
  const encoder = new TextEncoder()
  return encoder.encode(encodeCastHeader(HEADER) + EVENTS.map(encodeCastEvent).join(''))
}

async function request(app: Hono<AppBindings>, path: string, init?: RequestInit): Promise<Response> {
  return app.request(`${ORIGIN}${path}`, init, env)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE webssh_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'closed',
      started_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      recording_id TEXT NOT NULL DEFAULT ''
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
    CREATE TABLE webssh_settings (
      user_id TEXT PRIMARY KEY,
      settings TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
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
  userId = newId()
})

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50))
  sqlite.close()
})

describe('recording settings', () => {
  it('is off by default and only an explicit write turns it on', async () => {
    const app = makeApp(userId)
    const initial = await request(app, '/api/webssh/settings')
    expect(await initial.json()).toEqual({ recording: { enabled: false, retentionDays: 30 } })

    const enable = await request(app, '/api/webssh/settings/recording', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(enable.status).toBe(200)
    expect(await enable.json()).toEqual({ recording: { enabled: true, retentionDays: 30 } })
    expect(sqlite.prepare('SELECT settings FROM webssh_settings WHERE user_id = ?').get(userId))
      .toEqual({ settings: '{"recording":{"enabled":true}}' })

    const invalid = await request(app, '/api/webssh/settings/recording', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    })
    expect(invalid.status).toBe(400)
  })

  it('keeps settings per account', async () => {
    const app = makeApp(userId)
    await request(app, '/api/webssh/settings/recording', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    const other = await request(makeApp(newId()), '/api/webssh/settings')
    expect(await other.json()).toEqual({ recording: { enabled: false, retentionDays: 30 } })
  })
})

describe('replay metadata', () => {
  it('answers for the owner and 404 for another account', async () => {
    const sessionId = insertSession(userId)
    const { recordingId } = insertRecording({ ownerId: userId, sessionId, object: wholeCast() })

    const own = await request(makeApp(userId), `/api/webssh/sessions/${sessionId}/recording`)
    expect(own.status).toBe(200)
    const body = await own.json() as { id: string; status: string; sizeBytes: number; expiresAt: number }
    expect(body).toMatchObject({ id: recordingId, status: 'ready', sizeBytes: wholeCast().byteLength })
    expect(body.expiresAt).toBeGreaterThan(Date.now())

    const foreign = await request(makeApp(newId()), `/api/webssh/sessions/${sessionId}/recording`)
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toMatchObject({ error: { code: 'not_found' } })
  })

  it('404s a session that was not recorded', async () => {
    const sessionId = insertSession(userId)
    const response = await request(makeApp(userId), `/api/webssh/sessions/${sessionId}/recording`)
    expect(response.status).toBe(404)
  })

  it('returns a still-recording session without frames', async () => {
    const sessionId = insertSession(userId)
    insertRecording({ ownerId: userId, sessionId, object: wholeCast(), status: 'recording' })
    const meta = await request(makeApp(userId), `/api/webssh/sessions/${sessionId}/recording`)
    expect(meta.status).toBe(200)
    expect(await meta.json()).toMatchObject({ status: 'recording' })

    const frames = await request(makeApp(userId), `/api/webssh/sessions/${sessionId}/recording/frames`)
    expect(frames.status).toBe(409)
    expect(await frames.json()).toMatchObject({ error: { code: 'conflict', details: { status: 'recording' } } })
  })
})

describe('replay frames', () => {
  it('concatenates slices into exactly the whole cast', async () => {
    const sessionId = insertSession(userId)
    const { recordingId } = insertRecording({ ownerId: userId, sessionId, object: wholeCast() })
    const app = makeApp(userId)

    let offset = 0
    let header: WebsshCastHeader | undefined
    const events: WebsshCastEvent[] = []
    let guard = 0
    while (guard < 100) {
      guard += 1
      const response = await request(app, `/api/webssh/sessions/${sessionId}/recording/frames?offset=${offset}&limit=400`)
      expect(response.status).toBe(200)
      const body = await response.json() as WebsshRecordingFrames
      expect(body.recordingId).toBe(recordingId)
      if (body.header) header = body.header
      events.push(...body.frames)
      if (body.complete) {
        expect(body.nextOffset).toBe(body.totalSize)
        expect(body.nextOffset).toBe(wholeCast().byteLength)
        break
      }
      expect(body.nextOffset).toBeGreaterThan(offset)
      offset = body.nextOffset
    }
    expect(guard).toBeLessThan(100)
    expect(header).toEqual(HEADER)
    expect(events).toEqual(EVENTS)

    const rebuilt = encodeCastHeader(header!) + events.map(encodeCastEvent).join('')
    const content = await request(app, `/api/webssh/sessions/${sessionId}/recording/content`)
    expect(content.status).toBe(200)
    expect(content.headers.get('content-type')).toBe('application/x-asciicast')
    expect(content.headers.get('cache-control')).toBe('no-store')
    expect(await content.text()).toBe(rebuilt)
  })

  it('rejects an offset that is not a safe integer and a limit beyond the bound', async () => {
    const sessionId = insertSession(userId)
    insertRecording({ ownerId: userId, sessionId, object: wholeCast() })
    const app = makeApp(userId)
    const badOffset = await request(app, `/api/webssh/sessions/${sessionId}/recording/frames?offset=abc`)
    expect(badOffset.status).toBe(400)
    const bigLimit = await request(app, `/api/webssh/sessions/${sessionId}/recording/frames?limit=999999`)
    expect(bigLimit.status).toBe(400)
    const tooSmall = await request(app, `/api/webssh/sessions/${sessionId}/recording/frames?limit=4`)
    expect(tooSmall.status).toBe(400)
  })

  it('does not serve another account a frame', async () => {
    const sessionId = insertSession(userId)
    insertRecording({ ownerId: userId, sessionId, object: wholeCast() })
    const response = await request(makeApp(newId()), `/api/webssh/sessions/${sessionId}/recording/frames`)
    expect(response.status).toBe(404)
  })
})

describe('lazy retention', () => {
  it('removes the object and marks the row before answering 404', async () => {
    const sessionId = insertSession(userId)
    const { recordingId, r2Key } = insertRecording({
      ownerId: userId,
      sessionId,
      object: wholeCast(),
      expiresAt: 1,
    })
    expect(bucket.objects.has(r2Key)).toBe(true)

    const response = await request(makeApp(userId), `/api/webssh/sessions/${sessionId}/recording`)
    expect(response.status).toBe(404)
    expect(bucket.objects.has(r2Key)).toBe(false)
    expect(sqlite.prepare('SELECT status, deleted_at FROM webssh_recordings WHERE id = ?').get(recordingId))
      .toMatchObject({ status: 'deleted', deleted_at: expect.any(Number) })
  })
})

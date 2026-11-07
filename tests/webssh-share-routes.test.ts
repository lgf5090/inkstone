// @vitest-environment node
// W7 share surface: an owner mints one link per recording, and a visitor reads only that recording
// through the gate. The cases pin the boundaries that matter — owner-only management, passcode and
// view cap, revocation, expiry, a recording purged under a live-looking link, and the fact that the
// public answer never names the session, the host, the account or the R2 key.

import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeD1 } from './doubles/d1-sqlite'
import { testR2Bucket } from './doubles/bindings'
import type { AppBindings, Env, Variables } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { newId } from '../src/worker/lib/id'
import { websshRoutes } from '../src/worker/webssh/routes'
import { websshPublicShareRoutes } from '../src/worker/webssh/routes-share'
import {
  encodeCastEvent,
  encodeCastHeader,
} from '../src/worker/webssh/recording/cast'
import type {
  WebsshCastEvent,
  WebsshCastHeader,
  WebsshPublicShareFrames,
  WebsshPublicShareView,
  WebsshShareView,
} from '../src/shared/webssh/types'

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
  instance.route('/api/public/webssh', websshPublicShareRoutes)
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

function wholeCast(): Uint8Array {
  const encoder = new TextEncoder()
  return encoder.encode(encodeCastHeader(HEADER) + EVENTS.map(encodeCastEvent).join(''))
}

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

function cookieFrom(response: Response, slug: string): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const all = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [response.headers.get('set-cookie') ?? '']
  const prefix = `inkstone_share_${slug}=`
  for (const value of all) {
    if (value.startsWith(prefix)) return value.slice(0, value.indexOf(';'))
  }
  throw new Error('share cookie missing')
}

async function request(app: Hono<AppBindings>, path: string, init?: RequestInit): Promise<Response> {
  return app.request(`${ORIGIN}${path}`, init, env)
}

function jsonInit(body: unknown, cookie?: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  }
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
    CREATE TABLE login_attempts (
      key TEXT PRIMARY KEY,
      fails INTEGER NOT NULL DEFAULT 0,
      last_fail_at INTEGER NOT NULL,
      locked_until INTEGER
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

describe('owner share management', () => {
  it('creates a link bounded by the recording lifetime and reads it back', async () => {
    const sessionId = insertSession(userId)
    const { recordingId } = insertRecording({ ownerId: userId, sessionId, object: wholeCast() })
    const app = makeApp(userId)

    const created = await request(app, `/api/webssh/sessions/${sessionId}/recording/share`, jsonInit({
      title: 'Deploy log',
      expiresIn: 365 * 24 * 60 * 60 * 1000,
      maxViews: 3,
    }))
    expect(created.status).toBe(200)
    const body = await created.json() as { share: WebsshShareView }
    expect(body.share).toMatchObject({
      recordingId,
      title: 'Deploy log',
      hasPassword: false,
      maxViews: 3,
      views: 0,
      isEnabled: true,
      url: `https://notes.example.com/w/${body.share.slug}`,
    })
    expect(body.share.expiresAt).toBeLessThanOrEqual(Number(sqlite.prepare(
      'SELECT expires_at FROM webssh_recordings WHERE id = ?',
    ).get(recordingId)!.expires_at))

    const read = await request(app, `/api/webssh/sessions/${sessionId}/recording/share`)
    expect((await read.json() as { share: WebsshShareView }).share.slug).toBe(body.share.slug)
  })

  it('refuses another account on read, create and revoke', async () => {
    const sessionId = insertSession(userId)
    insertRecording({ ownerId: userId, sessionId, object: wholeCast() })
    const foreign = makeApp(newId())
    expect((await request(foreign, `/api/webssh/sessions/${sessionId}/recording/share`)).status).toBe(404)
    expect((await request(foreign, `/api/webssh/sessions/${sessionId}/recording/share`, jsonInit({}))).status).toBe(404)
    const revoke = await request(foreign, `/api/webssh/sessions/${sessionId}/recording/share`, { method: 'DELETE' })
    expect(revoke.status).toBe(404)
  })

  it('409s a recording that is still being written', async () => {
    const sessionId = insertSession(userId)
    insertRecording({ ownerId: userId, sessionId, object: wholeCast(), status: 'recording' })
    const response = await request(makeApp(userId), `/api/webssh/sessions/${sessionId}/recording/share`, jsonInit({}))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'conflict', details: { status: 'recording' } } })
  })

  it('rotates the slug on request and keeps the old address dead', async () => {
    const sessionId = insertSession(userId)
    insertRecording({ ownerId: userId, sessionId, object: wholeCast() })
    const app = makeApp(userId)
    const first = await request(app, `/api/webssh/sessions/${sessionId}/recording/share`, jsonInit({}))
    const firstSlug = (await first.json() as { share: WebsshShareView }).share.slug

    const rotated = await request(app, `/api/webssh/sessions/${sessionId}/recording/share`, jsonInit({ rotate: true }))
    const secondSlug = (await rotated.json() as { share: WebsshShareView }).share.slug
    expect(secondSlug).not.toBe(firstSlug)
    expect((await request(app, `/api/public/webssh/shares/${firstSlug}`, jsonInit({}))).status).toBe(404)
    expect((await request(app, `/api/public/webssh/shares/${secondSlug}`, jsonInit({}))).status).toBe(200)
  })

  it('revokes the link and every token it issued', async () => {
    const sessionId = insertSession(userId)
    insertRecording({ ownerId: userId, sessionId, object: wholeCast() })
    const app = makeApp(userId)
    const created = await request(app, `/api/webssh/sessions/${sessionId}/recording/share`, jsonInit({}))
    const slug = (await created.json() as { share: WebsshShareView }).share.slug
    const gate = await request(app, `/api/public/webssh/shares/${slug}`, jsonInit({}))
    expect(gate.status).toBe(200)
    const cookie = cookieFrom(gate, slug)

    const revoke = await request(app, `/api/webssh/sessions/${sessionId}/recording/share`, {
      method: 'DELETE',
      headers: { cookie },
    })
    expect(revoke.status).toBe(200)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM webssh_shares').get()).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM share_asset_sessions').get()).toEqual({ count: 0 })
    expect((await request(app, `/api/public/webssh/shares/${slug}`, jsonInit({}))).status).toBe(404)
    expect((await request(app, `/api/public/webssh/shares/${slug}/frames`, { headers: { cookie } })).status).toBe(404)
  })
})

describe('public gate', () => {
  async function shareOf(options: { password?: string; maxViews?: number; expiresIn?: number } = {}): Promise<{
    app: Hono<AppBindings>
    slug: string
    sessionId: string
    recordingId: string
  }> {
    const sessionId = insertSession(userId)
    const { recordingId } = insertRecording({ ownerId: userId, sessionId, object: wholeCast() })
    const app = makeApp(userId)
    const created = await request(app, `/api/webssh/sessions/${sessionId}/recording/share`, jsonInit(options))
    expect(created.status).toBe(200)
    const slug = (await created.json() as { share: WebsshShareView }).share.slug
    return { app, slug, sessionId, recordingId }
  }

  it('answers only public fields, then serves slices and the whole cast byte for byte', async () => {
    const { app, slug } = await shareOf()
    const gate = await request(app, `/api/public/webssh/shares/${slug}`, jsonInit({}))
    expect(gate.status).toBe(200)
    const view = await gate.json() as WebsshPublicShareView & Record<string, unknown>
    expect(view).toEqual({
      share: {
        slug,
        title: '',
        createdAt: expect.any(Number),
        expiresAt: expect.any(Number),
        maxViews: 0,
        views: 1,
      },
      recording: {
        format: 'cast',
        sizeBytes: wholeCast().byteLength,
        durationMs: 1000,
        cols: 100,
        rows: 30,
        createdAt: 100,
        finalizedAt: 200,
      },
    })
    expect(JSON.stringify(view)).not.toMatch(/r2_key|r2Key|sessionId|hostId|userId|recordingId/)
    const cookie = cookieFrom(gate, slug)

    let offset = 0
    let header: WebsshCastHeader | undefined
    const events: WebsshCastEvent[] = []
    for (let guard = 0; guard < 100; guard += 1) {
      const response = await request(app, `/api/public/webssh/shares/${slug}/frames?offset=${offset}&limit=400`, {
        headers: { cookie },
      })
      expect(response.status).toBe(200)
      const body = await response.json() as WebsshPublicShareFrames
      if (body.header) header = body.header
      events.push(...body.frames)
      if (body.complete) {
        expect(body.nextOffset).toBe(wholeCast().byteLength)
        break
      }
      expect(body.nextOffset).toBeGreaterThan(offset)
      offset = body.nextOffset
    }
    expect(header).toEqual(HEADER)
    expect(events).toEqual(EVENTS)

    const content = await request(app, `/api/public/webssh/shares/${slug}/content`, { headers: { cookie } })
    expect(content.status).toBe(200)
    expect(content.headers.get('content-type')).toBe('application/x-asciicast')
    expect(await content.text()).toBe(encodeCastHeader(HEADER) + EVENTS.map(encodeCastEvent).join(''))
  })

  it('requires the gate token before any read and accepts a bearer token instead of a cookie', async () => {
    const { app, slug } = await shareOf()
    expect((await request(app, `/api/public/webssh/shares/${slug}/frames`)).status).toBe(401)
    const gate = await request(app, `/api/public/webssh/shares/${slug}`, jsonInit({}))
    const cookie = cookieFrom(gate, slug)
    const token = cookie.slice(`inkstone_share_${slug}=`.length)
    const viaHeader = await request(app, `/api/public/webssh/shares/${slug}/frames`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(viaHeader.status).toBe(200)
  })

  it('holds the passcode gate and throttles nothing away on the correct one', async () => {
    const { app, slug } = await shareOf({ password: 'open-sesame' })
    expect((await request(app, `/api/public/webssh/shares/${slug}`, jsonInit({}))).status).toBe(401)
    expect((await request(app, `/api/public/webssh/shares/${slug}`, jsonInit({ password: 'wrong' }))).status).toBe(401)
    const ok = await request(app, `/api/public/webssh/shares/${slug}`, jsonInit({ password: 'open-sesame' }))
    expect(ok.status).toBe(200)
  })

  it('enforces the view cap atomically while a granted visitor keeps reading', async () => {
    const { app, slug } = await shareOf({ maxViews: 1 })
    const first = await request(app, `/api/public/webssh/shares/${slug}`, jsonInit({}))
    expect(first.status).toBe(200)
    const cookie = cookieFrom(first, slug)
    expect((await request(app, `/api/public/webssh/shares/${slug}`, jsonInit({}))).status).toBe(404)
    expect((await request(app, `/api/public/webssh/shares/${slug}/frames`, { headers: { cookie } })).status).toBe(200)
  })

  it('404s an expired link', async () => {
    const { app, slug } = await shareOf({ expiresIn: 5 })
    await new Promise((resolve) => setTimeout(resolve, 6))
    expect((await request(app, `/api/public/webssh/shares/${slug}`, jsonInit({}))).status).toBe(404)
  })

  it('404s and drops the link when the recording is purged', async () => {
    const sessionId = insertSession(userId)
    const { recordingId, r2Key } = insertRecording({ ownerId: userId, sessionId, object: wholeCast() })
    const app = makeApp(userId)
    const created = await request(app, `/api/webssh/sessions/${sessionId}/recording/share`, jsonInit({}))
    const slug = (await created.json() as { share: WebsshShareView }).share.slug

    sqlite.prepare('UPDATE webssh_recordings SET expires_at = 1 WHERE id = ?').run(recordingId)
    const gate = await request(app, `/api/public/webssh/shares/${slug}`, jsonInit({}))
    expect(gate.status).toBe(404)
    expect(bucket.objects.has(r2Key)).toBe(false)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM webssh_shares').get()).toEqual({ count: 0 })
  })
})

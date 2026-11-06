// @vitest-environment node
// The recorder taps raw terminal bytes, writes a cast file to R2 (single put or multipart), and
// finishes the D1 row. The whistle-blower is the byte stream: concatenated output events must equal
// what the terminal received, in order, on both the single-put and multipart paths.

import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeD1 } from './doubles/d1-sqlite'
import { testR2Bucket } from './doubles/bindings'
import { newId } from '../src/worker/lib/id'
import { WebsshSessionRecorder } from '../src/worker/webssh/recording/recorder'
import { parseCastLine } from '../src/worker/webssh/recording/cast'

let sqlite: DatabaseSync
let db: D1Database
let bucket: ReturnType<typeof testR2Bucket>
let userId: string
let hostId: string
let sessionId: string

const RECORDING_DDL = `
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
  CREATE UNIQUE INDEX idx_webssh_recordings_key ON webssh_recordings(r2_key);
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
`

function castOutput(objectBytes: Uint8Array): string {
  let text = ''
  for (const line of new TextDecoder().decode(objectBytes).split('\n')) {
    const parsed = parseCastLine(line)
    if (parsed.event?.[1] === 'o') text += parsed.event[2]
  }
  return text
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE webssh_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      started_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      recording_id TEXT NOT NULL DEFAULT ''
    );
    ${RECORDING_DDL}
  `)
  db = makeD1(sqlite)
  bucket = testR2Bucket()
  userId = newId()
  hostId = newId()
  sessionId = newId()
  sqlite.prepare(
    `INSERT INTO webssh_sessions (id, user_id, host_id, status, started_at, last_activity_at)
     VALUES (?, ?, ?, 'active', 1000, 1000)`,
  ).run(sessionId, userId, hostId)
})

afterEach(() => {
  sqlite.close()
})

describe('WebsshSessionRecorder', () => {
  it('records split multi-byte output in order and finalizes the row with one put', async () => {
    const recorder = await WebsshSessionRecorder.start({
      db,
      bucket,
      userId,
      sessionId,
      hostId,
      cols: 120,
      rows: 40,
      term: 'xterm-256color',
      now: 1_000,
    })
    expect(recorder).not.toBeNull()
    expect(recorder!.recordingId).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/)

    const encoder = new TextEncoder()
    const text = '中文ABC\r\n'
    const bytes = encoder.encode(text)
    recorder!.tapOutput(bytes.subarray(0, 1))
    recorder!.tapOutput(bytes.subarray(1, 4))
    recorder!.tapOutput(bytes.subarray(4))
    recorder!.resize(100, 30)
    recorder!.tapOutput(encoder.encode('done'))
    await recorder!.finish(2_000)

    const object = bucket.objects.get(recorder!.r2Key)
    expect(object).toBeDefined()
    expect(castOutput(object!)).toBe(`${text}done`)

    const lines = new TextDecoder().decode(object!).trimEnd().split('\n')
    expect(JSON.parse(lines[0]).version).toBe(2)
    const resizes = lines.map((line) => parseCastLine(line)).filter((line) => line.event?.[1] === 'r')
    expect(resizes).toHaveLength(1)
    expect(resizes[0].event?.[2]).toBe('100x30')

    const row = sqlite.prepare('SELECT * FROM webssh_recordings WHERE id = ?').get(recorder!.recordingId) as Record<string, unknown>
    expect(row).toMatchObject({
      status: 'ready',
      user_id: userId,
      session_id: sessionId,
      host_id: hostId,
      size_bytes: object!.byteLength,
      duration_ms: 1_000,
      cols: 100,
      rows: 30,
      finalized_at: 2_000,
    })
    expect(Number(row.expires_at)).toBe(1_000 + 30 * 24 * 60 * 60 * 1000)
    expect(sqlite.prepare('SELECT recording_id FROM webssh_sessions WHERE id = ?').get(sessionId))
      .toEqual({ recording_id: recorder!.recordingId })

    const audit = sqlite.prepare('SELECT event_type FROM webssh_audit_events ORDER BY created_at').all() as Array<{ event_type: string }>
    expect(audit.map((event) => event.event_type)).toEqual(['recording_start', 'recording_finalize'])
  })

  it('switches to multipart once the cast crosses the part floor and still assembles the same bytes', async () => {
    let multipartCalls = 0
    const realCreate = bucket.createMultipartUpload.bind(bucket)
    bucket.createMultipartUpload = (async (key: string, options?: R2MultipartOptions) => {
      multipartCalls += 1
      return realCreate(key, options)
    }) as typeof bucket.createMultipartUpload

    const recorder = await WebsshSessionRecorder.start({
      db,
      bucket,
      userId,
      sessionId,
      hostId,
      cols: 80,
      rows: 24,
      term: 'xterm',
      now: 1_000,
      partBytes: 1_024,
    })
    expect(recorder).not.toBeNull()

    const encoder = new TextEncoder()
    let expected = ''
    for (let index = 0; index < 40; index += 1) {
      const chunk = `line-${String(index).padStart(3, '0')}-${'x'.repeat(60)}\n`
      expected += chunk
      recorder!.tapOutput(encoder.encode(chunk))
    }
    await recorder!.finish(1_500)

    expect(multipartCalls).toBe(1)
    const object = bucket.objects.get(recorder!.r2Key)
    expect(object).toBeDefined()
    expect(castOutput(object!)).toBe(expected)
    const row = sqlite.prepare('SELECT status, size_bytes FROM webssh_recordings WHERE id = ?').get(recorder!.recordingId) as Record<string, unknown>
    expect(row).toMatchObject({ status: 'ready', size_bytes: object!.byteLength })
  })

  it('is idempotent: a second finish does not rewrite the object or the row', async () => {
    const recorder = await WebsshSessionRecorder.start({
      db,
      bucket,
      userId,
      sessionId,
      hostId,
      cols: 80,
      rows: 24,
      term: 'xterm',
      now: 1_000,
    })
    recorder!.tapOutput(new TextEncoder().encode('once'))
    await recorder!.finish(1_100)
    const first = bucket.objects.get(recorder!.r2Key)!.slice()
    await recorder!.finish(1_200)
    expect(bucket.objects.get(recorder!.r2Key)).toEqual(first)
    const row = sqlite.prepare('SELECT finalized_at FROM webssh_recordings WHERE id = ?').get(recorder!.recordingId)
    expect(row).toEqual({ finalized_at: 1_100 })
  })
})

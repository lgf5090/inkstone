// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { runMusicMaintenance } from '../src/worker/music/cleanup'
import { testR2Bucket, type TestR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const OWNER = 'a'.repeat(26)

let db: D1Database
let bucket: TestR2Bucket
let env: Env

beforeEach(() => {
  const sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  bucket = testR2Bucket()
  env = { DB: db, FILES: bucket } as unknown as Env
})

describe('music maintenance', () => {
  it('removes queued objects and only then drops their retry rows', async () => {
    const key = `music/mp3/${OWNER}/track-original.mp3`
    await bucket.put(key, new Uint8Array([1, 2, 3]))
    await db.prepare(
      `INSERT INTO music_cleanup (object_key, user_id, created_at) VALUES (?1, ?2, ?3)`,
    ).bind(key, OWNER, Date.now()).run()

    const result = await runMusicMaintenance(env)

    expect(result.objectsRemoved).toBe(1)
    expect(bucket.objects.has(key)).toBe(false)
    const remaining = await db.prepare('SELECT COUNT(*) AS count FROM music_cleanup').first<{ count: number }>()
    expect(remaining?.count).toBe(0)
  })

  it('does not construct a provider or queue when there is no work', async () => {
    const result = await runMusicMaintenance(env)
    expect(result).toEqual({ objectsRemoved: 0, objectsFailed: 0, uploadsAborted: 0, queuesNudged: 0 })
  })
})

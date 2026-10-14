// @vitest-environment node
// Behavioural coverage for `src/worker/routes/avatars.ts` (its one D1 read now lives in
// `src/worker/avatars/store.ts`; the claims here are about what the route answers, not about which
// file holds the SQL). The route is the only unauthenticated byte server in the worker, so the pair
// of cases that matter are "the address matches the account's stored preference" and "it does not".
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { avatarRoutes } from '../src/worker/routes/avatars'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = '00000000000000000000000000'
const BOB = '11111111111111111111111111'
const OBJECT = 'aaaaaaaaaaaaaaaaaaaaaaaaaa'

/** A valid stored preference for one object of one account, the way `persistUploadedAvatar` writes it. */
function preference(userId: string, objectId = OBJECT, extension = 'png'): string {
  return `/api/avatars/kv/${userId}/${objectId}.${extension}`
}

const store = new Map<string, ArrayBuffer>()
const kv = {
  async get(key: string, type: string): Promise<ArrayBuffer | null> {
    if (type !== 'arrayBuffer') throw new Error('this double only serves arrayBuffer reads')
    return store.get(key) ?? null
  },
}

let sqlite: DatabaseSync
let db: D1Database

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.route('/api/avatars', avatarRoutes)

function account(id: string, username: string, avatarUrl: string) {
  sqlite
    .prepare(
      `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
       VALUES (?, ?, 'hash', ?, '', ?, 'member', '{}', 1, 1)`,
    )
    .run(id, username, username, avatarUrl)
}

function env() {
  return { DB: db, FILES_KV: kv } as unknown as AppBindings['Bindings']
}

async function get(path: string) {
  return app.request(path, {}, env())
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  store.clear()
  store.set(`avatars/${ALICE}/${OBJECT}.png`, new Uint8Array([137, 80, 78, 71]).buffer)
})

describe('serving an avatar', () => {
  it('answers with the bytes and the immutable headers', async () => {
    account(ALICE, 'alice', preference(ALICE))
    const response = await get(preference(ALICE))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]))
  })

  it('maps the jpg extension to the jpeg type', async () => {
    store.set(`avatars/${ALICE}/${OBJECT}.jpg`, new Uint8Array([255, 216, 255]).buffer)
    account(ALICE, 'alice', preference(ALICE, OBJECT, 'jpg'))
    const response = await get(preference(ALICE, OBJECT, 'jpg'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
  })

  it('refuses an address whose account does not store that avatar', async () => {
    account(ALICE, 'alice', preference(ALICE))
    account(BOB, 'bob', '')
    // The object bytes exist; only the account's stored preference says they are nobody's.
    expect((await get(preference(BOB))).status).toBe(404)
  })

  it('refuses an avatar the account replaced or cleared', async () => {
    account(ALICE, 'alice', '')
    expect((await get(preference(ALICE))).status).toBe(404)
  })

  it('refuses an address that is not a stored avatar at all', async () => {
    account(ALICE, 'alice', preference(ALICE))
    expect((await get('/api/avatars/kv/nope/other.png')).status).toBe(404)
    expect((await get(`/api/avatars/s3/${ALICE}/${OBJECT}.png`)).status).toBe(404)
  })

  it('separates a missing object from an unknown avatar', async () => {
    store.clear()
    account(ALICE, 'alice', preference(ALICE))
    const missing = await get(preference(ALICE))
    expect(missing.status).toBe(404)
    expect((await missing.json() as { error: { message: string } }).error.message).toBe('Avatar data is missing')
  })

  it('reports a storage backend that is not bound', async () => {
    account(ALICE, 'alice', `/api/avatars/r2/${ALICE}/${OBJECT}.png`)
    const response = await get(`/api/avatars/r2/${ALICE}/${OBJECT}.png`)
    expect(response.status).toBe(503)
    expect((await response.json() as { error: { code: string } }).error.code).toBe('storage_unavailable')
  })
})

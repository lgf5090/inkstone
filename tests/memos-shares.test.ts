// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import type { MemoShare } from '../src/shared/memos/types'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { MEMOS_SCHEMA_STATEMENTS } from '../src/worker/memos/schema'
import {
  createShare,
  findShareByToken,
  listShares,
  revokeShare,
} from '../src/worker/memos/shares'
import { hashOpaqueToken } from '../src/worker/memos/tokens'
import { memoShareRoutes } from '../src/worker/routes/memos/shares'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const OWNER = 'user-owner'
const OTHER = 'user-other'
const MEMO = 'a'.repeat(26)
const ARCHIVED_MEMO = 'b'.repeat(26)
const FOREIGN_MEMO = 'c'.repeat(26)
const MISSING_MEMO = 'd'.repeat(26)
const SHARE = 'e'.repeat(26)
const SHARE_TWO = 'f'.repeat(26)
const SHARE_OTHER = 'g'.repeat(26)
const ID_SHAPE = /^[0-9a-hjkmnp-tv-z]{26}$/
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/
const URL_PREFIX = '/memos/s/'

let sqlite: DatabaseSync
let db: D1Database
let env: Env
let viewer = OWNER

const app = new Hono<AppBindings>()
app.use('*', async (c, next) => {
  if (viewer) c.set('userId', viewer)
  await next()
})
app.onError((err, c) => errorResponse(c, err))
app.route('/api/memos', memoShareRoutes)

const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function insertMemo(id: string, userId: string, state: 'normal' | 'archived' = 'normal'): void {
  sqlite.prepare(
    `INSERT INTO memos_items (
       id, user_id, content, content_search, title, snippet, visibility, state, pinned,
       has_link, has_code, has_task_list, has_incomplete_tasks, has_location, rev, created_at, updated_at
     ) VALUES (?, ?, '', '', '', '', 'private', ?, 0, 0, 0, 0, 0, 0, 1, 100, 100)`,
  ).run(id, userId, state)
}

function insertShare(
  id: string,
  userId: string,
  memoId: string,
  tokenHash: string,
  options: { expiresAt?: number | null; revokedAt?: number | null; createdAt?: number } = {},
): void {
  sqlite.prepare(
    `INSERT INTO memos_shares (id, user_id, memo_id, token_hash, expires_at, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    memoId,
    tokenHash,
    options.expiresAt ?? null,
    options.createdAt ?? 100,
    options.revokedAt ?? null,
  )
}

interface StoredShare {
  id: string
  user_id: string
  memo_id: string
  token_hash: string
  expires_at: number | null
  created_at: number
  revoked_at: number | null
}

function storedShare(id: string): StoredShare | undefined {
  return sqlite.prepare(
    'SELECT id, user_id, memo_id, token_hash, expires_at, created_at, revoked_at FROM memos_shares WHERE id = ?',
  ).get(id) as StoredShare | undefined
}

function countShares(): number {
  return (sqlite.prepare('SELECT COUNT(*) AS count FROM memos_shares').get() as { count: number }).count
}

function tokenFrom(share: MemoShare): string {
  if (!share.url) throw new TypeError('the created share has no url')
  return share.url.slice(URL_PREFIX.length)
}

async function expectApiError(promise: Promise<unknown>, status: number, message: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ status, message })
}

async function request(
  suffix: string,
  init: RequestInit = {},
  userId = OWNER,
): Promise<Response> {
  viewer = userId
  return await app.request(`/api/memos${suffix}`, init, env, ctx)
}

function jsonRequest(
  method: string,
  suffix: string,
  body: unknown,
  userId = OWNER,
): Promise<Response> {
  return request(suffix, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, userId)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(MEMOS_SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  env = testBindings(db)
  viewer = OWNER
})

describe('share store', () => {
  it('creates a share that stores only the hash of its returned token', async () => {
    insertMemo(MEMO, OWNER)
    const before = nowSeconds()

    const share = await createShare(db, OWNER, MEMO)

    expect(share.id).toMatch(ID_SHAPE)
    expect(share.memoId).toBe(MEMO)
    expect(share.expiresAt).toBeNull()
    expect(share.createdAt).toBeGreaterThanOrEqual(before)
    expect(share.createdAt).toBeLessThanOrEqual(nowSeconds())

    const token = tokenFrom(share)
    expect(token).toMatch(TOKEN_SHAPE)
    expect(share.url).toBe(`${URL_PREFIX}${token}`)

    const stored = storedShare(share.id)
    expect(stored).toMatchObject({
      user_id: OWNER,
      memo_id: MEMO,
      token_hash: await hashOpaqueToken(token),
      expires_at: null,
      revoked_at: null,
    })
    expect(stored!.token_hash).not.toBe(token)
    expect(stored!.token_hash).not.toContain(token)
  })

  it('mints a distinct token and id for every share', async () => {
    insertMemo(MEMO, OWNER)
    const shares = await Promise.all(Array.from({ length: 8 }, () => createShare(db, OWNER, MEMO)))
    expect(new Set(shares.map((share) => share.id)).size).toBe(shares.length)
    expect(new Set(shares.map((share) => tokenFrom(share))).size).toBe(shares.length)
  })

  it('keeps a future expiry and treats null as never expiring', async () => {
    insertMemo(MEMO, OWNER)
    const expiresAt = nowSeconds() + 3600

    const expiring = await createShare(db, OWNER, MEMO, expiresAt)
    expect(expiring.expiresAt).toBe(expiresAt)
    expect(storedShare(expiring.id)!.expires_at).toBe(expiresAt)

    const forever = await createShare(db, OWNER, MEMO, null)
    expect(forever.expiresAt).toBeNull()
    expect(storedShare(forever.id)!.expires_at).toBeNull()
  })

  it('refuses an expiry that is not a whole Unix second', async () => {
    insertMemo(MEMO, OWNER)
    const message = 'expiresAt must be a Unix timestamp in seconds'

    await expectApiError(createShare(db, OWNER, MEMO, '1700000000'), 400, message)
    await expectApiError(createShare(db, OWNER, MEMO, 1.5), 400, message)
    await expectApiError(createShare(db, OWNER, MEMO, Number.NaN), 400, message)
    await expectApiError(createShare(db, OWNER, MEMO, Number.POSITIVE_INFINITY), 400, message)
    expect(countShares()).toBe(0)
  })

  it('refuses an expiry that is now or already past', async () => {
    insertMemo(MEMO, OWNER)
    const message = 'expiresAt must be in the future'

    await expectApiError(createShare(db, OWNER, MEMO, nowSeconds()), 400, message)
    await expectApiError(createShare(db, OWNER, MEMO, nowSeconds() - 60), 400, message)
    expect(countShares()).toBe(0)
  })

  it('refuses a missing, foreign or archived memo', async () => {
    insertMemo(ARCHIVED_MEMO, OWNER, 'archived')
    insertMemo(FOREIGN_MEMO, OTHER)

    await expectApiError(createShare(db, OWNER, MISSING_MEMO), 404, 'Memo not found')
    await expectApiError(createShare(db, OWNER, FOREIGN_MEMO), 404, 'Memo not found')
    await expectApiError(createShare(db, OWNER, ARCHIVED_MEMO), 409, 'Archived memos cannot be shared')
    expect(countShares()).toBe(0)
  })

  it('lists non-revoked shares oldest first, including expired ones, without tokens or urls', async () => {
    insertMemo(MEMO, OWNER)
    insertMemo(FOREIGN_MEMO, OTHER)
    const expiredAt = nowSeconds() - 10
    insertShare(SHARE_TWO, OWNER, MEMO, await hashOpaqueToken('second'), { createdAt: 200 })
    insertShare(SHARE, OWNER, MEMO, await hashOpaqueToken('first'), {
      createdAt: 100,
      expiresAt: expiredAt,
    })
    insertShare('h'.repeat(26), OWNER, MEMO, await hashOpaqueToken('revoked'), {
      createdAt: 50,
      revokedAt: 60,
    })
    insertShare(SHARE_OTHER, OTHER, FOREIGN_MEMO, await hashOpaqueToken('foreign'))

    const shares = await listShares(db, OWNER, MEMO)

    expect(shares).toEqual([
      { id: SHARE, memoId: MEMO, expiresAt: expiredAt, createdAt: 100 },
      { id: SHARE_TWO, memoId: MEMO, expiresAt: null, createdAt: 200 },
    ])
    for (const share of shares) expect('url' in share).toBe(false)
  })

  it('refuses to list an unknown or foreign memo', async () => {
    insertMemo(FOREIGN_MEMO, OTHER)

    await expectApiError(listShares(db, OWNER, MISSING_MEMO), 404, 'Memo not found')
    await expectApiError(listShares(db, OWNER, FOREIGN_MEMO), 404, 'Memo not found')
  })

  it('revokes a share once, scoped to its owner and memo', async () => {
    insertMemo(MEMO, OWNER)
    insertMemo(FOREIGN_MEMO, OTHER)
    insertShare(SHARE, OWNER, MEMO, await hashOpaqueToken('mine'))
    insertShare(SHARE_OTHER, OTHER, FOREIGN_MEMO, await hashOpaqueToken('theirs'))

    const before = nowSeconds()
    await expect(revokeShare(db, OWNER, MEMO, SHARE)).resolves.toBe(true)
    const revokedAt = storedShare(SHARE)!.revoked_at
    expect(revokedAt).toBeGreaterThanOrEqual(before)
    expect(revokedAt).toBeLessThanOrEqual(nowSeconds())

    await expect(revokeShare(db, OWNER, MEMO, SHARE)).resolves.toBe(false)
    expect(storedShare(SHARE)!.revoked_at).toBe(revokedAt)

    await expect(revokeShare(db, OWNER, FOREIGN_MEMO, SHARE)).resolves.toBe(false)
    await expect(revokeShare(db, OTHER, MEMO, SHARE)).resolves.toBe(false)
    await expect(revokeShare(db, OWNER, FOREIGN_MEMO, SHARE_OTHER)).resolves.toBe(false)
    expect(storedShare(SHARE_OTHER)!.revoked_at).toBeNull()
  })

  it('finds a live share by its raw token', async () => {
    insertMemo(MEMO, OWNER)
    const share = await createShare(db, OWNER, MEMO, nowSeconds() + 3600)

    await expect(findShareByToken(db, tokenFrom(share))).resolves.toEqual({
      id: share.id,
      user_id: OWNER,
      memo_id: MEMO,
      expires_at: share.expiresAt,
      created_at: share.createdAt,
      revoked_at: null,
    })
  })

  it('refuses revoked, expired and archived-memo shares by token', async () => {
    insertMemo(MEMO, OWNER)
    insertMemo(ARCHIVED_MEMO, OWNER, 'archived')
    const revokedToken = 'r'.repeat(43)
    const expiredToken = 'x'.repeat(43)
    const archivedToken = 'a'.repeat(43)
    insertShare(SHARE, OWNER, MEMO, await hashOpaqueToken(revokedToken), { revokedAt: 60 })
    insertShare(SHARE_TWO, OWNER, MEMO, await hashOpaqueToken(expiredToken), { expiresAt: 1 })
    insertShare(SHARE_OTHER, OWNER, ARCHIVED_MEMO, await hashOpaqueToken(archivedToken))

    await expect(findShareByToken(db, revokedToken)).resolves.toBeNull()
    await expect(findShareByToken(db, expiredToken)).resolves.toBeNull()
    await expect(findShareByToken(db, archivedToken)).resolves.toBeNull()
  })

  it('refuses a token that is not the shape the server mints', async () => {
    insertMemo(MEMO, OWNER)
    const share = await createShare(db, OWNER, MEMO)
    const token = tokenFrom(share)

    await expect(findShareByToken(db, '')).resolves.toBeNull()
    await expect(findShareByToken(db, token.slice(1))).resolves.toBeNull()
    await expect(findShareByToken(db, `${token}x`)).resolves.toBeNull()
    await expect(findShareByToken(db, '!'.repeat(43))).resolves.toBeNull()
    await expect(findShareByToken(db, null)).resolves.toBeNull()
    await expect(findShareByToken(db, 42)).resolves.toBeNull()
  })
})

describe('share routes', () => {
  it('refuses every share request without a session', async () => {
    insertMemo(MEMO, OWNER)
    const list = await request(`/${MEMO}/shares`, {}, '')
    expect(list.status).toBe(401)

    const create = await jsonRequest('POST', `/${MEMO}/shares`, {}, '')
    expect(create.status).toBe(401)

    const revoke = await request(`/${MEMO}/shares/${SHARE}`, { method: 'DELETE' }, '')
    expect(revoke.status).toBe(401)
  })

  it('creates a share and returns its public url', async () => {
    insertMemo(MEMO, OWNER)

    const response = await jsonRequest('POST', `/${MEMO}/shares`, {})

    expect(response.status).toBe(201)
    const share = await response.json() as MemoShare
    expect(share.id).toMatch(ID_SHAPE)
    expect(share.memoId).toBe(MEMO)
    expect(share.expiresAt).toBeNull()
    expect(share.url).toBe(`${URL_PREFIX}${tokenFrom(share)}`)
    expect(tokenFrom(share)).toMatch(TOKEN_SHAPE)
    await expect(findShareByToken(db, tokenFrom(share))).resolves.toMatchObject({ memo_id: MEMO, user_id: OWNER })
  })

  it('creates a share with the expiry from the body', async () => {
    insertMemo(MEMO, OWNER)
    const expiresAt = nowSeconds() + 7 * 24 * 3600

    const response = await jsonRequest('POST', `/${MEMO}/shares`, { expiresAt })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ memoId: MEMO, expiresAt })
  })

  it('refuses an invalid expiry with 400', async () => {
    insertMemo(MEMO, OWNER)

    const past = await jsonRequest('POST', `/${MEMO}/shares`, { expiresAt: nowSeconds() - 1 })
    expect(past.status).toBe(400)
    expect(await past.json()).toEqual({
      error: { code: 'bad_request', message: 'expiresAt must be in the future' },
    })

    const text = await jsonRequest('POST', `/${MEMO}/shares`, { expiresAt: 'tomorrow' })
    expect(text.status).toBe(400)
    expect(await text.json()).toEqual({
      error: { code: 'bad_request', message: 'expiresAt must be a Unix timestamp in seconds' },
    })
    expect(countShares()).toBe(0)
  })

  it('hides an unknown, foreign or archived memo behind 404 or 409', async () => {
    insertMemo(ARCHIVED_MEMO, OWNER, 'archived')
    insertMemo(FOREIGN_MEMO, OTHER)

    const missing = await jsonRequest('POST', `/${MISSING_MEMO}/shares`, {})
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: { code: 'not_found', message: 'Memo not found' } })

    const malformed = await jsonRequest('POST', '/not-an-id/shares', {})
    expect(malformed.status).toBe(404)

    const foreign = await jsonRequest('POST', `/${FOREIGN_MEMO}/shares`, {})
    expect(foreign.status).toBe(404)

    const archived = await jsonRequest('POST', `/${ARCHIVED_MEMO}/shares`, {})
    expect(archived.status).toBe(409)
    expect(await archived.json()).toEqual({
      error: { code: 'conflict', message: 'Archived memos cannot be shared' },
    })
  })

  it('lists non-revoked shares without urls', async () => {
    insertMemo(MEMO, OWNER)
    insertShare(SHARE, OWNER, MEMO, await hashOpaqueToken('first'), { createdAt: 100 })
    insertShare(SHARE_TWO, OWNER, MEMO, await hashOpaqueToken('revoked'), {
      createdAt: 50,
      revokedAt: 60,
    })

    const response = await request(`/${MEMO}/shares`)

    expect(response.status).toBe(200)
    const body = await response.json() as { shares: MemoShare[] }
    expect(body.shares).toEqual([
      { id: SHARE, memoId: MEMO, expiresAt: null, createdAt: 100 },
    ])
    expect('url' in body.shares[0]!).toBe(false)
  })

  it('hides another account memo from the list and the create route', async () => {
    insertMemo(FOREIGN_MEMO, OTHER)

    const list = await request(`/${FOREIGN_MEMO}/shares`)
    expect(list.status).toBe(404)

    const create = await jsonRequest('POST', `/${FOREIGN_MEMO}/shares`, {})
    expect(create.status).toBe(404)
    expect(countShares()).toBe(0)
  })

  it('revokes an owned share and then treats it as missing', async () => {
    insertMemo(MEMO, OWNER)
    const token = 'v'.repeat(43)
    insertShare(SHARE, OWNER, MEMO, await hashOpaqueToken(token))

    const response = await request(`/${MEMO}/shares/${SHARE}`, { method: 'DELETE' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(storedShare(SHARE)!.revoked_at).not.toBeNull()
    await expect(findShareByToken(db, token)).resolves.toBeNull()

    const again = await request(`/${MEMO}/shares/${SHARE}`, { method: 'DELETE' })
    expect(again.status).toBe(404)
    expect(await again.json()).toEqual({ error: { code: 'not_found', message: 'Share not found' } })
  })

  it('cannot revoke another account share or a share of another memo', async () => {
    insertMemo(MEMO, OWNER)
    insertMemo(FOREIGN_MEMO, OTHER)
    insertShare(SHARE, OWNER, MEMO, await hashOpaqueToken('mine'))
    insertShare(SHARE_OTHER, OTHER, FOREIGN_MEMO, await hashOpaqueToken('theirs'))

    const foreign = await request(`/${FOREIGN_MEMO}/shares/${SHARE_OTHER}`, { method: 'DELETE' }, OWNER)
    expect(foreign.status).toBe(404)
    expect(storedShare(SHARE_OTHER)!.revoked_at).toBeNull()

    const wrongMemo = await request(`/${FOREIGN_MEMO}/shares/${SHARE}`, { method: 'DELETE' }, OWNER)
    expect(wrongMemo.status).toBe(404)
    expect(storedShare(SHARE)!.revoked_at).toBeNull()

    const malformed = await request(`/${MEMO}/shares/not-an-id`, { method: 'DELETE' })
    expect(malformed.status).toBe(404)
    expect(await malformed.json()).toEqual({ error: { code: 'not_found', message: 'Share not found' } })
  })
})

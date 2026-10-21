// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { CLIENT_HEADER } from '../src/shared/constants'
import { MEMO_PAT_PREFIX } from '../src/shared/memos/constants'
import type {
  MemoToken,
  MemoTokenCreateInput,
  MemoTokenCreateResult,
} from '../src/shared/memos/types'
import type { AppBindings, Env } from '../src/worker/env'
import { ApiError, errorResponse } from '../src/worker/lib/errors'
import { requireAuth, requireClientHeader } from '../src/worker/middleware/auth'
import { MEMOS_SCHEMA_STATEMENTS } from '../src/worker/memos/schema'
import {
  MEMO_TOKEN_DESCRIPTION_MAX_LENGTH,
  createToken,
  findToken,
  listTokens,
  revokeToken,
} from '../src/worker/memos/pat'
import { hashOpaqueToken } from '../src/worker/memos/tokens'
import { memoListRoutes } from '../src/worker/routes/memos'
import { memoTokenRoutes } from '../src/worker/routes/memos/tokens'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const OWNER = 'user-owner'
const OTHER = 'user-other'
const SESSION_HEADER = 'X-Test-Session'
const ID_SHAPE = /^[0-9a-hjkmnp-tv-z]{26}$/
const TOKEN_SHAPE = /^memo_pat_[A-Za-z0-9_-]{43}$/
const TOKEN_FIELDS = ['createdAt', 'description', 'expiresAt', 'id', 'lastUsedAt', 'prefix']

const app = new Hono<AppBindings>()

app.onError((err, c) => errorResponse(c, err))
app.use('/api/*', requireClientHeader)
app.use('/api/*', async (c, next) => {
  const userId = c.req.header(SESSION_HEADER)
  if (userId === OWNER || userId === OTHER) c.set('userId', userId)
  await next()
})
app.route('/api/memos/tokens', memoTokenRoutes)
app.route('/api/memos', memoListRoutes)
app.get('/api/notes', requireAuth, (c) => c.json({ ok: true }))
app.all('/api/*', () => {
  throw ApiError.notFound('API endpoint not found')
})

const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
}

let sqlite: DatabaseSync
let db: D1Database
let env: Env

interface StoredToken {
  id: string
  user_id: string
  token_hash: string
  prefix: string
  description: string
  expires_at: number | null
  created_at: number
  last_used_at: number | null
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function tokenInput(value: unknown): MemoTokenCreateInput {
  return value as MemoTokenCreateInput
}

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return Promise.resolve(app.request(path, init, env, ctx))
}

function sessionHeaders(userId = OWNER): Record<string, string> {
  return { [SESSION_HEADER]: userId, [CLIENT_HEADER]: '1' }
}

function bearerHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

function jsonRequest(
  path: string,
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

async function issueToken(
  userId = OWNER,
  input: MemoTokenCreateInput = {},
): Promise<string> {
  return (await createToken(db, userId, input)).token
}

function storedTokens(): StoredToken[] {
  return sqlite
    .prepare('SELECT * FROM memos_tokens ORDER BY created_at ASC, id ASC')
    .all() as unknown as StoredToken[]
}

function storedToken(id: string): StoredToken | undefined {
  return sqlite.prepare('SELECT * FROM memos_tokens WHERE id = ?').get(id) as unknown as StoredToken | undefined
}

function countTokens(): number {
  return (sqlite.prepare('SELECT COUNT(*) AS count FROM memos_tokens').get() as { count: number }).count
}

function insertToken(
  id: string,
  userId: string,
  options: {
    expiresAt?: number | null
    createdAt?: number
    lastUsedAt?: number | null
    description?: string
  } = {},
): void {
  sqlite.prepare(
    `INSERT INTO memos_tokens
       (id, user_id, token_hash, prefix, description, expires_at, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    `hash-${id}`,
    `memo_pat_${id.slice(0, 7)}`,
    options.description ?? '',
    options.expiresAt ?? null,
    options.createdAt ?? 100,
    options.lastUsedAt ?? null,
  )
}

async function expectApiError(promise: Promise<unknown>, status: number, message: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ status, message })
}

async function expectUnauthenticated(response: Response): Promise<void> {
  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({
    error: { code: 'unauthenticated', message: 'Invalid or expired access token' },
  })
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(MEMOS_SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  env = testBindings(db)
})

describe('token store', () => {
  it('creates a prefixed token and stores only its hash', async () => {
    const before = nowSeconds()
    const expiresAt = before + 3_600
    const { token, tokenInfo } = await createToken(db, OWNER, {
      description: '  CLI  ',
      expiresAt,
    })

    expect(token).toMatch(TOKEN_SHAPE)
    expect(token.startsWith(MEMO_PAT_PREFIX)).toBe(true)
    expect(tokenInfo.id).toMatch(ID_SHAPE)
    expect(tokenInfo.description).toBe('CLI')
    expect(tokenInfo.prefix).toBe(token.slice(0, 16))
    expect(tokenInfo.expiresAt).toBe(expiresAt)
    expect(tokenInfo.createdAt).toBeGreaterThanOrEqual(before)
    expect(tokenInfo.createdAt).toBeLessThanOrEqual(nowSeconds())
    expect(tokenInfo.lastUsedAt).toBeNull()

    const rows = storedTokens()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(Object.keys(row).sort()).toEqual([
      'created_at',
      'description',
      'expires_at',
      'id',
      'last_used_at',
      'prefix',
      'token_hash',
      'user_id',
    ])
    expect(row).toMatchObject({
      id: tokenInfo.id,
      user_id: OWNER,
      token_hash: await hashOpaqueToken(token),
      prefix: token.slice(0, 16),
      description: 'CLI',
      expires_at: expiresAt,
      last_used_at: null,
    })
    expect(JSON.stringify(row)).not.toContain(token)
  })

  it('defaults an omitted description and expiry', async () => {
    const { tokenInfo } = await createToken(db, OWNER, {})

    expect(tokenInfo).toMatchObject({ description: '', expiresAt: null, lastUsedAt: null })
    expect(storedToken(tokenInfo.id)).toMatchObject({ description: '', expires_at: null })
  })

  it('refuses a non-string or oversized description', async () => {
    await expectApiError(
      createToken(db, OWNER, tokenInput({ description: 7 })),
      400,
      'Token description must be a string',
    )
    await expectApiError(
      createToken(db, OWNER, tokenInput({ description: 'd'.repeat(MEMO_TOKEN_DESCRIPTION_MAX_LENGTH + 1) })),
      400,
      `Token description cannot exceed ${MEMO_TOKEN_DESCRIPTION_MAX_LENGTH} characters`,
    )
    expect(countTokens()).toBe(0)

    const { tokenInfo } = await createToken(db, OWNER, {
      description: 'd'.repeat(MEMO_TOKEN_DESCRIPTION_MAX_LENGTH),
    })
    expect(tokenInfo.description).toHaveLength(MEMO_TOKEN_DESCRIPTION_MAX_LENGTH)
  })

  it('refuses a non-integer or past expiry', async () => {
    await expectApiError(
      createToken(db, OWNER, tokenInput({ expiresAt: 'tomorrow' })),
      400,
      'expiresAt must be a Unix timestamp in seconds',
    )
    await expectApiError(
      createToken(db, OWNER, tokenInput({ expiresAt: 1.5 })),
      400,
      'expiresAt must be a Unix timestamp in seconds',
    )
    await expectApiError(
      createToken(db, OWNER, { expiresAt: nowSeconds() - 1 }),
      400,
      'expiresAt must be in the future',
    )
    expect(countTokens()).toBe(0)
  })

  it('lists the caller tokens newest first without token material', async () => {
    insertToken('a'.repeat(26), OWNER, { description: 'Old', createdAt: 100 })
    insertToken('b'.repeat(26), OWNER, { description: 'New', createdAt: 200, lastUsedAt: 250 })
    insertToken('c'.repeat(26), OTHER, { description: 'Theirs', createdAt: 300 })
    insertToken('d'.repeat(26), OWNER, {
      description: 'Expired',
      createdAt: 150,
      expiresAt: nowSeconds() - 1,
    })

    const tokens = await listTokens(db, OWNER)

    expect(tokens.map((token) => token.description)).toEqual(['New', 'Expired', 'Old'])
    for (const token of tokens) {
      expect(Object.keys(token).sort()).toEqual(TOKEN_FIELDS)
    }
    expect(tokens[0]).toMatchObject({
      prefix: `memo_pat_${'b'.repeat(7)}`,
      expiresAt: null,
      createdAt: 200,
      lastUsedAt: 250,
    })
    expect(JSON.stringify(tokens)).not.toContain('hash-')
  })

  it('revokes only an owned token', async () => {
    insertToken('a'.repeat(26), OWNER)
    insertToken('b'.repeat(26), OTHER)

    await expect(revokeToken(db, OWNER, 'a'.repeat(26))).resolves.toBe(true)
    await expect(revokeToken(db, OWNER, 'b'.repeat(26))).resolves.toBe(false)
    await expect(revokeToken(db, OWNER, 'c'.repeat(26))).resolves.toBe(false)

    expect(storedToken('a'.repeat(26))).toBeUndefined()
    expect(storedToken('b'.repeat(26))).toBeDefined()
  })

  it('finds a live token and records its last use', async () => {
    const { token, tokenInfo } = await createToken(db, OWNER, {})
    const before = nowSeconds()

    await expect(findToken(db, token)).resolves.toEqual({ id: tokenInfo.id, userId: OWNER })

    const row = storedToken(tokenInfo.id)!
    expect(row.last_used_at).not.toBeNull()
    expect(row.last_used_at!).toBeGreaterThanOrEqual(before)
  })

  it('refuses expired, revoked, unknown and foreign-prefix tokens', async () => {
    const expired = await createToken(db, OWNER, { expiresAt: nowSeconds() + 3_600 })
    sqlite.prepare('UPDATE memos_tokens SET expires_at = ? WHERE id = ?')
      .run(nowSeconds() - 1, expired.tokenInfo.id)

    const revoked = await createToken(db, OWNER, {})
    await revokeToken(db, OWNER, revoked.tokenInfo.id)

    await expect(findToken(db, expired.token)).resolves.toBeNull()
    await expect(findToken(db, revoked.token)).resolves.toBeNull()
    await expect(findToken(db, `${MEMO_PAT_PREFIX}${'A'.repeat(43)}`)).resolves.toBeNull()
    await expect(findToken(db, 'not-a-memo-token')).resolves.toBeNull()

    expect(storedToken(expired.tokenInfo.id)!.last_used_at).toBeNull()
    expect(storedToken(revoked.tokenInfo.id)).toBeUndefined()
  })
})

describe('token routes', () => {
  it('refuses every token request without a session or PAT', async () => {
    const list = await request('/api/memos/tokens')
    expect(list.status).toBe(401)
    expect(await list.json()).toEqual({
      error: { code: 'unauthenticated', message: 'Please sign in first' },
    })

    const create = await jsonRequest('/api/memos/tokens', 'POST', { description: 'CLI' })
    expect(create.status).toBe(403)
  })

  it('creates, lists and revokes tokens for the session account', async () => {
    const created = await jsonRequest(
      '/api/memos/tokens',
      'POST',
      { description: 'Laptop' },
      sessionHeaders(),
    )
    expect(created.status).toBe(201)
    const body = await created.json() as MemoTokenCreateResult
    expect(body.token).toMatch(TOKEN_SHAPE)
    expect(body.tokenInfo).toMatchObject({ description: 'Laptop', expiresAt: null, lastUsedAt: null })

    const list = await request('/api/memos/tokens', { headers: sessionHeaders() })
    expect(list.status).toBe(200)
    const listed = await list.json() as { tokens: MemoToken[] }
    expect(listed.tokens).toEqual([body.tokenInfo])
    expect(Object.keys(listed.tokens[0]!).sort()).toEqual(TOKEN_FIELDS)

    const revoked = await request(`/api/memos/tokens/${body.tokenInfo.id}`, {
      method: 'DELETE',
      headers: sessionHeaders(),
    })
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toEqual({ ok: true })

    const after = await request('/api/memos/tokens', { headers: sessionHeaders() })
    expect(await after.json()).toEqual({ tokens: [] })

    const again = await request(`/api/memos/tokens/${body.tokenInfo.id}`, {
      method: 'DELETE',
      headers: sessionHeaders(),
    })
    expect(again.status).toBe(404)
    expect(await again.json()).toEqual({
      error: { code: 'not_found', message: 'Token not found' },
    })
  })

  it('refuses a past expiry and a non-string description with 400', async () => {
    const past = await jsonRequest(
      '/api/memos/tokens',
      'POST',
      { expiresAt: nowSeconds() - 1 },
      sessionHeaders(),
    )
    expect(past.status).toBe(400)
    expect(await past.json()).toEqual({
      error: { code: 'bad_request', message: 'expiresAt must be in the future' },
    })

    const description = await jsonRequest(
      '/api/memos/tokens',
      'POST',
      { description: 7 },
      sessionHeaders(),
    )
    expect(description.status).toBe(400)
    expect(countTokens()).toBe(0)
  })

  it('still requires the client header for session writes', async () => {
    const create = await jsonRequest(
      '/api/memos/tokens',
      'POST',
      { description: 'Laptop' },
      { [SESSION_HEADER]: OWNER },
    )
    expect(create.status).toBe(403)
    expect(await create.json()).toEqual({
      error: {
        code: 'forbidden',
        message: 'Missing client identification header. Refresh and try again',
      },
    })

    const memo = await jsonRequest(
      '/api/memos',
      'POST',
      { content: 'No header' },
      { [SESSION_HEADER]: OWNER },
    )
    expect(memo.status).toBe(403)
    expect(countTokens()).toBe(0)
  })

  it('cannot revoke another account token', async () => {
    const theirs = await createToken(db, OTHER, { description: 'Theirs' })

    const revoked = await request(`/api/memos/tokens/${theirs.tokenInfo.id}`, {
      method: 'DELETE',
      headers: sessionHeaders(OWNER),
    })
    expect(revoked.status).toBe(404)
    expect(countTokens()).toBe(1)

    const list = await request('/api/memos/tokens', { headers: sessionHeaders(OWNER) })
    expect(await list.json()).toEqual({ tokens: [] })

    const stillWorks = await request('/api/memos/tokens', { headers: bearerHeaders(theirs.token) })
    expect(stillWorks.status).toBe(200)
  })

  it('accepts a PAT for memo reads and writes without the client header', async () => {
    const token = await issueToken(OWNER)

    const list = await request('/api/memos', { headers: bearerHeaders(token) })
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual({ items: [], nextCursor: null })

    const created = await jsonRequest('/api/memos', 'POST', { content: 'From the CLI' }, bearerHeaders(token))
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ content: 'From the CLI' })

    const tokenCreated = await jsonRequest(
      '/api/memos/tokens',
      'POST',
      { description: 'Second CLI' },
      bearerHeaders(token),
    )
    expect(tokenCreated.status).toBe(201)
    const body = await tokenCreated.json() as MemoTokenCreateResult
    expect(body.token).toMatch(TOKEN_SHAPE)

    const revoked = await request(`/api/memos/tokens/${body.tokenInfo.id}`, {
      method: 'DELETE',
      headers: bearerHeaders(token),
    })
    expect(revoked.status).toBe(200)
    expect(countTokens()).toBe(1)
  })

  it('records the last use of a PAT', async () => {
    const { token, tokenInfo } = await createToken(db, OWNER, { description: 'CLI' })
    const before = nowSeconds()

    const response = await request('/api/memos/tokens', { headers: bearerHeaders(token) })
    expect(response.status).toBe(200)

    const row = storedToken(tokenInfo.id)!
    expect(row.last_used_at).not.toBeNull()
    expect(row.last_used_at!).toBeGreaterThanOrEqual(before)
    await expect(listTokens(db, OWNER)).resolves.toEqual([
      expect.objectContaining({ id: tokenInfo.id, lastUsedAt: row.last_used_at }),
    ])
  })

  it('refuses expired, revoked and malformed PATs with 401', async () => {
    const expired = await createToken(db, OWNER, { expiresAt: nowSeconds() + 3_600 })
    sqlite.prepare('UPDATE memos_tokens SET expires_at = ? WHERE id = ?')
      .run(nowSeconds() - 1, expired.tokenInfo.id)
    await expectUnauthenticated(await request('/api/memos', { headers: bearerHeaders(expired.token) }))

    const revoked = await createToken(db, OWNER, {})
    await revokeToken(db, OWNER, revoked.tokenInfo.id)
    await expectUnauthenticated(await request('/api/memos', { headers: bearerHeaders(revoked.token) }))

    await expectUnauthenticated(await request('/api/memos', {
      headers: bearerHeaders(`${MEMO_PAT_PREFIX}${'A'.repeat(43)}`),
    }))

    const empty = await request('/api/memos/tokens', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MEMO_PAT_PREFIX}`, 'content-type': 'application/json' },
      body: '{}',
    })
    await expectUnauthenticated(empty)
  })

  it('does not treat other bearer values as memo credentials', async () => {
    const response = await request('/api/memos', {
      headers: { Authorization: 'Bearer not-a-memo-token' },
    })
    await expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: { code: 'unauthenticated', message: 'Please sign in first' },
    })
  })

  it('keeps PATs out of other API paths', async () => {
    const token = await issueToken(OWNER)

    const read = await request('/api/notes', { headers: bearerHeaders(token) })
    expect(read.status).toBe(401)
    expect(await read.json()).toEqual({
      error: { code: 'unauthenticated', message: 'Please sign in first' },
    })

    const write = await jsonRequest('/api/notes', 'POST', {}, bearerHeaders(token))
    expect(write.status).toBe(403)
  })

  it('uses the session when both a session and a PAT are present', async () => {
    const ownerToken = await createToken(db, OWNER, { description: 'Owner' })
    const otherToken = await createToken(db, OTHER, { description: 'Other' })

    const response = await request('/api/memos/tokens', {
      headers: { ...sessionHeaders(OWNER), ...bearerHeaders(otherToken.token) },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { tokens: MemoToken[] }
    expect(body.tokens.map((token) => token.description)).toEqual(['Owner'])

    expect(storedToken(ownerToken.tokenInfo.id)!.last_used_at).toBeNull()
    expect(storedToken(otherToken.tokenInfo.id)!.last_used_at).toBeNull()
  })
})

// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { beforeEach, expect, it, vi } from 'vitest'
import { revokeAllMcpApiKeys } from '../src/worker/mcp/api-keys'
import { revokeLongLivedCredentials } from '../src/worker/mcp/credentials'
import { makeD1 } from './doubles/d1-sqlite'

let sqlite: DatabaseSync
let db: D1Database

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`CREATE TABLE mcp_api_keys (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, key_hash TEXT,
    scopes TEXT, created_at INTEGER, last_used_at INTEGER, revoked_at INTEGER
  )`)
  sqlite.exec(`INSERT INTO mcp_api_keys (id, user_id, revoked_at) VALUES
    ('mine', 'user', NULL), ('mine2', 'user', NULL), ('theirs', 'other', NULL),
    ('stale', 'user', 123)`)
  db = makeD1(sqlite)
})

const active = (userId: string) => (
  sqlite.prepare('SELECT COUNT(*) AS n FROM mcp_api_keys WHERE user_id = ? AND revoked_at IS NULL')
    .get(userId) as { n: number }
).n

it('revokes every active key of the account and nobody else’s', async () => {
  await revokeAllMcpApiKeys(db, 'user')
  expect(active('user')).toBe(0)
  expect(active('other')).toBe(1)
})

it('also revokes outstanding OAuth grants through the provider', async () => {
  const revokeGrant = vi.fn(async () => {})
  const listUserGrants = vi.fn(async () => ({ items: [{ id: 'grant-1' }, { id: 'grant-2' }], cursor: undefined }))
  await revokeLongLivedCredentials(db, { listUserGrants, revokeGrant } as never, 'user')
  expect(active('user')).toBe(0)
  expect(revokeGrant.mock.calls.map((call) => call[0])).toEqual(['grant-1', 'grant-2'])
})

it('still revokes keys when the instance has no OAuth provider bound', async () => {
  await revokeLongLivedCredentials(db, undefined, 'user')
  expect(active('user')).toBe(0)
})

it('is wired into every path that already destroys other sessions', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const auth = read('../src/worker/routes/auth.ts')
  const totp = read('../src/worker/routes/totp.ts')
  expect(auth).toMatch(/destroyOtherSessions\(db,[\s\S]{0,120}?\n\s*await revokeLongLivedCredentials\(/)
  expect(totp.match(/await revokeLongLivedCredentials\(/g)?.length).toBe(2)
})

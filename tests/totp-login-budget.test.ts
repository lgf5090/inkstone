import { DatabaseSync } from 'node:sqlite'
import { webcrypto } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'

const consumeAttemptBudget = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../src/worker/lib/throttle', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/worker/lib/throttle')>(),
  consumeAttemptBudget,
}))

const { completeTotpLogin, createTotpLoginChallenge } = await import('../src/worker/lib/totp-service')
const { generateOpaqueToken } = await import('../src/worker/lib/totp')
const { makeD1 } = await import('./doubles/d1-sqlite')

function freshDb() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, password_hash TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER, created_at INTEGER);
    CREATE TABLE login_attempts (key TEXT PRIMARY KEY, fails INTEGER NOT NULL, last_fail_at INTEGER, locked_until INTEGER);
    CREATE TABLE totp_login_challenges (
      id TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER, created_at INTEGER, claimed_by TEXT
    );
    CREATE TABLE totp_credentials (
      user_id TEXT PRIMARY KEY, enabled_at INTEGER, secret_ciphertext TEXT,
      recovery_generation TEXT, last_used_step INTEGER
    );
    INSERT INTO users VALUES ('user', 'password-hash');
    INSERT INTO totp_credentials VALUES ('user', 1, 'encrypted', 'generation', NULL);
  `)
  return { sqlite, env: { DB: makeD1(sqlite) } }
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  consumeAttemptBudget.mockReset()
  consumeAttemptBudget.mockImplementation(async () => {})
})

it('does not spend work budget rows for unknown challenge tokens', async () => {
  const { env } = freshDb()
  await expect(completeTotpLogin({
    env: env as never,
    challengeToken: generateOpaqueToken(),
    code: '123456',
  })).rejects.toThrow()
  expect(consumeAttemptBudget).not.toHaveBeenCalled()
})

it('still spends work budget for a real challenge before verification', async () => {
  const { env, sqlite } = freshDb()
  const challenge = await createTotpLoginChallenge(env.DB, 'user', 'password-hash')
  await expect(completeTotpLogin({
    env: env as never,
    challengeToken: challenge.challengeToken,
    code: '000000',
  })).rejects.toThrow()
  expect(consumeAttemptBudget).toHaveBeenCalledTimes(1)
  sqlite.close()
})

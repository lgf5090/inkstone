// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addGithubAccount,
  countAccounts,
  decryptAccountToken,
  deleteGithubAccount,
  effectiveGithubToken,
  githubTokenForUsername,
  listAccountRecords,
  listAccountViews,
} from '../src/worker/development/github/accounts'
import { DEVELOPMENT_GITHUB_SCHEMA_STATEMENTS } from '../src/worker/development/github/schema'
import { CredentialVault } from '../src/worker/durable/credential-vault'
import type { Env } from '../src/worker/env'
import { MAX_ACCOUNTS } from '../src/shared/development/github/limits'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'

const USER_A = '0123456789abcdefghjkmnpqrs'
const USER_B = '0123456789abcdefghjkmnpqrt'
const TOKEN_A = 'ghp_token_alpha_1234567890'
const TOKEN_B = 'ghp_token_beta_1234567890'

const vaultStorage = new Map<string, unknown>()
let sqlite: DatabaseSync
let db: D1Database
let env: Env
let nextLogin = 'octocat'

function vaultState(): DurableObjectState {
  return {
    storage: {
      async get(key: string) {
        return vaultStorage.get(key)
      },
      async put(key: string, value: unknown) {
        vaultStorage.set(key, value)
      },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      return await fn()
    },
  } as unknown as DurableObjectState
}

function userResponse(login: string): Response {
  return new Response(JSON.stringify({ login, avatar_url: `https://avatars.example/${login}` }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vaultStorage.clear()
  nextLogin = 'octocat'
  sqlite = new DatabaseSync(':memory:')
  for (const statement of DEVELOPMENT_GITHUB_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  env = testBindings(db, {
    CREDENTIAL_VAULT: testDurableObjectNamespace((request) =>
      new CredentialVault(vaultState()).fetch(request),
    ),
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => userResponse(nextLogin)),
  )
})

afterEach(() => {
  sqlite.close()
  vi.unstubAllGlobals()
})

describe('development github accounts', () => {
  it('verifies a token, stores ciphertext and returns a sanitized view', async () => {
    const account = await addGithubAccount(env, db, USER_A, TOKEN_A)
    expect(account.username).toBe('octocat')
    expect(account.avatarUrl).toBe('https://avatars.example/octocat')
    expect(JSON.stringify(account)).not.toContain(TOKEN_A)
    expect('tokenCiphertext' in account).toBe(false)

    const stored = sqlite
      .prepare('SELECT token_ciphertext FROM development_github_accounts WHERE user_id = ? AND id = ?')
      .get(USER_A, account.id) as { token_ciphertext: string }
    expect(stored.token_ciphertext).toMatch(/^v1\./)
    expect(stored.token_ciphertext).not.toContain(TOKEN_A)

    const views = await listAccountViews(db, USER_A)
    expect(views).toEqual([account])
    expect(JSON.stringify(views)).not.toContain(TOKEN_A)

    const records = await listAccountRecords(db, USER_A)
    expect(records).toHaveLength(1)
    expect(await decryptAccountToken(env, records[0]!)).toBe(TOKEN_A)
    expect(await effectiveGithubToken(env, db, USER_A)).toBe(TOKEN_A)
    expect(await githubTokenForUsername(env, db, USER_A, 'OCTOCAT')).toBe(TOKEN_A)
    expect(await githubTokenForUsername(env, db, USER_A, 'unknown')).toBeNull()
  })

  it('uses an explicitly selected account and rejects an unknown one', async () => {
    const first = await addGithubAccount(env, db, USER_A, TOKEN_A)
    nextLogin = 'second-user'
    const second = await addGithubAccount(env, db, USER_A, TOKEN_B)
    expect(await effectiveGithubToken(env, db, USER_A, second.id)).toBe(TOKEN_B)
    expect(await effectiveGithubToken(env, db, USER_A, first.id)).toBe(TOKEN_A)
    await expect(effectiveGithubToken(env, db, USER_A, 'missing')).rejects.toMatchObject({
      status: 404,
      code: 'github_not_found',
    })
  })

  it('reports whether the token carries the gist scope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      login: 'octocat',
      avatar_url: 'https://avatars.example/octocat',
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-oauth-scopes': 'repo, gist' } })))
    const withGist = await addGithubAccount(env, db, USER_A, TOKEN_A)
    expect(withGist.gistScope).toBe(true)

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      login: 'octocat',
      avatar_url: 'https://avatars.example/octocat',
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-oauth-scopes': 'repo' } })))
    const withoutGist = await addGithubAccount(env, db, USER_A, TOKEN_B)
    expect(withoutGist.gistScope).toBe(false)
  })

  it('updates an existing username instead of adding a second account', async () => {
    const first = await addGithubAccount(env, db, USER_A, TOKEN_A)
    const second = await addGithubAccount(env, db, USER_A, TOKEN_B)
    expect(second.id).toBe(first.id)
    expect(second.createdAt).toBe(first.createdAt)
    expect(await countAccounts(db, USER_A)).toBe(1)
    expect(await effectiveGithubToken(env, db, USER_A)).toBe(TOKEN_B)
  })

  it('isolates accounts by user and deletes by id', async () => {
    const account = await addGithubAccount(env, db, USER_A, TOKEN_A)
    expect(await listAccountViews(db, USER_B)).toEqual([])
    expect(await effectiveGithubToken(env, db, USER_B)).toBeNull()
    expect(await deleteGithubAccount(db, USER_B, account.id)).toBe(false)
    expect(await deleteGithubAccount(db, USER_A, account.id)).toBe(true)
    expect(await listAccountViews(db, USER_A)).toEqual([])
  })

  it('reports an unreadable stored token as invalid', async () => {
    const account = await addGithubAccount(env, db, USER_A, TOKEN_A)
    sqlite
      .prepare('UPDATE development_github_accounts SET token_ciphertext = ? WHERE user_id = ? AND id = ?')
      .run('v1.not-a-real-ciphertext', USER_A, account.id)
    await expect(effectiveGithubToken(env, db, USER_A)).rejects.toMatchObject({
      status: 400,
      code: 'github_token_invalid',
    })
  })

  it('falls back to another account when one ciphertext cannot be read', async () => {
    await addGithubAccount(env, db, USER_A, TOKEN_A)
    nextLogin = 'second-user'
    await addGithubAccount(env, db, USER_A, TOKEN_B)
    const records = await listAccountRecords(db, USER_A)
    const corrupt = records.find((record) => record.username === 'octocat')!
    sqlite
      .prepare('UPDATE development_github_accounts SET token_ciphertext = ? WHERE user_id = ? AND id = ?')
      .run('v1.not-a-real-ciphertext', USER_A, corrupt.id)
    expect(await effectiveGithubToken(env, db, USER_A)).toBe(TOKEN_B)
  })

  it('enforces the account limit for new usernames', async () => {
    for (let index = 0; index < MAX_ACCOUNTS; index += 1) {
      nextLogin = `user-${index}`
      await addGithubAccount(env, db, USER_A, `token-${index}`)
    }
    nextLogin = 'overflow'
    await expect(addGithubAccount(env, db, USER_A, 'token-overflow')).rejects.toMatchObject({
      status: 400,
    })
  })
})

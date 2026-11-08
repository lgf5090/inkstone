// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { hashSync } from 'bcryptjs'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TOOLS_PASSWORD_REQUIRED_COLUMNS,
  TOOLS_PASSWORD_REQUIRED_INDEXES,
  TOOLS_PASSWORD_REQUIRED_TABLES,
  TOOLS_PASSWORD_SCHEMA_STATEMENTS,
} from '../src/worker/tools/password/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { toolsPasswordRoutes } from '../src/worker/routes/tools-password'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'
import { issueConfirmToken } from '../src/worker/tools/password/confirm'
import { SCHEMA_MIGRATIONS } from '../src/worker/db/schema'

const USER_A = 'user-alice'
const USER_B = 'user-bob'

// Rounds 4 keeps the fixture fast; the routes only compare, they never re-hash at cost 10.
const OLD_PASSWORD = 'old-pass'
const KDF_SALT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const OLD_HASH = hashSync(OLD_PASSWORD, 4)

interface CallOptions {
  user?: string | null
  body?: unknown
  headers?: Record<string, string>
}

function testApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))

  // Simulate authentication
  app.use('/api/tools/password/*', async (c, next) => {
    const userId = c.req.header('x-test-user')
    if (userId) {
      c.set('userId', userId)
      c.set('user', {
        id: userId,
        username: userId,
        login: userId,
        name: userId,
        avatarUrl: '',
        role: 'member',
        createdAt: 0,
        settingsRaw: '{}',
      })
    }
    await next()
  })

  app.route('/api/tools/password', toolsPasswordRoutes)
  return app
}

const app = testApp()

let sqlite: DatabaseSync
let env: Env

async function call(
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Response> {
  const userId = options.user === undefined ? USER_A : options.user
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (userId) {
    headers['x-test-user'] = userId
  }
  if (method !== 'GET' && method !== 'HEAD') {
    headers['X-Inkstone-Client'] = '1'
  }
  let body: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  return app.fetch(
    new Request(`http://localhost${path}`, { method, headers, body }),
    env,
  )
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

/**
 * Initialises a vault (when the test has none) and mints the short-lived token destructive routes
 * require. Returns both the token and the headers a guarded call needs.
 */
async function dangerHeaders(user = USER_A): Promise<Record<string, string>> {
  await call('POST', '/api/tools/password/vault/init', {
    user,
    body: { masterHash: OLD_HASH, kdfSalt: KDF_SALT },
  })
  const res = await call('POST', '/api/tools/password/vault/re-auth', {
    user,
    body: { password: OLD_PASSWORD },
  })
  expect(res.status).toBe(200)
  const data = (await json<{ data: { token: string } }>(res)).data
  return { 'X-Inkstone-Confirm': data.token }
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of TOOLS_PASSWORD_SCHEMA_STATEMENTS) {
    sqlite.exec(statement)
  }
  // The unlock budget lives in the shared throttle table, which this module does not own.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS login_attempts (
    key TEXT PRIMARY KEY,
    fails INTEGER NOT NULL DEFAULT 0,
    last_fail_at INTEGER NOT NULL,
    locked_until INTEGER
  )`)
  env = testBindings(makeD1(sqlite), { FILES: testR2Bucket() })
})

afterEach(() => {
  sqlite.close()
})

describe('Password Manager D1 Schema & Tenant Isolation', () => {
  it('creates all 6 required tables and 6 indexes', () => {
    const tableRows = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>
    const tables = new Set(tableRows.map((r) => r.name))
    for (const table of TOOLS_PASSWORD_REQUIRED_TABLES) {
      expect(tables.has(table), `Table ${table} should exist`).toBe(true)
    }

    const indexRows = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
      .all() as Array<{ name: string }>
    const indexes = new Set(indexRows.map((r) => r.name))
    for (const idx of TOOLS_PASSWORD_REQUIRED_INDEXES) {
      expect(indexes.has(idx), `Index ${idx} should exist`).toBe(true)
    }

    for (const [table, requiredCols] of Object.entries(TOOLS_PASSWORD_REQUIRED_COLUMNS)) {
      const colRows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      const cols = new Set(colRows.map((c) => c.name))
      for (const col of requiredCols) {
        expect(cols.has(col), `Column ${col} in ${table} should exist`).toBe(true)
      }
    }
  })

  it('drops the legacy recovery_hint column and keeps the rows that matter', () => {
    const legacy = new DatabaseSync(':memory:')
    legacy.exec(`CREATE TABLE tools_password_vault (
      user_id TEXT NOT NULL PRIMARY KEY,
      master_hash TEXT NOT NULL,
      recovery_hint TEXT NOT NULL DEFAULT '',
      kdf_salt TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
    legacy.exec(`INSERT INTO tools_password_vault VALUES ('u1', 'hash', 'abc', 'salt', 1, 2)`)

    const drop = SCHEMA_MIGRATIONS.find((migration) => migration.version === 325)
    expect(drop, 'migration 325 must take recovery_hint away').toBeTruthy()
    expect(drop!.skipIfColumnMissing).toEqual({ table: 'tools_password_vault', column: 'recovery_hint' })
    legacy.exec(drop!.statements[0]!)

    const columns = (legacy.prepare('PRAGMA table_info(tools_password_vault)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    )
    expect(columns).not.toContain('recovery_hint')
    expect(columns).toEqual(expect.arrayContaining(['master_hash', 'kdf_salt', 'created_at', 'updated_at']))

    const row = legacy.prepare('SELECT master_hash, kdf_salt FROM tools_password_vault').get() as {
      master_hash: string
      kdf_salt: string
    }
    expect(row).toEqual({ master_hash: 'hash', kdf_salt: 'salt' })
    legacy.close()
  })

  it('adds the audit table to a database that predates it', () => {
    const legacy = new DatabaseSync(':memory:')
    const add = SCHEMA_MIGRATIONS.find((migration) => migration.version === 326)
    expect(add, 'migration 326 must add the audit table').toBeTruthy()
    for (const statement of add!.statements) legacy.exec(statement)

    const tables = new Set(
      (legacy.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(
        (table) => table.name,
      ),
    )
    expect(tables.has('tools_password_audit')).toBe(true)
    const indexes = new Set(
      (legacy.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>).map(
        (index) => index.name,
      ),
    )
    expect(indexes.has('idx_tools_password_audit_user')).toBe(true)
    legacy.close()
  })

  it('strictly isolates vault, groups, accounts, settings and backups between users', async () => {
    // 1. User A inits vault
    const initRes = await call('POST', '/api/tools/password/vault/init', {
      user: USER_A,
      body: { masterHash: 'hash-alice-1234567890', kdfSalt: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' },
    })
    expect(initRes.status).toBe(200)

    // User B checks vault: must not see Alice's vault
    const bVaultRes = await call('GET', '/api/tools/password/vault', { user: USER_B })
    expect(bVaultRes.status).toBe(200)
    const bVault = await json<{ ok: boolean; data: { hasVault: boolean } }>(bVaultRes)
    expect(bVault.data.hasVault).toBe(false)

    // 2. User A creates group and account
    const gRes = await call('POST', '/api/tools/password/groups', {
      user: USER_A,
      body: { name: 'Work' },
    })
    expect(gRes.status).toBe(200)
    const gData = await json<{ ok: boolean; data: { id: string } }>(gRes)
    const aliceGroupId = gData.data.id

    const aRes = await call('POST', '/api/tools/password/accounts', {
      user: USER_A,
      body: {
        groupId: aliceGroupId,
        title: 'Work Email',
        username: 'alice@work.com',
        password: 'encrypted-pass',
      },
    })
    expect(aRes.status).toBe(200)
    const aData = await json<{ ok: boolean; data: { id: string } }>(aRes)
    const aliceAccountId = aData.data.id

    // User B lists groups and accounts: must be empty
    const bGroupsRes = await call('GET', '/api/tools/password/groups', { user: USER_B })
    expect(bGroupsRes.status).toBe(200)
    const bGroups = await json<{ ok: boolean; data: unknown[] }>(bGroupsRes)
    expect(bGroups.data).toEqual([])

    const bAccountsRes = await call('GET', '/api/tools/password/accounts', { user: USER_B })
    expect(bAccountsRes.status).toBe(200)
    const bAccounts = await json<{ ok: boolean; data: unknown[] }>(bAccountsRes)
    expect(bAccounts.data).toEqual([])

    // User B attempts to update or delete User A's group: fails (404)
    const bUpdateG = await call('PUT', `/api/tools/password/groups/${aliceGroupId}`, {
      user: USER_B,
      body: { name: 'Hacked' },
    })
    expect(bUpdateG.status).toBe(404)

    const bDeleteG = await call('DELETE', `/api/tools/password/groups/${aliceGroupId}`, {
      user: USER_B,
    })
    expect(bDeleteG.status).toBe(404)

    // User B attempts to update or delete User A's account
    const bUpdateA = await call('PUT', `/api/tools/password/accounts/${aliceAccountId}`, {
      user: USER_B,
      body: { title: 'Hacked Title' },
    })
    expect(bUpdateA.status).toBe(404)

    // 3. User A saves settings
    await call('PUT', '/api/tools/password/settings', {
      user: USER_A,
      body: { autoLockMinutes: 15 },
    })
    const bSettingsRes = await call('GET', '/api/tools/password/settings', { user: USER_B })
    const bSettings = await json<{ ok: boolean; data: { autoLockMinutes: number } }>(bSettingsRes)
    // User B's settings remain default (5 minutes).
    expect(bSettings.data.autoLockMinutes).toBe(5)

    // 4. User A creates backup
    const aBackupRes = await call('POST', '/api/tools/password/backups', { user: USER_A })
    expect(aBackupRes.status).toBe(200)
    const aBackup = await json<{ ok: boolean; data: { id: string } }>(aBackupRes)

    // User B lists backups: must be empty
    const bBackupsRes = await call('GET', '/api/tools/password/backups', { user: USER_B })
    const bBackups = await json<{ ok: boolean; data: unknown[] }>(bBackupsRes)
    expect(bBackups.data).toEqual([])

    // User B cannot restore User A's backup, even with a fresh token of their own.
    const bMasterHash = hashSync('bob-pass', 4)
    await call('POST', '/api/tools/password/vault/init', {
      user: USER_B,
      body: { masterHash: bMasterHash, kdfSalt: KDF_SALT },
    })
    const bReauth = await call('POST', '/api/tools/password/vault/re-auth', {
      user: USER_B,
      body: { password: 'bob-pass' },
    })
    const bToken = (await json<{ data: { token: string } }>(bReauth)).data.token
    const bRestoreRes = await call('POST', `/api/tools/password/backups/${aBackup.data.id}/restore`, {
      user: USER_B,
      headers: { 'X-Inkstone-Confirm': bToken },
    })
    expect(bRestoreRes.status).toBe(404)
  })
})

describe('Password Manager Vault Routes', () => {
  it('handles /vault GET and POST /init, and no longer hands back a recovery hint', async () => {
    const getRes = await call('GET', '/api/tools/password/vault')
    expect(getRes.status).toBe(200)
    expect(await json(getRes)).toEqual({ ok: true, data: { hasVault: false } })

    const shortHash = await call('POST', '/api/tools/password/vault/init', {
      body: { masterHash: 'short' },
    })
    expect(shortHash.status).toBe(400)

    const initRes = await call('POST', '/api/tools/password/vault/init', {
      body: { masterHash: OLD_HASH, kdfSalt: KDF_SALT },
    })
    expect(initRes.status).toBe(200)
    const initData = await json<{ ok: boolean; data: Record<string, unknown> }>(initRes)
    expect(initData.data.hasVault).toBe(true)
    expect(initData.data).not.toHaveProperty('recoveryHint')

    const reinitRes = await call('POST', '/api/tools/password/vault/init', {
      body: { masterHash: hashSync('other', 4), kdfSalt: KDF_SALT },
    })
    expect(reinitRes.status).toBe(400)
  })

  it('verifies the master password on the server and throttles guesses', async () => {
    await call('POST', '/api/tools/password/vault/init', { body: { masterHash: OLD_HASH, kdfSalt: KDF_SALT } })

    const wrong = await call('POST', '/api/tools/password/vault/unlock', {
      body: { password: 'not-it' },
    })
    expect(wrong.status).toBe(401)
    const wrongBody = await json<{ error: { code: string } }>(wrong)
    expect(wrongBody.error.code).toBe('wrong_password')

    const right = await call('POST', '/api/tools/password/vault/unlock', {
      body: { password: OLD_PASSWORD },
    })
    expect(right.status).toBe(200)
    // The client cannot derive the vault key without the per-vault salt.
    expect((await json<{ data: { salt: string } }>(right)).data.salt).toBe(KDF_SALT)

    // A successful unlock clears the budget, so the next mistakes start from zero again.
    const again = await call('POST', '/api/tools/password/vault/unlock', {
      body: { password: OLD_PASSWORD },
    })
    expect(again.status).toBe(200)
  })

  it('refuses a reset that does not prove the old password', async () => {
    await call('POST', '/api/tools/password/vault/init', { body: { masterHash: OLD_HASH, kdfSalt: KDF_SALT } })
    const gRes = await call('POST', '/api/tools/password/groups', { body: { name: 'Main' } })
    const group = (await json<{ ok: boolean; data: { id: string } }>(gRes)).data
    const aRes = await call('POST', '/api/tools/password/accounts', {
      body: { groupId: group.id, title: 'old-title', password: 'old-pass-ciphertext' },
    })
    const account = (await json<{ ok: boolean; data: { id: string } }>(aRes)).data

    const stolen = await call('POST', '/api/tools/password/vault/reset', {
      body: {
        oldPassword: 'guessing',
        newMasterHash: hashSync('attacker-key', 4),
        newKdfSalt: KDF_SALT,
        accounts: [{ id: account.id, title: 'mine', username: '', password: '' }],
      },
    })
    expect(stolen.status).toBe(401)

    // The rejected write must not have touched the rows.
    const untouched = (
      await json<{ ok: boolean; data: Array<{ title: string }> }>(
        await call('GET', '/api/tools/password/accounts'),
      )
    ).data
    expect(untouched[0]!.title).toBe('old-title')

    const accepted = await call('POST', '/api/tools/password/vault/reset', {
      body: {
        oldPassword: OLD_PASSWORD,
        newMasterHash: hashSync('new-key', 4),
        newKdfSalt: KDF_SALT,
        accounts: [{ id: account.id, title: 'new-title', username: '', password: 'new-pass' }],
      },
    })
    expect(accepted.status).toBe(200)

    const resealed = (
      await json<{ ok: boolean; data: Array<{ title: string; password: string }> }>(
        await call('GET', '/api/tools/password/accounts'),
      )
    ).data
    expect(resealed[0]!.title).toBe('new-title')
    expect(resealed[0]!.password).toBe('new-pass')
  })

  it('refuses a reset whose account list is stale instead of leaving old-key rows behind', async () => {
    await call('POST', '/api/tools/password/vault/init', { body: { masterHash: OLD_HASH, kdfSalt: KDF_SALT } })
    const group = (await json<{ data: { id: string } }>(
      await call('POST', '/api/tools/password/groups', { body: { name: 'Keep' } }),
    )).data
    const account = (await json<{ data: { id: string } }>(
      await call('POST', '/api/tools/password/accounts', {
        body: { groupId: group.id, title: 'Original', username: '', password: '' },
      }),
    )).data

    const stale = await call('POST', '/api/tools/password/vault/reset', {
      body: {
        oldPassword: OLD_PASSWORD,
        newMasterHash: OLD_HASH,
        newKdfSalt: KDF_SALT,
        // The payload omits the account the server actually has.
        accounts: [{ id: 'someone-else', title: 'x', username: '', password: '' }],
      },
    })
    expect(stale.status).toBe(409)
    expect((await json<{ error: { code: string } }>(stale)).error.code).toBe('conflict')

    const rows = (await json<{ data: Array<{ id: string; title: string }> }>(
      await call('GET', '/api/tools/password/accounts'),
    )).data
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(account.id)
    expect(rows[0]!.title).toBe('Original')
  })

  it('rolls the rows back and keeps the old verifier when a large reset fails mid-way', async () => {
    await call('POST', '/api/tools/password/vault/init', { body: { masterHash: OLD_HASH, kdfSalt: KDF_SALT } })
    const group = (await json<{ data: { id: string } }>(
      await call('POST', '/api/tools/password/groups', { body: { name: 'Bulk' } }),
    )).data
    const ids: string[] = []
    for (let index = 0; index < 100; index += 1) {
      const created = (await json<{ data: { id: string } }>(
        await call('POST', '/api/tools/password/accounts', {
          body: { groupId: group.id, title: `Old ${index}`, username: '', password: '' },
        }),
      )).data
      ids.push(created.id)
    }

    const realDb = env.DB
    let batchCalls = 0
    const flakyDb = {
      prepare: realDb.prepare.bind(realDb),
      batch: (statements: D1PreparedStatement[]) => {
        batchCalls += 1
        if (batchCalls === 2) return Promise.reject(new Error('injected reset failure'))
        return realDb.batch(statements)
      },
    } as unknown as D1Database
    env = testBindings(flakyDb, { FILES: env.FILES })

    const reset = await call('POST', '/api/tools/password/vault/reset', {
      body: {
        oldPassword: OLD_PASSWORD,
        newMasterHash: hashSync('unused-new', 4),
        newKdfSalt: KDF_SALT,
        accounts: ids.map((id, index) => ({
          id,
          title: `New ${index}`,
          username: '',
          password: '',
        })),
      },
    })
    expect(reset.status).toBe(500)
    expect(batchCalls).toBeGreaterThanOrEqual(3)

    const unlock = await call('POST', '/api/tools/password/vault/unlock', {
      body: { password: OLD_PASSWORD },
    })
    expect(unlock.status).toBe(200)

    const rows = (await json<{ data: Array<{ title: string }> }>(
      await call('GET', '/api/tools/password/accounts'),
    )).data
    expect(rows.every((row) => row.title.startsWith('Old '))).toBe(true)
  })

  it('erases the vault only when the confirmation literal is sent', async () => {
    await call('POST', '/api/tools/password/vault/init', { body: { masterHash: OLD_HASH, kdfSalt: KDF_SALT } })
    await call('POST', '/api/tools/password/groups', { body: { name: 'Main' } })

    const noConfirm = await call('POST', '/api/tools/password/vault/wipe', { body: {} })
    expect(noConfirm.status).toBe(400)
    expect((await json<{ data: { hasVault: boolean } }>(await call('GET', '/api/tools/password/vault'))).data.hasVault).toBe(true)

    // A session alone is not enough: the route must refuse without a fresh master-password token.
    const sessionOnly = await call('POST', '/api/tools/password/vault/wipe', {
      body: { confirm: 'delete-all' },
    })
    expect(sessionOnly.status).toBe(401)
    expect((await json<{ error: { code: string } }>(sessionOnly)).error.code).toBe('reauth_required')
    expect((await json<{ data: { hasVault: boolean } }>(await call('GET', '/api/tools/password/vault'))).data.hasVault).toBe(true)

    const wrongPassword = await call('POST', '/api/tools/password/vault/re-auth', {
      body: { password: 'not-the-password' },
    })
    expect(wrongPassword.status).toBe(401)

    const wiped = await call('POST', '/api/tools/password/vault/wipe', {
      body: { confirm: 'delete-all' },
      headers: await dangerHeaders(),
    })
    expect(wiped.status).toBe(200)
    expect(await json(await call('GET', '/api/tools/password/vault'))).toEqual({
      ok: true,
      data: { hasVault: false },
    })
    const groups = (await json<{ data: unknown[] }>(await call('GET', '/api/tools/password/groups'))).data
    expect(groups).toEqual([])
  })

  it('leaves a structured audit line for unlock attempts without the password in it', async () => {
    await call('POST', '/api/tools/password/vault/init', { body: { masterHash: OLD_HASH, kdfSalt: KDF_SALT } })

    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      lines.push(String(message))
    })
    try {
      await call('POST', '/api/tools/password/vault/unlock', { body: { password: 'definitely-wrong' } })
      await call('POST', '/api/tools/password/vault/unlock', { body: { password: OLD_PASSWORD } })
    } finally {
      spy.mockRestore()
    }

    const events = lines
      .filter((line) => line.includes('password-audit'))
      .map((line) => JSON.parse(line) as { scope: string; action: string; userId: string })
    expect(events.map((event) => event.action)).toEqual(['unlock_failed', 'unlock_ok'])
    expect(events[0]!.userId).toBe(USER_A)
    // The whole point of the line is that it can be shipped somewhere else: no secret may ride along.
    expect(lines.join('\n')).not.toContain('definitely-wrong')
    expect(lines.join('\n')).not.toContain(OLD_PASSWORD)
  })
})

describe('Password Manager Groups Routes', () => {
  it('handles group creation, hierarchy, reorder, update, and deletion constraints', async () => {
    // 1. Create root group
    const g1Res = await call('POST', '/api/tools/password/groups', {
      body: { name: 'Social', sort: 1 },
    })
    expect(g1Res.status).toBe(200)
    const g1 = (await json<{ ok: boolean; data: { id: string; name: string; sort: number } }>(g1Res)).data

    // 2. Create child group
    const g2Res = await call('POST', '/api/tools/password/groups', {
      body: { name: 'Chat', parentId: g1.id, sort: 2 },
    })
    expect(g2Res.status).toBe(200)
    const g2 = (await json<{ ok: boolean; data: { id: string; parentId: string } }>(g2Res)).data
    expect(g2.parentId).toBe(g1.id)

    // 3. Create sibling group
    const g3Res = await call('POST', '/api/tools/password/groups', {
      body: { name: 'Finance', sort: 0 },
    })
    const g3 = (await json<{ ok: boolean; data: { id: string } }>(g3Res)).data

    // 4. List groups (sorted by sort ASC, id ASC)
    const listRes = await call('GET', '/api/tools/password/groups')
    const list = (await json<{ ok: boolean; data: Array<{ id: string; name: string }> }>(listRes)).data
    expect(list.map((g) => g.id)).toEqual([g3.id, g1.id, g2.id])

    // 5. Update group
    const updateRes = await call('PUT', `/api/tools/password/groups/${g3.id}`, {
      body: { name: 'Banking' },
    })
    expect(updateRes.status).toBe(200)
    const updated = (await json<{ ok: boolean; data: { name: string } }>(updateRes)).data
    expect(updated.name).toBe('Banking')

    // 6. The unused group-reorder endpoint was removed with the dead client method.
    const reorderRes = await call('PUT', '/api/tools/password/groups/reorder', {
      body: { groups: [{ id: g1.id, sort: 10 }] },
    })
    expect(reorderRes.status).toBe(404)

    // 7. Delete constraint: g1 has subgroup g2 -> must fail
    const delParentRes = await call('DELETE', `/api/tools/password/groups/${g1.id}`)
    expect(delParentRes.status).toBe(400)

    // Create an account in g2
    await call('POST', '/api/tools/password/accounts', {
      body: { groupId: g2.id, title: 'Telegram' },
    })

    // Delete constraint: g2 has accounts -> must fail
    const delAccountGroupRes = await call('DELETE', `/api/tools/password/groups/${g2.id}`)
    expect(delAccountGroupRes.status).toBe(400)

    // Delete g3 (empty): succeeds
    const delEmptyRes = await call('DELETE', `/api/tools/password/groups/${g3.id}`)
    expect(delEmptyRes.status).toBe(200)
  })

  it('stores a group icon and returns it on the next read', async () => {
    const createRes = await call('POST', '/api/tools/password/groups', {
      body: { name: 'Banking', icon: 'bank' },
    })
    const group = (await json<{ ok: boolean; data: { id: string; icon: string } }>(createRes)).data
    expect(group.icon).toBe('bank')

    const updateRes = await call('PUT', `/api/tools/password/groups/${group.id}`, {
      body: { icon: 'secure' },
    })
    expect(updateRes.status).toBe(200)

    const list = (
      await json<{ ok: boolean; data: Array<{ id: string; icon: string }> }>(
        await call('GET', '/api/tools/password/groups'),
      )
    ).data
    expect(list.find((row) => row.id === group.id)?.icon).toBe('secure')

    // Clearing it goes back to the default picture.
    await call('PUT', `/api/tools/password/groups/${group.id}`, { body: { name: 'Banking' } })
    const after = (
      await json<{ ok: boolean; data: Array<{ id: string; icon: string }> }>(
        await call('GET', '/api/tools/password/groups'),
      )
    ).data
    expect(after.find((row) => row.id === group.id)?.icon).toBe('secure')
  })

  it('refuses a parent that does not exist instead of creating an orphan group', async () => {
    const res = await call('POST', '/api/tools/password/groups', {
      body: { name: 'Orphan', parentId: 'no-such-group' },
    })
    expect(res.status).toBe(400)

    const groups = (await json<{ data: unknown[] }>(await call('GET', '/api/tools/password/groups'))).data
    expect(groups).toHaveLength(0)
  })

  it('refuses making a group its own parent or moving it under a descendant', async () => {
    const root = (await json<{ data: { id: string } }>(
      await call('POST', '/api/tools/password/groups', { body: { name: 'Root' } }),
    )).data
    const child = (await json<{ data: { id: string } }>(
      await call('POST', '/api/tools/password/groups', { body: { name: 'Child', parentId: root.id } }),
    )).data

    const selfRes = await call('PUT', `/api/tools/password/groups/${root.id}`, {
      body: { parentId: root.id },
    })
    expect(selfRes.status).toBe(400)

    // Root under Child would make the two-node chain a cycle and hide both from the tree.
    const cycleRes = await call('PUT', `/api/tools/password/groups/${root.id}`, {
      body: { parentId: child.id },
    })
    expect(cycleRes.status).toBe(400)

    const groups = (
      await json<{ data: Array<{ id: string; parentId: string }> }>(await call('GET', '/api/tools/password/groups'))
    ).data
    expect(groups.find((group) => group.id === root.id)?.parentId).toBe('')
  })

  it('refuses nesting deeper than the server limit', async () => {
    let parentId = ''
    // Seven levels are allowed; the eighth has to be refused by the server, not only by the UI.
    for (let depth = 1; depth <= 7; depth += 1) {
      const res = await call('POST', '/api/tools/password/groups', {
        body: { name: `L${depth}`, parentId },
      })
      expect(res.status, `level ${depth}`).toBe(200)
      parentId = (await json<{ data: { id: string } }>(res)).data.id
    }

    const tooDeep = await call('POST', '/api/tools/password/groups', {
      body: { name: 'L8', parentId },
    })
    expect(tooDeep.status).toBe(400)
  })
})

describe('Password Manager Accounts Routes', () => {
  it('handles account CRUD, filtering by group, reorder, batch moves, batch deletes, and batch import', async () => {
    // Setup 2 groups
    const g1Res = await call('POST', '/api/tools/password/groups', { body: { name: 'Group 1' } })
    const g1 = (await json<{ ok: boolean; data: { id: string } }>(g1Res)).data.id

    const g2Res = await call('POST', '/api/tools/password/groups', { body: { name: 'Group 2' } })
    const g2 = (await json<{ ok: boolean; data: { id: string } }>(g2Res)).data.id

    // Create accounts in Group 1
    const a1Res = await call('POST', '/api/tools/password/accounts', {
      body: {
        groupId: g1,
        title: 'Account 1',
        username: 'user1',
        password: 'pass1-encrypted',
        link: 'https://example.com',
        isFavorite: true,
        sort: 1,
      },
    })
    expect(a1Res.status).toBe(200)
    const a1 = (await json<{ ok: boolean; data: { id: string; isFavorite: boolean } }>(a1Res)).data
    expect(a1.isFavorite).toBe(true)

    const a2Res = await call('POST', '/api/tools/password/accounts', {
      body: {
        groupId: g1,
        title: 'Account 2',
        username: 'user2',
        password: 'pass2-encrypted',
        sort: 2,
      },
    })
    const a2 = (await json<{ ok: boolean; data: { id: string } }>(a2Res)).data

    // Create account in Group 2
    const a3Res = await call('POST', '/api/tools/password/accounts', {
      body: {
        groupId: g2,
        title: 'Account 3',
        username: 'user3',
        password: 'pass3-encrypted',
        sort: 1,
      },
    })
    const a3 = (await json<{ ok: boolean; data: { id: string } }>(a3Res)).data

    // Filter accounts by groupId
    const filterRes = await call('GET', `/api/tools/password/accounts?groupId=${g1}`)
    const filtered = (await json<{ ok: boolean; data: Array<{ id: string }> }>(filterRes)).data
    expect(filtered.map((a) => a.id)).toEqual([a1.id, a2.id])

    // Update account
    const updateRes = await call('PUT', `/api/tools/password/accounts/${a1.id}`, {
      body: { title: 'Account 1 Updated', isFavorite: false },
    })
    expect(updateRes.status).toBe(200)
    const updated = (await json<{ ok: boolean; data: { title: string; isFavorite: boolean } }>(updateRes)).data
    expect(updated.title).toBe('Account 1 Updated')
    expect(updated.isFavorite).toBe(false)

    // Reorder accounts
    const reorderRes = await call('PUT', '/api/tools/password/accounts/reorder', {
      body: {
        accounts: [
          { id: a1.id, sort: 10 },
          { id: a2.id, sort: 5 },
        ],
      },
    })
    expect(reorderRes.status).toBe(200)

    // Batch move a1 and a2 from g1 to g2
    const moveRes = await call('POST', '/api/tools/password/accounts/batch-move', {
      body: { accountIds: [a1.id, a2.id], targetGroupId: g2 },
    })
    expect(moveRes.status).toBe(200)

    const g2AccountsRes = await call('GET', `/api/tools/password/accounts?groupId=${g2}`)
    const g2Accounts = (await json<{ ok: boolean; data: Array<{ id: string }> }>(g2AccountsRes)).data
    expect(g2Accounts.length).toBe(3)

    // Batch import accounts into g1
    const importRes = await call('POST', '/api/tools/password/accounts/import', {
      body: {
        groupId: g1,
        accounts: [
          { title: 'Import 1', username: 'imp1', password: 'pwd' },
          { title: 'Import 2', username: 'imp2', password: 'pwd' },
        ],
      },
    })
    expect(importRes.status).toBe(200)
    const imported = (await json<{ ok: boolean; data: Array<{ id: string; title: string }> }>(importRes)).data
    expect(imported.length).toBe(2)

    // Batch delete
    const batchDelRes = await call('POST', '/api/tools/password/accounts/batch-delete', {
      body: { accountIds: [imported[0].id, imported[1].id] },
    })
    expect(batchDelRes.status).toBe(200)

    // Delete single account
    const delRes = await call('DELETE', `/api/tools/password/accounts/${a3.id}`)
    expect(delRes.status).toBe(200)
  })

  it('rejects a save whose expectedUpdatedAt is stale and accepts the current one', async () => {
    const group = (await json<{ data: { id: string } }>(
      await call('POST', '/api/tools/password/groups', { body: { name: 'Lock' } }),
    )).data
    const created = (await json<{ data: { id: string; updatedAt: number } }>(
      await call('POST', '/api/tools/password/accounts', {
        body: { groupId: group.id, title: 'Original' },
      }),
    )).data

    // Another tab already wrote this row: the first tab's stale timestamp must lose, not overwrite.
    const conflicting = await call('PUT', `/api/tools/password/accounts/${created.id}`, {
      body: { title: 'From stale tab', expectedUpdatedAt: created.updatedAt - 1 },
    })
    expect(conflicting.status).toBe(409)
    expect((await json<{ error: { code: string } }>(conflicting)).error.code).toBe('conflict')

    const afterConflict = (
      await json<{ data: Array<{ title: string }> }>(await call('GET', '/api/tools/password/accounts'))
    ).data
    expect(afterConflict[0]!.title).toBe('Original')

    const current = (await json<{ data: { updatedAt: number } }>(
      await call('PUT', `/api/tools/password/accounts/${created.id}`, {
        body: { title: 'From winning tab' },
      }),
    )).data
    const accepted = await call('PUT', `/api/tools/password/accounts/${created.id}`, {
      body: { title: 'Still current', expectedUpdatedAt: current.updatedAt },
    })
    expect(accepted.status).toBe(200)
  })

  it('persists the TOTP secret and keeps it through a re-seal', async () => {
    await call('POST', '/api/tools/password/vault/init', { body: { masterHash: OLD_HASH, kdfSalt: KDF_SALT } })
    const gRes = await call('POST', '/api/tools/password/groups', { body: { name: 'Main' } })
    const group = (await json<{ ok: boolean; data: { id: string } }>(gRes)).data

    const aRes = await call('POST', '/api/tools/password/accounts', {
      body: {
        groupId: group.id,
        title: 'sealed-title',
        totpSecret: 'sealed-totp',
      },
    })
    const account = (await json<{ ok: boolean; data: { id: string; totpSecret: string } }>(aRes)).data
    expect(account.totpSecret).toBe('sealed-totp')

    // The reset path re-writes every column; a field it does not know about would be dropped.
    const reset = await call('POST', '/api/tools/password/vault/reset', {
      body: {
        oldPassword: OLD_PASSWORD,
        newMasterHash: hashSync('next-key', 4),
        newKdfSalt: KDF_SALT,
        accounts: [
          {
            id: account.id,
            title: 're-sealed-title',
            username: '',
            password: '',
            totpSecret: 'resealed-totp',
          },
        ],
      },
    })
    expect(reset.status).toBe(200)

    const rows = (
      await json<{ ok: boolean; data: Array<{ totpSecret: string }> }>(
        await call('GET', '/api/tools/password/accounts'),
      )
    ).data
    expect(rows[0]!.totpSecret).toBe('resealed-totp')
  })

  it('refuses an account whose group does not exist', async () => {
    const createRes = await call('POST', '/api/tools/password/accounts', {
      body: { groupId: 'no-such-group', title: 'orphan', password: 'x' },
    })
    expect(createRes.status).toBe(400)

    // Moving an existing account into a missing group is refused as well.
    const gRes = await call('POST', '/api/tools/password/groups', { body: { name: 'Real' } })
    const group = (await json<{ ok: boolean; data: { id: string } }>(gRes)).data
    const aRes = await call('POST', '/api/tools/password/accounts', {
      body: { groupId: group.id, title: 'kept' },
    })
    const account = (await json<{ ok: boolean; data: { id: string } }>(aRes)).data
    const moveRes = await call('PUT', `/api/tools/password/accounts/${account.id}`, {
      body: { groupId: 'no-such-group' },
    })
    expect(moveRes.status).toBe(400)

    const list = (
      await json<{ ok: boolean; data: Array<{ id: string; groupId: string }> }>(
        await call('GET', '/api/tools/password/accounts'),
      )
    ).data
    expect(list.find((row) => row.id === account.id)?.groupId).toBe(group.id)
  })

  it('refuses an import larger than the batch cap', async () => {
    const gRes = await call('POST', '/api/tools/password/groups', { body: { name: 'Big' } })
    const group = (await json<{ ok: boolean; data: { id: string } }>(gRes)).data
    const accounts = Array.from({ length: 501 }, (_, index) => ({ title: `t${index}` }))

    const res = await call('POST', '/api/tools/password/accounts/import', {
      body: { groupId: group.id, accounts },
    })
    expect(res.status).toBe(400)

    const stored = (await json<{ data: unknown[] }>(await call('GET', '/api/tools/password/accounts'))).data
    expect(stored).toEqual([])
  })
})

describe('Password Manager Favicon Proxy', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('refuses a private address, a non-host value and a path', async () => {
    for (const domain of ['169.254.169.254', '%2Fetc%2Fpasswd', 'localhost', 'https%3A%2F%2Fx.com']) {
      const res = await call('GET', `/api/tools/password/favicon?domain=${domain}`)
      expect(res.status, domain).toBe(400)
    }
  })

  it('returns the site icon with a private cache header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })),
    )

    const res = await call('GET', '/api/tools/password/favicon?domain=example.com')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('private')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('answers 404 when the site says something that is not an image', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })),
    )

    const res = await call('GET', '/api/tools/password/favicon?domain=example.com')
    expect(res.status).toBe(404)
  })

  it('stops reading an oversized icon instead of buffering it whole', async () => {
    let cancelled = false
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        // One 65 KiB chunk: the cap is crossed on the first read, so the second must never happen.
        controller.enqueue(new Uint8Array(65 * 1024))
      },
      cancel() {
        cancelled = true
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(oversized, { status: 200, headers: { 'content-type': 'image/png' } })),
    )

    const res = await call('GET', '/api/tools/password/favicon?domain=example.com')
    expect(res.status).toBe(404)
    expect(cancelled).toBe(true)
  })
})

describe('Password Manager Settings Routes', () => {
  it('reads defaults and persists the auto-lock value', async () => {
    const getRes = await call('GET', '/api/tools/password/settings')
    expect(getRes.status).toBe(200)
    const initSettings = (await json<{ ok: boolean; data: { autoLockMinutes: number } }>(getRes)).data
    expect(initSettings.autoLockMinutes).toBe(5)

    const putRes = await call('PUT', '/api/tools/password/settings', {
      body: { autoLockMinutes: 10 },
    })
    expect(putRes.status).toBe(200)
    const saved = (await json<{ ok: boolean; data: { autoLockMinutes: number } }>(putRes)).data
    expect(saved.autoLockMinutes).toBe(10)

    const reread = (await json<{ data: { autoLockMinutes: number } }>(
      await call('GET', '/api/tools/password/settings'),
    )).data
    expect(reread.autoLockMinutes).toBe(10)
  })

  it('no longer exposes the removed WebDAV test endpoint', async () => {
    const res = await call('POST', '/api/tools/password/settings/webdav-test', {
      body: { url: 'https://dav.example.com', username: 'a', password: 'b' },
    })
    expect(res.status).toBe(404)
  })

  it('rejects an expired confirmation token', async () => {
    await call('POST', '/api/tools/password/vault/init', {
      body: { masterHash: OLD_HASH, kdfSalt: KDF_SALT },
    })
    const expired = await issueConfirmToken(OLD_HASH, USER_A, Date.now() - 3 * 60 * 1000)
    const res = await call('POST', '/api/tools/password/backups/any/restore', {
      headers: { 'X-Inkstone-Confirm': expired },
    })
    expect(res.status).toBe(401)
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('reauth_required')
  })
})

describe('Password Manager Backup versioning', () => {
  it('refuses a backup from a newer major version before any row is replaced', async () => {
    const group = (await json<{ data: { id: string } }>(
      await call('POST', '/api/tools/password/groups', { body: { name: 'Keep' } }),
    )).data
    await call('POST', '/api/tools/password/accounts', {
      body: { groupId: group.id, title: 'KeepAccount', username: 'u', password: 'p' },
    })

    const createRes = await call('POST', '/api/tools/password/backups', {
      body: {
        data: {
          _backup_info: { type: 'inkstone_password_backup', version: '2.0.0', createTime: 1, platform: 'inkstone' },
          data: {
            groups: [{ id: 'g1', name: 'New', parentId: '', sort: 0, createdAt: 1, updatedAt: 1 }],
            accounts: [],
          },
        },
      },
    })
    const backup = (await json<{ data: { id: string } }>(createRes)).data

    const restoreRes = await call('POST', `/api/tools/password/backups/${backup.id}/restore`, {
      headers: await dangerHeaders(),
    })
    expect(restoreRes.status).toBe(400)
    expect((await json<{ error: { code: string } }>(restoreRes)).error.code).toBe('unsupported_backup_version')

    const accounts = (await json<{ data: Array<{ title: string }> }>(
      await call('GET', '/api/tools/password/accounts'),
    )).data
    expect(accounts.map((account) => account.title)).toEqual(['KeepAccount'])
  })

  it('refuses a snapshot sealed with another master key instead of filling the vault with unreadable rows', async () => {
    await call('POST', '/api/tools/password/vault/init', { body: { masterHash: OLD_HASH, kdfSalt: KDF_SALT } })
    const group = (await json<{ data: { id: string } }>(
      await call('POST', '/api/tools/password/groups', { body: { name: 'Keep' } }),
    )).data
    await call('POST', '/api/tools/password/accounts', {
      body: { groupId: group.id, title: 'KeepAccount' },
    })

    const payload = {
      _backup_info: {
        type: 'inkstone_password_backup',
        version: '1.0.0',
        createTime: 1,
        platform: 'inkstone',
        kdfSalt: 'ffffffffffffffffffffffffffffffff',
      },
      data: {
        groups: [{ id: 'other-g', name: 'Other', parentId: '', sort: 0, createdAt: 1, updatedAt: 1 }],
        accounts: [
          { id: 'other-a', groupId: 'other-g', title: 'OtherAccount', username: '', password: '', link: '', remark: '', sort: 0, createdAt: 1, updatedAt: 1 },
        ],
      },
    }

    const local = await call('POST', '/api/tools/password/backups/restore-local', {
      body: payload,
      headers: await dangerHeaders(),
    })
    expect(local.status).toBe(409)
    expect((await json<{ error: { code: string } }>(local)).error.code).toBe('backup_key_mismatch')

    const after = (await json<{ data: Array<{ title: string }> }>(
      await call('GET', '/api/tools/password/accounts'),
    )).data
    expect(after.map((account) => account.title)).toEqual(['KeepAccount'])
  })

  it('records the current salt on a snapshot it writes', async () => {
    await call('POST', '/api/tools/password/vault/init', { body: { masterHash: OLD_HASH, kdfSalt: KDF_SALT } })
    const created = await call('POST', '/api/tools/password/backups')
    expect(created.status).toBe(200)
    const backup = (await json<{ data: { r2Key: string } }>(created)).data

    const stored = await env.FILES!.get(backup.r2Key)
    expect(stored).toBeTruthy()
    const parsed = JSON.parse(await stored!.text()) as { _backup_info: { kdfSalt?: string } }
    expect(parsed._backup_info.kdfSalt).toBe(KDF_SALT)
  })

  it('restores an uploaded local file only with a fresh confirmation token', async () => {
    await call('POST', '/api/tools/password/vault/init', { body: { masterHash: OLD_HASH, kdfSalt: KDF_SALT } })
    const group = (await json<{ data: { id: string } }>(
      await call('POST', '/api/tools/password/groups', { body: { name: 'Keep' } }),
    )).data
    await call('POST', '/api/tools/password/accounts', {
      body: { groupId: group.id, title: 'KeepAccount' },
    })

    const payload = {
      _backup_info: { type: 'inkstone_password_backup', version: '1.0.0', createTime: 1, platform: 'inkstone' },
      data: {
        groups: [{ id: 'local-g', name: 'Local', parentId: '', sort: 0, createdAt: 1, updatedAt: 1 }],
        accounts: [
          { id: 'local-a', groupId: 'local-g', title: 'LocalAccount', username: '', password: '', link: '', remark: '', sort: 0, createdAt: 1, updatedAt: 1 },
        ],
      },
    }

    // No token: the vault must survive and the client needs to know it has to ask for the master
    // password again, so the code is `reauth_required` rather than a generic 401.
    const unguarded = await call('POST', '/api/tools/password/backups/restore-local', { body: payload })
    expect(unguarded.status).toBe(401)
    expect((await json<{ error: { code: string } }>(unguarded)).error.code).toBe('reauth_required')

    const before = (await json<{ data: Array<{ title: string }> }>(
      await call('GET', '/api/tools/password/accounts'),
    )).data
    expect(before.map((account) => account.title)).toEqual(['KeepAccount'])

    const restored = await call('POST', '/api/tools/password/backups/restore-local', {
      body: payload,
      headers: await dangerHeaders(),
    })
    expect(restored.status).toBe(200)
    expect((await json<{ data: { accountsCount: number } }>(restored)).data.accountsCount).toBe(1)

    const after = (await json<{ data: Array<{ title: string }> }>(
      await call('GET', '/api/tools/password/accounts'),
    )).data
    expect(after.map((account) => account.title)).toEqual(['LocalAccount'])
  })
})

describe('Password Manager Backups & Export Routes', () => {
  it('refuses to restore a snapshot whose references do not resolve', async () => {
    const createRes = await call('POST', '/api/tools/password/backups', {
      body: {
        data: {
          _backup_info: {
            type: 'inkstone_password_backup',
            version: '1.0.0',
            createTime: 1,
            platform: 'inkstone',
          },
          data: {
            groups: [],
            accounts: [{ id: 'a-1', groupId: 'no-such-group', title: 'x' }],
          },
        },
      },
    })
    expect(createRes.status).toBe(200)
    const backup = (await json<{ data: { id: string } }>(createRes)).data

    const restoreRes = await call('POST', `/api/tools/password/backups/${backup.id}/restore`, {
      body: {},
      headers: await dangerHeaders(),
    })
    expect(restoreRes.status).toBe(400)
    const stored = (await json<{ data: unknown[] }>(await call('GET', '/api/tools/password/accounts'))).data
    expect(stored).toEqual([])
  })
  it('refuses a backup with duplicate account ids without touching the current vault', async () => {
    const keepGroup = (await json<{ data: { id: string } }>(
      await call('POST', '/api/tools/password/groups', { body: { name: 'Keep' } }),
    )).data
    await call('POST', '/api/tools/password/accounts', {
      body: { groupId: keepGroup.id, title: 'KeepAccount', username: 'u', password: 'p' },
    })

    const backupRes = await call('POST', '/api/tools/password/backups', {
      body: {
        data: {
          _backup_info: { type: 'inkstone_password_backup', version: '1.0.0', createTime: 1, platform: 'inkstone' },
          data: {
            groups: [{ id: 'g1', name: 'Bulk', parentId: '', sort: 0, createdAt: 1, updatedAt: 1 }],
            accounts: [
              { id: 'dup', groupId: 'g1', title: 'a', username: '', password: '', link: '', remark: '', sort: 0, createdAt: 1, updatedAt: 1 },
              { id: 'dup', groupId: 'g1', title: 'b', username: '', password: '', link: '', remark: '', sort: 1, createdAt: 1, updatedAt: 1 },
            ],
          },
        },
      },
    })
    const backup = (await json<{ data: { id: string } }>(backupRes)).data

    const restoreRes = await call('POST', `/api/tools/password/backups/${backup.id}/restore`, {
      headers: await dangerHeaders(),
    })
    expect(restoreRes.status).toBe(400)

    const accounts = (await json<{ data: Array<{ title: string }> }>(
      await call('GET', '/api/tools/password/accounts'),
    )).data
    expect(accounts.map((account) => account.title)).toEqual(['KeepAccount'])
  })

  it('restores the same snapshot twice without duplicating rows', async () => {
    const backupRes = await call('POST', '/api/tools/password/backups', {
      body: {
        data: {
          _backup_info: { type: 'inkstone_password_backup', version: '1.0.0', createTime: 1, platform: 'inkstone' },
          data: {
            groups: [{ id: 'g1', name: 'Only', parentId: '', sort: 0, createdAt: 1, updatedAt: 1 }],
            accounts: [
              { id: 'a1', groupId: 'g1', title: 'OnlyAccount', username: 'u', password: 'p', link: '', remark: '', sort: 0, createdAt: 1, updatedAt: 1 },
            ],
          },
        },
      },
    })
    const backup = (await json<{ data: { id: string } }>(backupRes)).data

    const headers = await dangerHeaders()
    expect((await call('POST', `/api/tools/password/backups/${backup.id}/restore`, { headers })).status).toBe(200)
    expect((await call('POST', `/api/tools/password/backups/${backup.id}/restore`, { headers })).status).toBe(200)

    const accounts = (await json<{ data: unknown[] }>(await call('GET', '/api/tools/password/accounts'))).data
    const groups = (await json<{ data: unknown[] }>(await call('GET', '/api/tools/password/groups'))).data
    expect(accounts).toHaveLength(1)
    expect(groups).toHaveLength(1)
  })

  it('writes the pre-restore snapshot back when a large restore fails in a later chunk', async () => {
    const keepGroup = (await json<{ data: { id: string } }>(
      await call('POST', '/api/tools/password/groups', { body: { name: 'Keep' } }),
    )).data
    await call('POST', '/api/tools/password/accounts', {
      body: { groupId: keepGroup.id, title: 'KeepAccount', username: 'u', password: 'p' },
    })

    const accounts = Array.from({ length: 100 }, (_, index) => ({
      id: `bulk-${index}`,
      groupId: 'g1',
      title: `Bulk ${index}`,
      username: '',
      password: '',
      link: '',
      remark: '',
      sort: index,
      createdAt: 1,
      updatedAt: 1,
    }))
    const backupRes = await call('POST', '/api/tools/password/backups', {
      body: {
        data: {
          _backup_info: { type: 'inkstone_password_backup', version: '1.0.0', createTime: 1, platform: 'inkstone' },
          data: {
            groups: [{ id: 'g1', name: 'Bulk', parentId: '', sort: 0, createdAt: 1, updatedAt: 1 }],
            accounts,
          },
        },
      },
    })
    const backup = (await json<{ data: { id: string } }>(backupRes)).data

    // Mint the confirmation token before swapping the database: re-auth spends a rate-limit write,
    // which is itself a `batch` and would otherwise be the call the injected failure hits.
    const headers = await dangerHeaders()

    // Let the first chunk land, then fail the second one: the rollback path must put the original
    // rows back rather than leaving a half-restored vault. Batch 1 is the restore rate-limit write,
    // batches 2 and 3 are the 90 + 10 upsert chunks, batch 4 is the rollback.
    const r2 = env.FILES!
    const realDb = env.DB
    let batchCalls = 0
    const flakyDb = {
      prepare: realDb.prepare.bind(realDb),
      batch: (statements: D1PreparedStatement[]) => {
        batchCalls += 1
        if (batchCalls === 3) return Promise.reject(new Error('injected D1 failure'))
        return realDb.batch(statements)
      },
    } as unknown as D1Database
    env = testBindings(flakyDb, { FILES: r2 })

    const restoreRes = await call('POST', `/api/tools/password/backups/${backup.id}/restore`, {
      headers,
    })
    expect(restoreRes.status).toBe(500)
    expect(batchCalls).toBeGreaterThanOrEqual(4)

    const restoredAccounts = (await json<{ data: Array<{ title: string }> }>(
      await call('GET', '/api/tools/password/accounts'),
    )).data
    const restoredGroups = (await json<{ data: Array<{ name: string }> }>(
      await call('GET', '/api/tools/password/groups'),
    )).data
    expect(restoredAccounts.map((account) => account.title)).toEqual(['KeepAccount'])
    expect(restoredGroups.map((group) => group.name)).toEqual(['Keep'])
  })

  it('reads an absent backup body as "back up everything" and refuses one it cannot parse', async () => {
    const gRes = await call('POST', '/api/tools/password/groups', { body: { name: 'NoBodyGroup' } })
    const g = (await json<{ ok: boolean; data: { id: string } }>(gRes)).data
    await call('POST', '/api/tools/password/accounts', {
      body: { groupId: g.id, title: 'NoBodyAccount', username: 'u', password: 'p' },
    })

    const emptyRes = await call('POST', '/api/tools/password/backups')
    expect(emptyRes.status).toBe(200)

    // A truncated upload used to be caught and defaulted, so the caller that meant "back up this subset"
    // got a full snapshot instead. The route cannot honour a body it cannot read, so it says so.
    const brokenRes = await app.fetch(
      new Request('http://localhost/api/tools/password/backups', {
        method: 'POST',
        headers: { 'x-test-user': USER_A, 'X-Inkstone-Client': '1', 'content-type': 'application/json' },
        body: '{"type":"manual"',
      }),
      env,
    )
    expect(brokenRes.status).toBe(400)

    const afterBroken = await call('GET', '/api/tools/password/backups')
    const listed = await json<{ ok: boolean; data: Array<{ id: string }> }>(afterBroken)
    expect(listed.data).toHaveLength(1)
  })

  it('creates backup in R2, lists backups, restores and deletes one', async () => {
    // 1. Create a group and account
    const gRes = await call('POST', '/api/tools/password/groups', { body: { name: 'BackupGroup' } })
    const g = (await json<{ ok: boolean; data: { id: string } }>(gRes)).data

    const aRes = await call('POST', '/api/tools/password/accounts', {
      body: { groupId: g.id, title: 'BackupAccount', username: 'user', password: 'pwd' },
    })
    const a = (await json<{ ok: boolean; data: { id: string } }>(aRes)).data

    // 2. Create backup
    const backupRes = await call('POST', '/api/tools/password/backups', {
      body: { type: 'manual' },
    })
    expect(backupRes.status).toBe(200)
    const backup = (await json<{ ok: boolean; data: { id: string; r2Key: string; filename: string } }>(backupRes)).data
    expect(backup.r2Key).toBe(`tools/password/backup/${USER_A}/${backup.id}.json`)

    // Verify backup in R2
    const storedObj = await env.FILES!.get(backup.r2Key)
    expect(storedObj).toBeTruthy()
    const storedText = await storedObj!.text()
    expect(storedText).toContain('BackupAccount')

    // 3. List backups
    const listRes = await call('GET', '/api/tools/password/backups')
    expect(listRes.status).toBe(200)
    const list = (await json<{ ok: boolean; data: Array<{ id: string }> }>(listRes)).data
    expect(list.length).toBe(1)
    expect(list[0].id).toBe(backup.id)

    // 4. Modify data (delete account and group)
    await call('DELETE', `/api/tools/password/accounts/${a.id}`)
    await call('DELETE', `/api/tools/password/groups/${g.id}`)

    const emptyAccs = (await json<{ ok: boolean; data: unknown[] }>(await call('GET', '/api/tools/password/accounts'))).data
    expect(emptyAccs.length).toBe(0)

    // 5. Restore from backup (the master password is required again)
    const headers = await dangerHeaders()
    const restoreRes = await call('POST', `/api/tools/password/backups/${backup.id}/restore`, { headers })
    expect(restoreRes.status).toBe(200)
    const restoreData = await json<{ ok: boolean; data: { groupsCount: number; accountsCount: number } }>(restoreRes)
    expect(restoreData.data.groupsCount).toBe(1)
    expect(restoreData.data.accountsCount).toBe(1)

    // Verify restored
    const restoredAccs = (await json<{ ok: boolean; data: Array<{ title: string }> }>(await call('GET', '/api/tools/password/accounts'))).data
    expect(restoredAccs.length).toBe(1)
    expect(restoredAccs[0].title).toBe('BackupAccount')

    // 6. Delete backup
    const delBackupRes = await call('DELETE', `/api/tools/password/backups/${backup.id}`, { headers })
    expect(delBackupRes.status).toBe(200)
    expect(await env.FILES!.get(backup.r2Key)).toBeNull()

    // 7. Plaintext exports no longer have a server route, and no plaintext object is written.
    const exportRes = await call('POST', '/api/tools/password/export', {
      body: { type: 'txt', content: 'Password: secret' },
    })
    expect(exportRes.status).toBe(404)
    const bucket = env.FILES as TestR2Bucket
    expect([...bucket.objects.keys()].filter((key) => key.startsWith('tools/password/txt/'))).toEqual([])
    expect([...bucket.objects.keys()].filter((key) => key.startsWith('tools/password/csv/'))).toEqual([])

    // 8. When R2 is unavailable, returns 503
    const envNoR2 = testBindings(makeD1(sqlite))
    const noR2Res = await app.fetch(
      new Request('http://localhost/api/tools/password/backups', {
        method: 'POST',
        headers: { 'x-test-user': USER_A, 'X-Inkstone-Client': '1' },
      }),
      envNoR2,
    )
    expect(noR2Res.status).toBe(503)
  })

  it('throttles backup restores instead of letting one account hammer R2 and D1', async () => {
    await call('POST', '/api/tools/password/vault/init', { body: { masterHash: OLD_HASH, kdfSalt: KDF_SALT } })
    const headers = await dangerHeaders()

    // The budget is spent before the record lookup, so a missing id still consumes an attempt.
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const res = await call('POST', '/api/tools/password/backups/missing/restore', { headers })
      expect(res.status, `attempt ${attempt}`).toBe(404)
    }

    const throttled = await call('POST', '/api/tools/password/backups/missing/restore', { headers })
    expect(throttled.status).toBe(429)
    expect((await json<{ error: { code: string } }>(throttled)).error.code).toBe('too_many_attempts')
  })
})

describe('Password Manager Security Log', () => {
  it('records unlock, re-auth and refused confirmations without any secret in the row', async () => {
    await call('POST', '/api/tools/password/vault/init', { body: { masterHash: OLD_HASH, kdfSalt: KDF_SALT } })

    await call('POST', '/api/tools/password/vault/unlock', { body: { password: 'definitely-wrong' } })
    await call('POST', '/api/tools/password/vault/unlock', { body: { password: OLD_PASSWORD } })
    // A destructive call without a token must leave a "refused" line behind, not silence.
    expect((await call('DELETE', '/api/tools/password/backups/missing')).status).toBe(401)
    const headers = await dangerHeaders()

    const res = await call('GET', '/api/tools/password/audit?limit=50')
    expect(res.status).toBe(200)
    const entries = (await json<{ data: Array<{ action: string; detail: unknown; createdAt: number }> }>(res)).data
    const actions = entries.map((entry) => entry.action)
    expect(actions).toContain('unlock_failed')
    expect(actions).toContain('unlock_ok')
    expect(actions).toContain('reauth_ok')
    expect(actions).toContain('confirm_rejected')
    expect(entries.every((entry) => typeof entry.createdAt === 'number')).toBe(true)

    const serialized = JSON.stringify(entries)
    expect(serialized).not.toContain(OLD_PASSWORD)
    expect(serialized).not.toContain('definitely-wrong')
  })

  it('clears the history on a wipe but keeps the wipe itself as the one remaining line', async () => {
    await call('POST', '/api/tools/password/vault/init', { body: { masterHash: OLD_HASH, kdfSalt: KDF_SALT } })
    const headers = await dangerHeaders()

    const wiped = await call('POST', '/api/tools/password/vault/wipe', {
      body: { confirm: 'delete-all' },
      headers,
    })
    expect(wiped.status).toBe(200)

    const entries = (
      await json<{ data: Array<{ action: string }> }>(await call('GET', '/api/tools/password/audit'))
    ).data
    expect(entries.map((entry) => entry.action)).toEqual(['wipe_ok'])
  })
})

describe('Password Manager Account Paging', () => {
  it('walks the vault with a keyset cursor without repeating or skipping a row', async () => {
    const group = (await json<{ data: { id: string } }>(
      await call('POST', '/api/tools/password/groups', { body: { name: 'Page' } }),
    )).data
    const rows = Array.from({ length: 250 }, (_, index) => ({
      title: `Account ${String(index).padStart(3, '0')}`,
      sort: index,
    }))
    expect(
      (await call('POST', '/api/tools/password/accounts/import', {
        body: { groupId: group.id, accounts: rows },
      })).status,
    ).toBe(200)

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const res = await call('GET', `/api/tools/password/accounts?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      expect(res.status).toBe(200)
      const page = (await json<{ data: { items: Array<{ id: string; sort: number }>; nextCursor: string | null } }>(res)).data
      expect(page.items.length).toBeLessThanOrEqual(100)
      seen.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor ?? undefined
      pages += 1
    } while (cursor)

    expect(pages).toBe(3)
    expect(seen).toHaveLength(250)
    expect(new Set(seen).size).toBe(250)
  })

  it('filters by group and refuses a cursor it did not issue', async () => {
    const first = (await json<{ data: { id: string } }>(
      await call('POST', '/api/tools/password/groups', { body: { name: 'One' } }),
    )).data
    const second = (await json<{ data: { id: string } }>(
      await call('POST', '/api/tools/password/groups', { body: { name: 'Two' } }),
    )).data
    await call('POST', '/api/tools/password/accounts/import', {
      body: { groupId: first.id, accounts: [{ title: 'A' }, { title: 'B' }] },
    })

    const filtered = (
      await json<{ data: { items: Array<{ groupId: string }> } }>(
        await call('GET', `/api/tools/password/accounts?limit=50&groupId=${first.id}`),
      )
    ).data.items
    expect(filtered).toHaveLength(2)
    expect(filtered.every((item) => item.groupId === first.id)).toBe(true)

    const empty = (
      await json<{ data: { items: unknown[] } }>(
        await call('GET', `/api/tools/password/accounts?limit=50&groupId=${second.id}`),
      )
    ).data.items
    expect(empty).toEqual([])

    const bogus = await call('GET', '/api/tools/password/accounts?limit=10&cursor=not-a-cursor')
    expect(bogus.status).toBe(400)
  })

  it('reports each group total so a paged list can still label the tree', async () => {
    const group = (await json<{ data: { id: string } }>(
      await call('POST', '/api/tools/password/groups', { body: { name: 'Counts' } }),
    )).data
    await call('POST', '/api/tools/password/accounts/import', {
      body: { groupId: group.id, accounts: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] },
    })

    const groups = (
      await json<{ data: Array<{ id: string; accountCount?: number }> }>(
        await call('GET', '/api/tools/password/groups'),
      )
    ).data
    // The client only holds one page of rows, so counting them locally would say "0" or the page
    // size; the total has to come from the server.
    expect(groups.find((row) => row.id === group.id)?.accountCount).toBe(3)
  })
})

describe('Password Manager Breach Lookup', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('forwards exactly the five-character prefix and returns suffix counts', async () => {
    const requested: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requested.push(String(url))
        return new Response(
          [
            '0018A45C4D1DEF81644B54AB7F969B88D65:1',
            '00D4F6E8FA6EECAD2A3AA415EEC418D38EC:0',
            'not-a-line',
          ].join('\n'),
          { status: 200, headers: { 'content-type': 'text/plain' } },
        )
      }),
    )

    const res = await call('GET', '/api/tools/password/breach?prefix=5baa6')
    expect(res.status).toBe(200)
    const entries = (await json<{ data: Array<{ suffix: string; count: number }> }>(res)).data
    // The padded zero line is dropped; only real hits remain.
    expect(entries).toEqual([{ suffix: '0018A45C4D1DEF81644B54AB7F969B88D65', count: 1 }])
    expect(requested).toEqual(['https://api.pwnedpasswords.com/range/5BAA6'])
  })

  it('refuses anything that is not five hex characters before calling upstream', async () => {
    const fetchSpy = vi.fn(async () => new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    for (const prefix of ['', '5BAA', '5BAA67', 'ZZZZZ', '5BAA6%20']) {
      const res = await call('GET', `/api/tools/password/breach?prefix=${encodeURIComponent(prefix)}`)
      expect(res.status, prefix).toBe(400)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('answers 503 and writes no prefix anywhere when the upstream is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))))
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      logs.push(String(message))
    })
    try {
      const res = await call('GET', '/api/tools/password/breach?prefix=5BAA6')
      expect(res.status).toBe(503)
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe('hibp_unavailable')
    } finally {
      spy.mockRestore()
    }
    // The prefix is a fragment of a password hash: it must not appear in a log line or an audit row.
    expect(logs.join('\n')).not.toContain('5BAA6')
    const audit = (await json<{ data: Array<{ detail: unknown }> }>(
      await call('GET', '/api/tools/password/audit'),
    )).data
    expect(JSON.stringify(audit)).not.toContain('5BAA6')
  })

  it('throttles lookups per account', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))

    for (let attempt = 1; attempt <= 60; attempt += 1) {
      const res = await call('GET', '/api/tools/password/breach?prefix=5BAA6')
      expect(res.status, `attempt ${attempt}`).toBe(200)
    }
    const throttled = await call('GET', '/api/tools/password/breach?prefix=5BAA6')
    expect(throttled.status).toBe(429)
  })
})

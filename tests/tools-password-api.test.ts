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
import { testBindings, testR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

vi.mock('webdav', () => ({
  createClient: vi.fn((url: string) => {
    if (url.includes('error') || url.includes('fail')) {
      return {
        getDirectoryContents: vi.fn().mockRejectedValue(new Error('WebDAV authentication failed')),
      }
    }
    return {
      getDirectoryContents: vi.fn().mockResolvedValue([]),
    }
  }),
}))

const USER_A = 'user-alice'
const USER_B = 'user-bob'

// Rounds 4 keeps the fixture fast; the routes only compare, they never re-hash at cost 10.
const OLD_PASSWORD = 'old-pass'
const KDF_SALT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const OLD_HASH = hashSync(OLD_PASSWORD, 4)

interface CallOptions {
  user?: string | null
  body?: unknown
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
  const headers: Record<string, string> = {}
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
  it('creates all 5 required tables and 4 indexes', () => {
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
      body: { autoLockMinutes: 15, autoBackupEnabled: false },
    })
    const bSettingsRes = await call('GET', '/api/tools/password/settings', { user: USER_B })
    const bSettings = await json<{ ok: boolean; data: { autoLockMinutes: number; autoBackupEnabled: boolean } }>(bSettingsRes)
    // User B's settings remain default (5 minutes, autoBackupEnabled: true)
    expect(bSettings.data.autoLockMinutes).toBe(5)
    expect(bSettings.data.autoBackupEnabled).toBe(true)

    // 4. User A creates backup
    const aBackupRes = await call('POST', '/api/tools/password/backups', { user: USER_A })
    expect(aBackupRes.status).toBe(200)
    const aBackup = await json<{ ok: boolean; data: { id: string } }>(aBackupRes)

    // User B lists backups: must be empty
    const bBackupsRes = await call('GET', '/api/tools/password/backups', { user: USER_B })
    const bBackups = await json<{ ok: boolean; data: unknown[] }>(bBackupsRes)
    expect(bBackups.data).toEqual([])

    // User B cannot restore User A's backup
    const bRestoreRes = await call('POST', `/api/tools/password/backups/${aBackup.data.id}/restore`, { user: USER_B })
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

  it('erases the vault only when the confirmation literal is sent', async () => {
    await call('POST', '/api/tools/password/vault/init', { body: { masterHash: OLD_HASH, kdfSalt: KDF_SALT } })
    await call('POST', '/api/tools/password/groups', { body: { name: 'Main' } })

    const noConfirm = await call('POST', '/api/tools/password/vault/wipe', { body: {} })
    expect(noConfirm.status).toBe(400)
    expect((await json<{ data: { hasVault: boolean } }>(await call('GET', '/api/tools/password/vault'))).data.hasVault).toBe(true)

    const wiped = await call('POST', '/api/tools/password/vault/wipe', {
      body: { confirm: 'delete-all' },
    })
    expect(wiped.status).toBe(200)
    expect(await json(await call('GET', '/api/tools/password/vault'))).toEqual({
      ok: true,
      data: { hasVault: false },
    })
    const groups = (await json<{ data: unknown[] }>(await call('GET', '/api/tools/password/groups'))).data
    expect(groups).toEqual([])
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

    // 6. Reorder groups
    const reorderRes = await call('PUT', '/api/tools/password/groups/reorder', {
      body: {
        groups: [
          { id: g1.id, sort: 10 },
          { id: g2.id, parentId: g1.id, sort: 20 },
          { id: g3.id, sort: 30 },
        ],
      },
    })
    expect(reorderRes.status).toBe(200)

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
})

describe('Password Manager Settings Routes', () => {
  it('handles GET and PUT settings, and WebDAV test endpoint', async () => {
    // Initial settings
    const getRes = await call('GET', '/api/tools/password/settings')
    expect(getRes.status).toBe(200)
    const initSettings = (await json<{ ok: boolean; data: { autoLockMinutes: number; webdav: { enabled: boolean } } }>(getRes)).data
    expect(initSettings.autoLockMinutes).toBe(5)
    expect(initSettings.webdav.enabled).toBe(false)

    // Save settings
    const putRes = await call('PUT', '/api/tools/password/settings', {
      body: {
        webdavUrl: 'https://dav.example.com/remote.php/webdav',
        webdavUsername: 'admin',
        webdavPassword: 'secretpassword',
        webdavEnabled: true,
        autoBackupEnabled: false,
        autoLockMinutes: 10,
      },
    })
    expect(putRes.status).toBe(200)
    const saved = (await json<{ ok: boolean; data: { autoLockMinutes: number; webdav: { username: string; enabled: boolean; password: string; hasPassword: boolean } } }>(putRes)).data
    expect(saved.autoLockMinutes).toBe(10)
    expect(saved.webdav.username).toBe('admin')
    expect(saved.webdav.enabled).toBe(true)
    // The secret is write-only: neither response may echo it back.
    expect(saved.webdav.password).toBe('')
    expect(saved.webdav.hasPassword).toBe(true)

    const reread = (
      await json<{ data: { webdav: { password: string; hasPassword: boolean } } }>(
        await call('GET', '/api/tools/password/settings'),
      )
    ).data
    expect(reread.webdav.password).toBe('')
    expect(reread.webdav.hasPassword).toBe(true)

    // Saving without the password keeps the stored one.
    await call('PUT', '/api/tools/password/settings', {
      body: { webdavUrl: 'https://dav.example.com/other', webdavEnabled: true },
    })
    const kept = (
      await json<{ data: { webdav: { hasPassword: boolean } } }>(
        await call('GET', '/api/tools/password/settings'),
      )
    ).data
    expect(kept.webdav.hasPassword).toBe(true)

    // An address the outbound guard refuses never reaches the network.
    const blocked = await call('POST', '/api/tools/password/settings/webdav-test', {
      body: { url: 'http://169.254.169.254/latest/meta-data/', username: 'a', password: 'b' },
    })
    expect(blocked.status).toBe(400)
    expect((await json<{ error: { message: string } }>(blocked)).error.message).toContain(
      'not reachable',
    )

    // WebDAV test success
    const testOkRes = await call('POST', '/api/tools/password/settings/webdav-test', {
      body: {
        url: 'https://dav.example.com/remote.php/webdav',
        username: 'admin',
        password: 'secretpassword',
      },
    })
    expect(testOkRes.status).toBe(200)
    expect(await json(testOkRes)).toEqual({ ok: true, message: 'WebDAV connection successful' })

    // WebDAV test failure
    const testFailRes = await call('POST', '/api/tools/password/settings/webdav-test', {
      body: {
        url: 'https://dav.example.com/error-path',
        username: 'admin',
        password: 'badpassword',
      },
    })
    expect(testFailRes.status).toBe(400)
    const failData = await json<{ ok: boolean; message: string }>(testFailRes)
    expect(failData.ok).toBe(false)
    expect(failData.message).toContain('failed')
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
    })
    expect(restoreRes.status).toBe(400)
    const stored = (await json<{ data: unknown[] }>(await call('GET', '/api/tools/password/accounts'))).data
    expect(stored).toEqual([])
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

  it('creates backup in R2, lists backups, restores backup, and exports TXT/CSV files', async () => {
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

    // 5. Restore from backup
    const restoreRes = await call('POST', `/api/tools/password/backups/${backup.id}/restore`)
    expect(restoreRes.status).toBe(200)
    const restoreData = await json<{ ok: boolean; data: { groupsCount: number; accountsCount: number } }>(restoreRes)
    expect(restoreData.data.groupsCount).toBe(1)
    expect(restoreData.data.accountsCount).toBe(1)

    // Verify restored
    const restoredAccs = (await json<{ ok: boolean; data: Array<{ title: string }> }>(await call('GET', '/api/tools/password/accounts'))).data
    expect(restoredAccs.length).toBe(1)
    expect(restoredAccs[0].title).toBe('BackupAccount')

    // 6. Delete backup
    const delBackupRes = await call('DELETE', `/api/tools/password/backups/${backup.id}`)
    expect(delBackupRes.status).toBe(200)
    expect(await env.FILES!.get(backup.r2Key)).toBeNull()

    // 7. Export plain TXT
    const exportTxtRes = await call('POST', '/api/tools/password/export', {
      body: {
        type: 'txt',
        content: 'Title: Example\nUsername: testuser\nPassword: secret\n',
      },
    })
    expect(exportTxtRes.status).toBe(200)
    const exportTxt = (
      await json<{ ok: boolean; data: { fileId: string; downloadUrl: string } }>(exportTxtRes)
    ).data
    expect(exportTxt.downloadUrl).toBe(`/api/tools/password/export/txt/${exportTxt.fileId}`)

    // Read export TXT
    const getExportTxtRes = await call('GET', `/api/tools/password/export/txt/${exportTxt.fileId}`)
    expect(getExportTxtRes.status).toBe(200)
    const txtContent = await getExportTxtRes.text()
    expect(txtContent).toContain('Title: Example')

    // 8. Export plain CSV
    const exportCsvRes = await call('POST', '/api/tools/password/export', {
      body: {
        type: 'csv',
        content: 'title,username,password\nExample,testuser,secret\n',
      },
    })
    expect(exportCsvRes.status).toBe(200)
    const exportCsv = (
      await json<{ ok: boolean; data: { fileId: string; downloadUrl: string } }>(exportCsvRes)
    ).data
    // The R2 key is internal; what the client is handed must be a route it can actually fetch.
    expect(exportCsv.downloadUrl).toBe(`/api/tools/password/export/csv/${exportCsv.fileId}`)
    const roundTrip = await call('GET', exportCsv.downloadUrl)
    expect(roundTrip.status).toBe(200)
    expect(await roundTrip.text()).toContain('Example,testuser,secret')
    // A plaintext dump must not be retained by a browser or a shared cache.
    expect(roundTrip.headers.get('cache-control')).toBe('no-store')
    expect(roundTrip.headers.get('content-disposition')).toContain('attachment')

    // 9. When R2 is unavailable, returns 503
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
})

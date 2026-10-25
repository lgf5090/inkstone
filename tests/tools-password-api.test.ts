// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
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
      body: { masterHash: 'hash-alice-1234567890', recoveryHint: 'Alice secret question' },
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
  it('handles /vault GET, POST /init, POST /reset with schema validation', async () => {
    // GET initial
    const getRes = await call('GET', '/api/tools/password/vault')
    expect(getRes.status).toBe(200)
    expect(await json(getRes)).toEqual({ ok: true, data: { hasVault: false } })

    // POST /init validation failures
    const shortHash = await call('POST', '/api/tools/password/vault/init', {
      body: { masterHash: 'short', recoveryHint: 'hint' },
    })
    expect(shortHash.status).toBe(400)

    const missingHint = await call('POST', '/api/tools/password/vault/init', {
      body: { masterHash: 'hash-length-sufficient-12345', recoveryHint: '' },
    })
    expect(missingHint.status).toBe(400)

    // Valid init
    const initRes = await call('POST', '/api/tools/password/vault/init', {
      body: { masterHash: 'master-hash-valid-1234567890', recoveryHint: 'First pet name' },
    })
    expect(initRes.status).toBe(200)
    const initData = await json<{ ok: boolean; data: { hasVault: boolean; recoveryHint: string } }>(initRes)
    expect(initData.data.hasVault).toBe(true)
    expect(initData.data.recoveryHint).toBe('First pet name')

    // Cannot init twice
    const reinitRes = await call('POST', '/api/tools/password/vault/init', {
      body: { masterHash: 'another-master-hash-123456789', recoveryHint: 'Second hint' },
    })
    expect(reinitRes.status).toBe(400)

    // Create group & account to test reset reencryption
    const gRes = await call('POST', '/api/tools/password/groups', { body: { name: 'Main' } })
    const group = await json<{ ok: boolean; data: { id: string } }>(gRes)
    const aRes = await call('POST', '/api/tools/password/accounts', {
      body: {
        groupId: group.data.id,
        title: 'old-title-ciphertext',
        username: 'old-user-ciphertext',
        password: 'old-pass-ciphertext',
      },
    })
    const account = await json<{ ok: boolean; data: { id: string } }>(aRes)

    // POST /reset
    const resetRes = await call('POST', '/api/tools/password/vault/reset', {
      body: {
        newMasterHash: 'new-master-hash-valid-9876543210',
        newRecoveryHint: 'Updated recovery hint',
        accounts: [
          {
            id: account.data.id,
            title: 'new-title-ciphertext',
            username: 'new-user-ciphertext',
            password: 'new-pass-ciphertext',
          },
        ],
      },
    })
    expect(resetRes.status).toBe(200)

    // Verify updated state & re-encrypted account
    const stateRes = await call('GET', '/api/tools/password/vault')
    const stateData = await json<{ ok: boolean; data: { recoveryHint: string } }>(stateRes)
    expect(stateData.data.recoveryHint).toBe('Updated recovery hint')

    const accountsRes = await call('GET', '/api/tools/password/accounts')
    const accountsData = await json<{ ok: boolean; data: Array<{ title: string; password: string }> }>(accountsRes)
    expect(accountsData.data[0].title).toBe('new-title-ciphertext')
    expect(accountsData.data[0].password).toBe('new-pass-ciphertext')
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
    const saved = (await json<{ ok: boolean; data: { autoLockMinutes: number; webdav: { username: string; enabled: boolean } } }>(putRes)).data
    expect(saved.autoLockMinutes).toBe(10)
    expect(saved.webdav.username).toBe('admin')
    expect(saved.webdav.enabled).toBe(true)

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
    const exportTxt = (await json<{ ok: boolean; data: { fileId: string; key: string } }>(exportTxtRes)).data
    expect(exportTxt.key).toBe(`tools/password/txt/${USER_A}/${exportTxt.fileId}.txt`)

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
    const exportCsv = (await json<{ ok: boolean; data: { fileId: string; key: string } }>(exportCsvRes)).data
    expect(exportCsv.key).toBe(`tools/password/csv/${USER_A}/${exportCsv.fileId}.csv`)

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

/**
 * Password Manager API routes (`/api/tools/password/*`).
 */

import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  BatchDeleteAccountsSchema,
  BatchImportAccountsSchema,
  BatchMoveAccountsSchema,
  CreateAccountSchema,
  CreateGroupSchema,
  InitVaultSchema,
  ReauthSchema,
  ReorderAccountsSchema,
  ResetMasterPasswordSchema,
  SaveSettingsSchema,
  UnlockVaultSchema,
  UpdateAccountSchema,
  UpdateGroupSchema,
  WipeVaultSchema,
} from '@shared/tools/password/schemas'
import type { PasswordBackupData } from '@shared/tools/password/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import {
  assertAttemptBudget,
  clearLoginFailures,
  consumeAttemptBudget,
} from '../lib/throttle'
import { requireAuth } from '../middleware/auth'
import {
  deleteFromR2,
  readBackupFromR2,
  uploadBackupToR2,
} from '../tools/password/r2'
import { PasswordStore } from '../tools/password/store'
import { verifyMasterHash } from '../tools/password/verify'
import {
  CONFIRM_TOKEN_TTL_MS,
  issueConfirmToken,
  verifyConfirmToken,
} from '../tools/password/confirm'
import { fetchFavicon, parseFaviconDomain } from '../tools/password/favicon'

export const toolsPasswordRoutes = new Hono<AppBindings>()

toolsPasswordRoutes.use('*', requireAuth)

function getUserId(c: Context<AppBindings>): string {
  const user = c.get('user')
  const userId = user?.id || c.get('userId')
  if (!userId) {
    throw ApiError.unauthenticated()
  }
  return userId
}

function getStore(c: Context<AppBindings>): PasswordStore {
  return new PasswordStore(c.env.DB, getUserId(c))
}

async function parseBody<T>(c: Context<AppBindings>, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    const message = issue ? `${issue.path.join('.')}: ${issue.message}` : 'Validation failed'
    throw ApiError.badRequest(message)
  }
  return result.data
}

/**
 * Destructive routes require a token minted by `/vault/re-auth` seconds earlier. A session alone is
 * not enough: it lasts for months and would otherwise let a borrowed browser wipe or replace a vault
 * without knowing the master password.
 */
async function requireDangerousConfirm(c: Context<AppBindings>): Promise<void> {
  const vault = await getStore(c).getVault()
  if (!vault) {
    throw ApiError.badRequest('Vault is not initialized')
  }
  try {
    await verifyConfirmToken(
      vault.masterHash,
      getUserId(c),
      c.req.header('X-Inkstone-Confirm'),
    )
  } catch (error) {
    audit('confirm_rejected', getUserId(c), { path: new URL(c.req.url).pathname })
    throw error
  }
}

// ---------------------------------------------------------------- Vault
/**
 * Master-password guesses are spent from one budget per user, the same ladder login uses. Before
 * this existed the check lived in the browser: a 6-character password was verified by whether a
 * CBC padding check happened to pass, with no rate limit and nothing to log.
 */
const UNLOCK_WINDOW_MS = 10 * 60 * 1000
const MAX_BACKUP_BYTES = 25 * 1024 * 1024
const BACKUP_BUDGET = { maxAttempts: 30, windowMs: 10 * 60 * 1000, lockMs: 10 * 60 * 1000 }

async function spendBackupBudget(c: Context<AppBindings>, action: string): Promise<void> {
  const key = `password-backup:${getUserId(c)}:${action}`
  await assertAttemptBudget(
    () =>
      consumeAttemptBudget(c.env.DB, [
        { key, ...BACKUP_BUDGET },
      ]),
    'Too many backup operations',
  )
}

async function spendFaviconBudget(c: Context<AppBindings>): Promise<void> {
  const key = `password-favicon:${getUserId(c)}`
  await assertAttemptBudget(
    () =>
      consumeAttemptBudget(c.env.DB, [
        { key, maxAttempts: 120, windowMs: UNLOCK_WINDOW_MS, lockMs: UNLOCK_WINDOW_MS },
      ]),
    'Too many favicon requests',
  )
}

async function spendUnlockBudget(c: Context<AppBindings>): Promise<string> {
  const key = `password-unlock:${getUserId(c)}`
  await assertAttemptBudget(
    () =>
      consumeAttemptBudget(c.env.DB, [
        { key, maxAttempts: 10, windowMs: UNLOCK_WINDOW_MS, lockMs: UNLOCK_WINDOW_MS },
      ]),
    'Too many master password attempts',
  )
  return key
}

function wrongMasterPassword(): ApiError {
  return new ApiError(401, 'wrong_password', 'Master password is incorrect')
}

/**
 * A backup is a foreign document even when this server wrote it. The envelope names the format and
 * its major version; a file from an unknown format is refused before a single row is replaced.
 */
const BACKUP_FORMATS = new Set(['inkstone_password_backup', 'upassword_backup'])

function assertBackupMetadata(backup: PasswordBackupData): void {
  const info = backup._backup_info
  if (!info || typeof info !== 'object' || typeof info.type !== 'string') {
    throw ApiError.badRequest('Backup is missing its format information')
  }
  if (!BACKUP_FORMATS.has(info.type)) {
    throw ApiError.badRequest(`Unsupported backup format: ${info.type}`)
  }
  if (typeof info.version !== 'string' || !/^1\./.test(info.version)) {
    throw new ApiError(400, 'unsupported_backup_version', `Unsupported backup version: ${String(info.version)}`)
  }
}

/**
 * Refuses a snapshot written under a different master key.
 *
 * A snapshot is only ciphertext: restoring one taken before a password change replaces every row
 * with values the current key cannot open. The salt is not a secret and older snapshots do not carry
 * it, so the check only fires when the snapshot says which key it belongs to.
 */
function assertBackupMatchesVault(backup: PasswordBackupData, vaultKdfSalt: string): void {
  const backupSalt = backup._backup_info?.kdfSalt
  if (!backupSalt || !vaultKdfSalt || backupSalt === vaultKdfSalt) return
  throw new ApiError(
    409,
    'backup_key_mismatch',
    'This backup was sealed with a different master password and cannot be opened by the current one',
  )
}

/**
 * A structured line for the sensitive operations that had no trace at all: unlock, reset, wipe,
 * restore and backup deletion. Only ids, counts and outcomes — never a password, a secret or a
 * ciphertext body. Written as one JSON object so a log pipeline can collect it without parsing prose.
 */
function audit(action: string, userId: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ scope: 'password-audit', action, userId, at: Date.now(), ...detail }))
}

toolsPasswordRoutes.get('/vault', async (c) => {
  const store = getStore(c)
  const state = await store.getVaultState()
  return c.json({ ok: true, data: state })
})

toolsPasswordRoutes.post('/vault/init', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, InitVaultSchema)
  const state = await store.initVault(body.masterHash, body.kdfSalt)
  return c.json({ ok: true, data: state })
})

toolsPasswordRoutes.post('/vault/unlock', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, UnlockVaultSchema)
  const vault = await store.getVault()
  if (!vault) {
    throw ApiError.badRequest('Vault is not initialized')
  }

  const budgetKey = await spendUnlockBudget(c)
  if (!verifyMasterHash(body.password, vault.masterHash)) {
    audit('unlock_failed', getUserId(c))
    throw wrongMasterPassword()
  }
  await clearLoginFailures(c.env.DB, [budgetKey])
  audit('unlock_ok', getUserId(c))
  // An empty salt means the vault predates the salted derivation; the client re-seals it now that
  // it has the password in hand.
  return c.json({ ok: true, data: { ok: true, salt: vault.kdfSalt } })
})

toolsPasswordRoutes.post('/vault/re-auth', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, ReauthSchema)
  const vault = await store.getVault()
  if (!vault) {
    throw ApiError.badRequest('Vault is not initialized')
  }

  const budgetKey = await spendUnlockBudget(c)
  if (!verifyMasterHash(body.password, vault.masterHash)) {
    audit('reauth_failed', getUserId(c))
    throw wrongMasterPassword()
  }
  await clearLoginFailures(c.env.DB, [budgetKey])
  audit('reauth_ok', getUserId(c))

  return c.json({
    ok: true,
    data: {
      token: await issueConfirmToken(vault.masterHash, getUserId(c)),
      expiresInMs: CONFIRM_TOKEN_TTL_MS,
    },
  })
})

toolsPasswordRoutes.post('/vault/reset', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, ResetMasterPasswordSchema)
  const vault = await store.getVault()
  if (!vault) {
    throw ApiError.badRequest('Vault is not initialized')
  }

  // The old password is the authorisation for this write. Without it, a stolen session could
  // re-encrypt the whole vault under a key the attacker chose.
  const budgetKey = await spendUnlockBudget(c)
  if (!verifyMasterHash(body.oldPassword, vault.masterHash)) {
    audit('reset_failed', getUserId(c))
    throw wrongMasterPassword()
  }
  await clearLoginFailures(c.env.DB, [budgetKey])
  await store.resetMasterPassword(body.newMasterHash, body.newKdfSalt, body.accounts)
  audit('reset_ok', getUserId(c), { accounts: body.accounts.length })
  return c.json({ ok: true })
})

toolsPasswordRoutes.post('/vault/wipe', async (c) => {
  const store = getStore(c)
  await parseBody(c, WipeVaultSchema)
  await requireDangerousConfirm(c)
  const backupKeys = await store.wipeVault()
  audit('wipe_ok', getUserId(c), { backupsRemoved: backupKeys.length })
  await Promise.all(
    backupKeys.map((key) =>
      deleteFromR2(c.env.FILES, key).catch((error: unknown) => {
        // Best effort: the rows are already gone, so a leftover object only costs storage. Log it
        // instead of failing the wipe the user asked for.
        console.warn('password: backup object not deleted', key, error)
      }),
    ),
  )
  return c.json({ ok: true })
})

// ---------------------------------------------------------------- Groups
toolsPasswordRoutes.get('/groups', async (c) => {
  const store = getStore(c)
  const groups = await store.getGroups()
  return c.json({ ok: true, data: groups })
})

toolsPasswordRoutes.post('/groups', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, CreateGroupSchema)
  const group = await store.createGroup(body)
  return c.json({ ok: true, data: group })
})

toolsPasswordRoutes.put('/groups/:id', async (c) => {
  const store = getStore(c)
  const id = c.req.param('id')
  const body = await parseBody(c, UpdateGroupSchema)
  const group = await store.updateGroup(id, body)
  return c.json({ ok: true, data: group })
})

toolsPasswordRoutes.delete('/groups/:id', async (c) => {
  const store = getStore(c)
  const id = c.req.param('id')
  await store.deleteGroup(id)
  return c.json({ ok: true })
})

// ---------------------------------------------------------------- Accounts
// Static action paths registered before `/:id` to prevent route conflicts
toolsPasswordRoutes.get('/accounts', async (c) => {
  const store = getStore(c)
  const groupId = c.req.query('groupId')
  const accounts = await store.getAccounts(groupId)
  return c.json({ ok: true, data: accounts })
})

toolsPasswordRoutes.post('/accounts/batch-delete', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, BatchDeleteAccountsSchema)
  await store.batchDeleteAccounts(body.accountIds)
  return c.json({ ok: true })
})

toolsPasswordRoutes.post('/accounts/batch-move', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, BatchMoveAccountsSchema)
  await store.batchMoveAccounts(body.accountIds, body.targetGroupId)
  return c.json({ ok: true })
})

toolsPasswordRoutes.put('/accounts/reorder', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, ReorderAccountsSchema)
  await store.reorderAccounts(body.accounts)
  return c.json({ ok: true })
})

toolsPasswordRoutes.post('/accounts/import', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, BatchImportAccountsSchema)
  const accounts = await store.batchImportAccounts(body.groupId, body.accounts)
  return c.json({ ok: true, data: accounts })
})

toolsPasswordRoutes.post('/accounts', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, CreateAccountSchema)
  const account = await store.createAccount(body)
  return c.json({ ok: true, data: account })
})

toolsPasswordRoutes.put('/accounts/:id', async (c) => {
  const store = getStore(c)
  const id = c.req.param('id')
  const body = await parseBody(c, UpdateAccountSchema)
  const account = await store.updateAccount(id, body)
  return c.json({ ok: true, data: account })
})

toolsPasswordRoutes.delete('/accounts/:id', async (c) => {
  const store = getStore(c)
  const id = c.req.param('id')
  await store.deleteAccount(id)
  return c.json({ ok: true })
})

// ---------------------------------------------------------------- Favicon
toolsPasswordRoutes.get('/favicon', async (c) => {
  const domain = parseFaviconDomain(c.req.query('domain') ?? '')
  if (!domain) {
    throw ApiError.badRequest('Invalid favicon domain')
  }
  await spendFaviconBudget(c)

  const icon = await fetchFavicon(domain)
  if (!icon) {
    throw ApiError.notFound('No favicon available')
  }

  return new Response(icon.bytes, {
    headers: {
      'content-type': icon.contentType,
      // Behind auth, so a shared cache must not keep it; the browser may.
      'cache-control': 'private, max-age=604800',
      'x-content-type-options': 'nosniff',
    },
  })
})

// ---------------------------------------------------------------- Settings
toolsPasswordRoutes.get('/settings', async (c) => {
  const store = getStore(c)
  const settings = await store.getSettings()
  return c.json({ ok: true, data: settings })
})

toolsPasswordRoutes.put('/settings', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, SaveSettingsSchema)
  const settings = await store.saveSettings(body)
  return c.json({ ok: true, data: settings })
})

// ---------------------------------------------------------------- Backups
toolsPasswordRoutes.get('/backups', async (c) => {
  const store = getStore(c)
  const backups = await store.getBackups()
  return c.json({ ok: true, data: backups })
})

toolsPasswordRoutes.post('/backups', async (c) => {
  const store = getStore(c)
  const userId = getUserId(c)
  await spendBackupBudget(c, 'create')
  // An absent body means "back up everything"; a body that cannot be read is refused instead of
  // defaulted, because defaulting one turned a broken request into a full backup nobody asked for.
  const text = await c.req.text()
  if (text.length > MAX_BACKUP_BYTES) {
    throw new ApiError(413, 'payload_too_large', 'Backup body is too large')
  }
  let body: {
    type?: 'auto' | 'manual'
    filename?: string
    data?: PasswordBackupData
  } = {}
  if (text.trim() !== '') {
    let raw: unknown
    try {
      raw = JSON.parse(text) as unknown
    } catch {
      throw ApiError.badRequest('Invalid JSON body')
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw ApiError.badRequest('Invalid JSON body')
    }
    body = raw as typeof body
  }

  const type = body.type === 'auto' ? 'auto' : 'manual'
  let backupData: PasswordBackupData
  if (body.data && body.data.data) {
    backupData = body.data
  } else {
    const allData = await store.getAllData()
    backupData = {
      _backup_info: {
        type: 'inkstone_password_backup',
        version: '1.0.0',
        createTime: Date.now(),
        platform: 'inkstone',
      },
      data: allData,
    }
  }

  // Stamp which key the snapshot belongs to, so a restore after a password change can say so
  // instead of replacing the vault with rows nobody can decrypt.
  const vault = await store.getVault()
  if (vault?.kdfSalt) backupData._backup_info.kdfSalt = vault.kdfSalt

  const backupId = crypto.randomUUID()
  const filename = body.filename || `password_backup_${Date.now()}.${type}.json`
  const jsonContent = JSON.stringify(backupData)
  const { key, size } = await uploadBackupToR2(c.env.FILES, userId, backupId, jsonContent)

  const record = await store.addBackupRecord({
    id: backupId,
    filename,
    r2Key: key,
    size,
    type,
  })
  audit('backup_created', userId, { id: backupId, type, bytes: size })

  // Snapshots used to accumulate one per click forever; the oldest beyond the retention limit go
  // now, rows and objects together.
  const staleKeys = await store.pruneBackups()
  await Promise.all(
    staleKeys.map((staleKey) =>
      deleteFromR2(c.env.FILES, staleKey).catch((error: unknown) => {
        console.warn('password: pruned backup object not deleted', staleKey, error)
      }),
    ),
  )

  return c.json({ ok: true, data: record })
})

toolsPasswordRoutes.post('/backups/restore-local', async (c) => {
  const store = getStore(c)
  await requireDangerousConfirm(c)
  await spendBackupBudget(c, 'restore')

  const text = await c.req.text()
  if (text.length > MAX_BACKUP_BYTES) {
    throw new ApiError(413, 'payload_too_large', 'Backup body is too large')
  }
  let parsed: PasswordBackupData
  try {
    parsed = JSON.parse(text) as PasswordBackupData
  } catch {
    throw ApiError.badRequest('Invalid backup JSON format')
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !parsed.data ||
    !Array.isArray(parsed.data.groups) ||
    !Array.isArray(parsed.data.accounts)
  ) {
    throw ApiError.badRequest('Invalid backup data structure')
  }
  assertBackupMetadata(parsed)
  const vault = await store.getVault()
  assertBackupMatchesVault(parsed, vault?.kdfSalt ?? '')
  await store.restoreData(parsed.data)
  audit('restore_ok', getUserId(c), {
    source: 'local-file',
    groups: parsed.data.groups.length,
    accounts: parsed.data.accounts.length,
  })
  return c.json({
    ok: true,
    data: {
      groupsCount: parsed.data.groups.length,
      accountsCount: parsed.data.accounts.length,
    },
  })
})

toolsPasswordRoutes.post('/backups/:id/restore', async (c) => {
  const store = getStore(c)
  await requireDangerousConfirm(c)
  await spendBackupBudget(c, 'restore')
  const id = c.req.param('id')
  const record = await store.getBackupRecord(id)
  if (!record) {
    throw ApiError.notFound('Backup record not found')
  }

  const jsonContent = await readBackupFromR2(c.env.FILES, record.r2Key)
  if (!jsonContent) {
    throw ApiError.notFound('Backup file not found in storage')
  }

  let parsed: PasswordBackupData
  try {
    parsed = JSON.parse(jsonContent)
  } catch {
    throw ApiError.badRequest('Invalid backup JSON format')
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !parsed.data ||
    !Array.isArray(parsed.data.groups) ||
    !Array.isArray(parsed.data.accounts)
  ) {
    throw ApiError.badRequest('Invalid backup data structure')
  }

  assertBackupMetadata(parsed)
  const vault = await store.getVault()
  assertBackupMatchesVault(parsed, vault?.kdfSalt ?? '')

  await store.restoreData(parsed.data)
  audit('restore_ok', getUserId(c), {
    source: 'snapshot',
    id,
    groups: parsed.data.groups.length,
    accounts: parsed.data.accounts.length,
  })

  return c.json({
    ok: true,
    data: {
      groupsCount: parsed.data.groups.length,
      accountsCount: parsed.data.accounts.length,
    },
  })
})

toolsPasswordRoutes.delete('/backups/:id', async (c) => {
  const store = getStore(c)
  await requireDangerousConfirm(c)
  const id = c.req.param('id')
  const record = await store.deleteBackupRecord(id)
  if (record) {
    await deleteFromR2(c.env.FILES, record.r2Key).catch(() => {})
  }
  audit('backup_deleted', getUserId(c), { id })
  return c.json({ ok: true })
})

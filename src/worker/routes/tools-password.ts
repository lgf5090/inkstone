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
  SetVerifierCostSchema,
  UnlockVaultSchema,
  UpdateAccountSchema,
  UpdateGroupSchema,
  WipeVaultSchema,
} from '@shared/tools/password/schemas'
import type { PasswordBackupData } from '@shared/tools/password/types'
import {
  DEFAULT_VERIFIER_COST,
  isVerifierTierCost,
  verifierCostFromHash,
} from '@shared/tools/password/types'
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
import { fetchBreachRange } from '../tools/password/breach'

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

/**
 * Runs work after the response has gone out. The platform hands every real request an execution
 * context, but a bare Hono instance in a test does not; there the work still runs rather than
 * turning a successful request into a 500.
 */
function afterResponse(c: Context<AppBindings>, task: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(task)
  } catch {
    void task
  }
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
    await audit(c, 'confirm_rejected', { path: new URL(c.req.url).pathname })
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

/**
 * Breach lookups are cheap for us but not for HIBP, and one account walking a 10,000-row vault would
 * send one request per distinct prefix. The key deliberately holds only the account id; the prefix is
 * never part of anything written down.
 */
async function spendBreachBudget(c: Context<AppBindings>): Promise<void> {
  const key = `password-hibp:${getUserId(c)}`
  await assertAttemptBudget(
    () =>
      consumeAttemptBudget(c.env.DB, [
        { key, maxAttempts: 60, windowMs: UNLOCK_WINDOW_MS, lockMs: UNLOCK_WINDOW_MS },
      ]),
    'Too many breach lookups',
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
 * Records one sensitive operation twice: a structured console line for the deployment log and a row
 * the reader can query from the UI. Only ids, counts and outcomes — never a password, a secret or a
 * ciphertext body. A failed insert must not fail the operation it describes, so it is best effort.
 */
async function audit(
  c: Context<AppBindings>,
  action: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  const userId = getUserId(c)
  console.log(JSON.stringify({ scope: 'password-audit', action, userId, at: Date.now(), ...detail }))
  try {
    await getStore(c).recordAudit(action, detail)
  } catch (error) {
    console.warn('password: audit row not written', action, error)
  }
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
  const verifyStarted = performance.now()
  const verified = verifyMasterHash(body.password, vault.masterHash)
  const verifyMs = Number((performance.now() - verifyStarted).toFixed(1))
  if (!verified) {
    await audit(c, 'unlock_failed')
    throw wrongMasterPassword()
  }
  await clearLoginFailures(c.env.DB, [budgetKey])
  await audit(c, 'unlock_ok')

  // The cost in the digest is what the reader chose last time but may not be what it says now: a
  // switch that ran out of CPU leaves a target the row has not reached yet. This records how long the
  // verify actually took on this deployment and, when the two disagree, rehashes toward the target
  // after the response. Verification itself never depends on the target, so an unfinished switch
  // can never lock anybody out.
  const storedCost = verifierCostFromHash(vault.masterHash) ?? DEFAULT_VERIFIER_COST
  const maintenance = (async () => {
    await store.recordVerifierSample(storedCost, verifyMs)
    const settings = await store.getSettings()
    if (settings.verifierCost === storedCost) return
    try {
      const measuredMs = await store.retargetVerifier(body.password, settings.verifierCost, vault.masterHash)
      await audit(c, 'verifier_retargeted', {
        from: storedCost,
        to: settings.verifierCost,
        measuredMs,
        mode: 'on-unlock',
      })
    } catch (error) {
      const current = await store.getVault()
      const actualCost = current
        ? (verifierCostFromHash(current.masterHash) ?? storedCost)
        : storedCost
      await store.setVerifierTarget(actualCost)
      await audit(c, 'verifier_retarget_failed', {
        from: storedCost,
        to: settings.verifierCost,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  })()
  afterResponse(c, maintenance)

  // An empty salt means the vault predates the salted derivation; the client re-seals it now that
  // it has the password in hand.
  return c.json({ ok: true, data: { ok: true, salt: vault.kdfSalt, verifierMs: verifyMs } })
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
    await audit(c, 'reauth_failed')
    throw wrongMasterPassword()
  }
  await clearLoginFailures(c.env.DB, [budgetKey])
  await audit(c, 'reauth_ok')

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
    await audit(c, 'reset_failed')
    throw wrongMasterPassword()
  }
  await clearLoginFailures(c.env.DB, [budgetKey])
  await store.resetMasterPassword(body.newMasterHash, body.newKdfSalt, body.accounts)
  await audit(c, 'reset_ok', { accounts: body.accounts.length })
  return c.json({ ok: true })
})

toolsPasswordRoutes.post('/vault/wipe', async (c) => {
  const store = getStore(c)
  await parseBody(c, WipeVaultSchema)
  await requireDangerousConfirm(c)
  const backupKeys = await store.wipeVault()
  await audit(c, 'wipe_ok', { backupsRemoved: backupKeys.length })
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

// ---------------------------------------------------------------- Audit
toolsPasswordRoutes.get('/audit', async (c) => {
  const store = getStore(c)
  const requested = Number(c.req.query('limit') ?? '30')
  const entries = await store.listAudit(Number.isFinite(requested) ? requested : 30)
  return c.json({ ok: true, data: entries })
})

// ---------------------------------------------------------------- Groups
toolsPasswordRoutes.get('/groups', async (c) => {
  const store = getStore(c)
  const [groups, counts] = await Promise.all([
    store.getGroups(),
    store.getGroupAccountCounts(),
  ])
  return c.json({
    ok: true,
    data: groups.map((group) => ({ ...group, accountCount: counts[group.id] ?? 0 })),
  })
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
  const limitRaw = c.req.query('limit')
  // No `limit` keeps the old shape: every row, which the reset and health paths still ask for.
  if (limitRaw === undefined) {
    const accounts = await store.getAccounts(groupId)
    return c.json({ ok: true, data: accounts })
  }

  const limit = Number(limitRaw)
  if (!Number.isFinite(limit) || limit < 1) {
    throw ApiError.badRequest('A page limit must be a positive number')
  }
  const page = await store.getAccountsPage({ limit, cursor: c.req.query('cursor'), groupId })
  return c.json({ ok: true, data: page })
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

// ---------------------------------------------------------------- Breach check
toolsPasswordRoutes.get('/breach', async (c) => {
  const prefix = (c.req.query('prefix') ?? '').trim().toUpperCase()
  if (!/^[0-9A-F]{5}$/.test(prefix)) {
    throw ApiError.badRequest('A breach lookup takes five hex characters')
  }
  await spendBreachBudget(c)

  const entries = await fetchBreachRange(prefix)
  if (!entries) {
    // The health view treats this as "unknown, try later" and never blocks saving.
    throw new ApiError(503, 'hibp_unavailable', 'The breach database could not be reached')
  }
  // No log line and no audit row: recording the prefix would narrow down the passwords behind it.
  return c.json({ ok: true, data: entries })
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

/**
 * Moves the verifier to another bcrypt cost. The reader chooses the tier; the server does the work,
 * so the digest is always a hash of the password it has just checked.
 *
 * A cheaper tier is milliseconds of CPU and lands before the response. A stronger one costs seconds
 * and runs after it: the row keeps verifying with the old digest until the new one is swapped in by
 * compare-and-swap, and a failed attempt puts the target back to what is actually stored.
 */
toolsPasswordRoutes.post('/settings/verifier', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, SetVerifierCostSchema)
  if (!isVerifierTierCost(body.cost)) {
    throw ApiError.badRequest(`Unknown verifier cost tier: ${body.cost}`)
  }
  const vault = await store.getVault()
  if (!vault) {
    throw ApiError.badRequest('Vault is not initialized')
  }

  const budgetKey = await spendUnlockBudget(c)
  if (!verifyMasterHash(body.password, vault.masterHash)) {
    await audit(c, 'verifier_switch_failed', { target: body.cost })
    throw wrongMasterPassword()
  }
  await clearLoginFailures(c.env.DB, [budgetKey])

  const storedCost = verifierCostFromHash(vault.masterHash) ?? DEFAULT_VERIFIER_COST
  await store.setVerifierTarget(body.cost)
  await audit(c, 'verifier_target_changed', { from: storedCost, to: body.cost })
  const measuredMs = (await store.getSettings()).verifierSamples[String(storedCost)] ?? 0

  if (body.cost === storedCost) {
    return c.json({
      ok: true,
      data: { applied: 'unchanged', storedCost, targetCost: body.cost, measuredMs },
    })
  }

  if (body.cost < storedCost) {
    const immediateMs = await store.retargetVerifier(body.password, body.cost, vault.masterHash)
    await audit(c, 'verifier_retargeted', {
      from: storedCost,
      to: body.cost,
      measuredMs: immediateMs,
      mode: 'immediate',
    })
    return c.json({
      ok: true,
      data: { applied: 'immediate', storedCost: body.cost, targetCost: body.cost, measuredMs: immediateMs },
    })
  }

  const upgrade = store
    .retargetVerifier(body.password, body.cost, vault.masterHash)
    .then(async (upgradeMs) => {
      await audit(c, 'verifier_retargeted', {
        from: storedCost,
        to: body.cost,
        measuredMs: upgradeMs,
        mode: 'deferred',
      })
    })
    .catch(async (error: unknown) => {
      const current = await store.getVault()
      const actualCost = current
        ? (verifierCostFromHash(current.masterHash) ?? storedCost)
        : storedCost
      await store.setVerifierTarget(actualCost)
      await audit(c, 'verifier_retarget_failed', {
        from: storedCost,
        to: body.cost,
        reason: error instanceof Error ? error.message : String(error),
      })
    })
  afterResponse(c, upgrade)

  return c.json({
    ok: true,
    data: { applied: 'deferred', storedCost, targetCost: body.cost, measuredMs },
  })
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
  await audit(c, 'backup_created', { id: backupId, type, bytes: size })

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
  await audit(c, 'restore_ok', {
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
  await audit(c, 'restore_ok', {
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
  await audit(c, 'backup_deleted', { id })
  return c.json({ ok: true })
})

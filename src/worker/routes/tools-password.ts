/**
 * Password Manager API routes (`/api/tools/password/*`).
 */

import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { createClient } from 'webdav'
import {
  BatchDeleteAccountsSchema,
  BatchImportAccountsSchema,
  BatchMoveAccountsSchema,
  CreateAccountSchema,
  CreateGroupSchema,
  InitVaultSchema,
  ReorderAccountsSchema,
  ReorderGroupsSchema,
  ResetMasterPasswordSchema,
  SaveSettingsSchema,
  TestWebdavSchema,
  UpdateAccountSchema,
  UpdateGroupSchema,
} from '@shared/tools/password/schemas'
import type { PasswordBackupData } from '@shared/tools/password/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import {
  deleteFromR2,
  getExportCsvR2Key,
  getExportTxtR2Key,
  readBackupFromR2,
  readExportFromR2,
  uploadBackupToR2,
  uploadExportToR2,
} from '../tools/password/r2'
import { PasswordStore } from '../tools/password/store'

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

// ---------------------------------------------------------------- Vault
toolsPasswordRoutes.get('/vault', async (c) => {
  const store = getStore(c)
  const state = await store.getVaultState()
  return c.json({ ok: true, data: state })
})

toolsPasswordRoutes.post('/vault/init', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, InitVaultSchema)
  const state = await store.initVault(body.masterHash, body.recoveryHint)
  return c.json({ ok: true, data: state })
})

toolsPasswordRoutes.post('/vault/reset', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, ResetMasterPasswordSchema)
  await store.resetMasterPassword(body.newMasterHash, body.newRecoveryHint, body.accounts)
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

toolsPasswordRoutes.put('/groups/reorder', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, ReorderGroupsSchema)
  await store.reorderGroups(body.groups)
  return c.json({ ok: true })
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

toolsPasswordRoutes.post('/settings/webdav-test', async (c) => {
  const body = await parseBody(c, TestWebdavSchema)
  try {
    const client = createClient(body.url, {
      username: body.username,
      password: body.password,
    })
    await client.getDirectoryContents('/')
    return c.json({ ok: true, message: 'WebDAV connection successful' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ ok: false, message }, 400)
  }
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
  // An absent body means "back up everything"; a body that cannot be read is refused instead of
  // defaulted, because defaulting one turned a broken request into a full backup nobody asked for.
  const text = await c.req.text()
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

  return c.json({ ok: true, data: record })
})

toolsPasswordRoutes.post('/backups/:id/restore', async (c) => {
  const store = getStore(c)
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

  await store.restoreData(parsed.data)

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
  const id = c.req.param('id')
  const record = await store.deleteBackupRecord(id)
  if (record) {
    await deleteFromR2(c.env.FILES, record.r2Key).catch(() => {})
  }
  return c.json({ ok: true })
})

// ---------------------------------------------------------------- Export
const ExportSchema = z.object({
  type: z.enum(['txt', 'csv']),
  content: z.string(),
  filename: z.string().optional(),
})

toolsPasswordRoutes.post('/export', async (c) => {
  const userId = getUserId(c)
  const body = await parseBody(c, ExportSchema)
  const fileId = crypto.randomUUID()
  const { key, size } = await uploadExportToR2(
    c.env.FILES,
    userId,
    fileId,
    body.type,
    body.content,
  )

  return c.json({
    ok: true,
    data: {
      fileId,
      key,
      size,
      type: body.type,
      filename: body.filename || `passwords_export_${Date.now()}.${body.type}`,
    },
  })
})

toolsPasswordRoutes.get('/export/:type/:fileId', async (c) => {
  const userId = getUserId(c)
  const type = c.req.param('type')
  const fileId = c.req.param('fileId')
  if (type !== 'txt' && type !== 'csv') {
    throw ApiError.badRequest('Invalid export type')
  }
  const key = type === 'txt' ? getExportTxtR2Key(userId, fileId) : getExportCsvR2Key(userId, fileId)
  const content = await readExportFromR2(c.env.FILES, key)
  if (!content) {
    throw ApiError.notFound('Export file not found')
  }
  return new Response(content, {
    headers: {
      'content-type': type === 'txt' ? 'text/plain; charset=utf-8' : 'text/csv; charset=utf-8',
    },
  })
})

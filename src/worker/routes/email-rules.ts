import { Hono, type Context } from 'hono'
import {
  EMAIL_FILTER_MAX_RULES,
  isBlockableSenderAddress,
  normalizeEmailSenderAddress,
  parseEmailFilterInput,
  parseEmailFilterPatch,
  type EmailBlockedSender,
  type EmailBlockSenderResult,
  type EmailFilter,
  type EmailFilterAction,
} from '@shared/email/rules'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth, requireOwner } from '../middleware/auth'
import { getEmailAccount } from '../email/account-store'
import type { EmailFilterRecord, FolderRow } from '../email/mailbox-store'
import { emailMailbox } from '../email/mailbox-stub'

type Ctx = Context<AppBindings>

export const emailRulesRoutes = new Hono<AppBindings>()

emailRulesRoutes.use('*', requireAuth)
emailRulesRoutes.use('*', requireOwner)

function mailboxNotFound(): ApiError {
  return new ApiError(404, 'email_account_not_found', 'Mailbox not found')
}

function filterNotFound(): ApiError {
  return new ApiError(404, 'not_found', 'Filter not found')
}

function folderNotFound(): ApiError {
  return new ApiError(404, 'email_folder_not_found', 'Folder not found')
}

function messageNotFound(): ApiError {
  return new ApiError(404, 'email_message_not_found', 'Email not found')
}

async function requireAccount(c: Ctx, id: string) {
  if (!isValidId(id)) throw mailboxNotFound()
  const account = await getEmailAccount(c.env.DB, c.get('userId'), id)
  if (!account) throw mailboxNotFound()
  return account
}

function matchFolder(folders: readonly FolderRow[], value: string): FolderRow | null {
  const wanted = value.trim()
  if (!wanted) return null
  const byId = folders.find((folder) => folder.id === wanted)
  if (byId) return byId
  const named = folders.filter((folder) => folder.name.toLowerCase() === wanted.toLowerCase())
  return named.length === 1 ? named[0]! : null
}

function resolveFilterActions(
  actions: readonly EmailFilterAction[],
  folders: readonly FolderRow[],
): EmailFilterAction[] {
  return actions.map((action) => {
    if (action.type !== 'moveTo') return action
    const folder = matchFolder(folders, action.folder)
    if (!folder) throw folderNotFound()
    return { type: 'moveTo', folder: folder.id }
  })
}

function toFilter(record: EmailFilterRecord): EmailFilter {
  return {
    id: record.id,
    name: record.name,
    enabled: record.enabled,
    sortOrder: record.sortOrder,
    conditions: record.conditions,
    actions: record.actions,
    createdAt: new Date(record.createdAt).toISOString(),
  }
}

function toBlockedSender(address: string, createdAt: number): EmailBlockedSender {
  return { address, createdAt: new Date(createdAt).toISOString() }
}

emailRulesRoutes.get('/accounts/:id/filters', async (c) => {
  const account = await requireAccount(c, c.req.param('id') ?? '')
  const filters = await emailMailbox(c.env, account.id).listFilters()
  return c.json(filters.map(toFilter))
})

emailRulesRoutes.post('/accounts/:id/filters', async (c) => {
  const account = await requireAccount(c, c.req.param('id') ?? '')
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const input = parseEmailFilterInput(body)
  if (!input) throw ApiError.badRequest('The filter is not valid')
  const mailbox = emailMailbox(c.env, account.id)
  const folders = await mailbox.getFolders()
  const filter = await mailbox.createFilter({
    ...input,
    actions: resolveFilterActions(input.actions, folders),
  })
  if (!filter) throw new ApiError(409, 'conflict', `At most ${EMAIL_FILTER_MAX_RULES} filters are allowed`)
  return c.json(toFilter(filter), 201)
})

emailRulesRoutes.patch('/accounts/:id/filters/:filterId', async (c) => {
  const account = await requireAccount(c, c.req.param('id') ?? '')
  const filterId = c.req.param('filterId') ?? ''
  if (!isValidId(filterId)) throw filterNotFound()
  const mailbox = emailMailbox(c.env, account.id)
  if (!(await mailbox.getFilter(filterId))) throw filterNotFound()
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const patch = parseEmailFilterPatch(body)
  if (!patch) throw ApiError.badRequest('The filter is not valid')
  let actions = patch.actions
  if (actions) {
    const folders = await mailbox.getFolders()
    actions = resolveFilterActions(actions, folders)
  }
  const updated = await mailbox.updateFilter(filterId, { ...patch, ...(actions ? { actions } : {}) })
  if (!updated) throw filterNotFound()
  return c.json(toFilter(updated))
})

emailRulesRoutes.delete('/accounts/:id/filters/:filterId', async (c) => {
  const account = await requireAccount(c, c.req.param('id') ?? '')
  const filterId = c.req.param('filterId') ?? ''
  if (!isValidId(filterId)) throw filterNotFound()
  if (!(await emailMailbox(c.env, account.id).deleteFilter(filterId))) throw filterNotFound()
  return c.body(null, 204)
})

emailRulesRoutes.get('/accounts/:id/blocklist', async (c) => {
  const account = await requireAccount(c, c.req.param('id') ?? '')
  const rows = await emailMailbox(c.env, account.id).listBlockedSenders()
  return c.json(rows.map((row) => toBlockedSender(row.email_normalized, Number(row.created_at))))
})

emailRulesRoutes.post('/accounts/:id/blocklist', async (c) => {
  const account = await requireAccount(c, c.req.param('id') ?? '')
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  if (typeof body.address !== 'string') throw ApiError.badRequest('A sender address is required')
  const address = normalizeEmailSenderAddress(body.address)
  if (!isBlockableSenderAddress(address)) throw ApiError.badRequest('The sender address is not valid')
  const row = await emailMailbox(c.env, account.id).addBlockedSender(address)
  if (!row) throw ApiError.badRequest('The sender address is not valid')
  return c.json(toBlockedSender(row.email_normalized, Number(row.created_at)), 201)
})

emailRulesRoutes.delete('/accounts/:id/blocklist/:address', async (c) => {
  const account = await requireAccount(c, c.req.param('id') ?? '')
  const address = normalizeEmailSenderAddress(c.req.param('address') ?? '')
  if (!address) throw ApiError.badRequest('The sender address is not valid')
  if (!(await emailMailbox(c.env, account.id).removeBlockedSender(address))) {
    throw new ApiError(404, 'not_found', 'Blocked sender not found')
  }
  return c.body(null, 204)
})

emailRulesRoutes.post('/accounts/:id/emails/:messageId/block-sender', async (c) => {
  const account = await requireAccount(c, c.req.param('id') ?? '')
  const messageId = c.req.param('messageId') ?? ''
  if (!isValidId(messageId)) throw messageNotFound()
  const mailbox = emailMailbox(c.env, account.id)
  const message = await mailbox.getEmail(messageId)
  if (!message) throw messageNotFound()
  const address = normalizeEmailSenderAddress(message.sender)
  if (!isBlockableSenderAddress(address)) throw ApiError.badRequest('The sender address is not valid')
  if (!(await mailbox.addBlockedSender(address))) throw ApiError.badRequest('The sender address is not valid')
  if (!(await mailbox.moveEmail(messageId, 'spam'))) throw messageNotFound()
  const result: EmailBlockSenderResult = { address, messageId, folderId: 'spam' }
  return c.json(result)
})

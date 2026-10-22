import { Hono, type Context } from 'hono'
import { LIMITS } from '@shared/constants'
import { isValidEmailAddress } from '@shared/email/format'
import {
  EMAIL_ACCOUNT_SETTINGS_MAX_BYTES,
  EMAIL_BODY_MAX_BYTES,
  EMAIL_FOLDER_SEED_NAMES,
  EMAIL_MAX_PAGE_SIZE,
  EMAIL_PAGE_SIZE,
  EMAIL_SUBJECT_MAX_CHARS,
  EMAIL_SYSTEM_FOLDERS,
} from '@shared/email/model'
import type {
  EmailAccountSettings,
  EmailAttachment,
  EmailConfig,
  EmailFolder,
  EmailListResponse,
  EmailMessage,
  EmailSummary,
} from '@shared/email/model'
import { utf8ByteLength } from '@shared/text-utils'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { isInlineSafe } from '../lib/image'
import { clampInt, JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth, requireOwner } from '../middleware/auth'
import {
  createEmailAccount,
  deleteEmailAccount,
  deleteEmailAttachmentsForAccount,
  findEmailAccountByAddress,
  getEmailAccount,
  listEmailAccounts,
  listEmailAttachmentKeys,
  toEmailAccount,
  updateEmailAccount,
} from '../email/account-store'
import {
  countEmailAttachments,
  deleteEmailAttachmentObject,
  deleteEmailAttachmentObjects,
  deleteEmailAttachmentsForMessages,
  getEmailAttachmentFileRow,
  getEmailAttachmentRow,
  linkEmailAttachment,
  loadEmailAttachments,
  unlinkEmailAttachment,
} from '../email/attachments'
import type { EmailRow, FolderRow } from '../email/mailbox-store'
import { emailMailbox } from '../email/mailbox-stub'

type Ctx = Context<AppBindings>
type Mailbox = ReturnType<typeof emailMailbox>
type SummaryRow = EmailRow & {
  snippet?: string | null
  folder_name?: string | null
  thread_count?: number | null
  thread_unread_count?: number | null
  participants?: string | null
  needs_reply?: number | null
  has_draft?: number | null
}

const LOCAL_PART_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}$/i
const MAX_PAGE = 1_000_000
const RESERVED_FOLDER_NAMES = new Set<string>([
  ...EMAIL_SYSTEM_FOLDERS,
  ...Object.values(EMAIL_FOLDER_SEED_NAMES).map((name) => name.toLowerCase()),
])

function allowedDomains(env: AppBindings['Bindings']): string[] {
  const raw = (env.EMAIL_DOMAINS ?? env.MAIL_DOMAIN ?? '').trim()
  if (!raw) return []
  return raw.split(',').map((domain) => domain.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean)
}

function configuredAddresses(env: AppBindings['Bindings']): string[] {
  return (env.EMAIL_ADDRESSES ?? '')
    .split(',')
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean)
}

function validateLocalPart(localPart: string): string {
  const value = localPart.trim().toLowerCase()
  if (!value || !LOCAL_PART_RE.test(value) || value.startsWith('.') || value.endsWith('.') || value.includes('..')) {
    throw new ApiError(400, 'email_address_invalid', 'The mailbox local part is not valid')
  }
  if (value.startsWith('u+')) throw new ApiError(400, 'email_address_reserved', 'The u+ prefix is reserved')
  return value
}

function buildAddress(localPart: string, domain: string, env: AppBindings['Bindings']): string {
  const allowed = allowedDomains(env)
  const wantedDomain = domain.trim().toLowerCase().replace(/\.$/, '')
  if (!wantedDomain || !allowed.includes(wantedDomain)) {
    throw new ApiError(400, 'email_domain_not_allowed', 'The mailbox domain is not configured')
  }
  const address = `${validateLocalPart(localPart)}@${wantedDomain}`
  const allowlist = configuredAddresses(env)
  if (allowlist.length && !allowlist.includes(address)) {
    throw new ApiError(403, 'email_forbidden', 'This address is not in EMAIL_ADDRESSES')
  }
  if (!isValidEmailAddress(address)) throw new ApiError(400, 'email_address_invalid', 'The mailbox address is not valid')
  return address
}

function settingsFrom(value: unknown): EmailAccountSettings {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'email_settings_invalid', 'The mailbox settings are not an object')
  }
  const raw = value as Record<string, unknown>
  const settings: EmailAccountSettings = {}
  if (raw.signature !== undefined) {
    if (!raw.signature || typeof raw.signature !== 'object') throw new ApiError(400, 'email_settings_invalid', 'The signature is not valid')
    const signature = raw.signature as Record<string, unknown>
    if (typeof signature.enabled !== 'boolean' || typeof signature.text !== 'string') {
      throw new ApiError(400, 'email_settings_invalid', 'The signature is not valid')
    }
    settings.signature = { enabled: signature.enabled, text: signature.text.slice(0, 4000) }
  }
  if (raw.agentSystemPrompt !== undefined) {
    if (typeof raw.agentSystemPrompt !== 'string') throw new ApiError(400, 'email_settings_invalid', 'The agent prompt is not valid')
    const prompt = raw.agentSystemPrompt.trim()
    if (prompt) settings.agentSystemPrompt = prompt.slice(0, 8000)
  }
  if (raw.autoDraft !== undefined) {
    if (typeof raw.autoDraft !== 'boolean') throw new ApiError(400, 'email_settings_invalid', 'The auto-draft setting is not valid')
    settings.autoDraft = raw.autoDraft
  }
  const encoded = JSON.stringify(settings)
  if (encoded.length > EMAIL_ACCOUNT_SETTINGS_MAX_BYTES) throw new ApiError(400, 'email_settings_invalid', 'The mailbox settings are too large')
  return settings
}

function mailboxNotFound(): ApiError {
  return new ApiError(404, 'email_account_not_found', 'Mailbox not found')
}

async function requireAccount(c: Ctx, id: string) {
  if (!isValidId(id)) throw mailboxNotFound()
  const account = await getEmailAccount(c.env.DB, c.get('userId'), id)
  if (!account) throw mailboxNotFound()
  return account
}

function messageNotFound(): ApiError {
  return new ApiError(404, 'email_message_not_found', 'Email not found')
}

function folderNotFound(): ApiError {
  return new ApiError(404, 'email_folder_not_found', 'Folder not found')
}

function attachmentNotFound(): ApiError {
  return new ApiError(404, 'email_attachment_not_found', 'Attachment not found')
}

function draftInvalid(message: string): ApiError {
  return new ApiError(400, 'email_draft_invalid', message)
}

function messageIdParam(value: string): string {
  if (!isValidId(value)) throw messageNotFound()
  return value
}

function attachmentIdParam(value: string): string {
  if (!isValidId(value)) throw attachmentNotFound()
  return value
}

function pageParams(c: Ctx): { page: number; limit: number } {
  return {
    page: clampInt(c.req.query('page'), 1, MAX_PAGE, 1),
    limit: clampInt(c.req.query('limit'), 1, EMAIL_MAX_PAGE_SIZE, EMAIL_PAGE_SIZE),
  }
}

function booleanQuery(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined || value === '') return undefined
  const normalized = value.toLowerCase()
  if (normalized === 'true' || normalized === '1') return true
  if (normalized === 'false' || normalized === '0') return false
  throw ApiError.badRequest(`The ${name} filter must be true or false`)
}

function dateQuery(value: string | undefined, name: string): number | undefined {
  if (!value) return undefined
  const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw ApiError.badRequest(`The ${name} filter is not a valid date`)
  return parsed
}

function readFolderName(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('A folder name is required')
  const name = value.trim()
  if (!name) throw ApiError.badRequest('A folder name is required')
  if (name.length > LIMITS.folderNameMaxLength) throw ApiError.badRequest('The folder name is too long')
  if (RESERVED_FOLDER_NAMES.has(name.toLowerCase())) {
    throw new ApiError(400, 'email_folder_reserved', 'That folder name is reserved')
  }
  return name
}

function toFolder(row: FolderRow): EmailFolder {
  return {
    id: row.id,
    name: row.name,
    isDeletable: Boolean(row.is_deletable),
    unreadCount: Number(row.unread_count ?? 0),
  }
}

function toSummary(row: SummaryRow): EmailSummary {
  return {
    id: row.id,
    folderId: row.folder_id,
    subject: row.subject,
    sender: row.sender,
    recipient: row.recipient,
    cc: row.cc ?? null,
    bcc: row.bcc ?? null,
    date: new Date(row.date).toISOString(),
    read: Boolean(row.read),
    starred: Boolean(row.starred),
    threadId: row.thread_id ?? null,
    hasAttachment: Boolean(row.has_attachment),
    snippet: row.snippet ?? null,
    deliveryStatus: row.delivery_status as EmailSummary['deliveryStatus'],
    ...(row.thread_count != null ? { threadCount: Number(row.thread_count) } : {}),
    ...(row.thread_unread_count != null ? { threadUnreadCount: Number(row.thread_unread_count) } : {}),
    ...(row.participants ? { participants: row.participants } : {}),
    ...(row.needs_reply != null ? { needsReply: Boolean(row.needs_reply) } : {}),
    ...(row.has_draft != null ? { hasDraft: Boolean(row.has_draft) } : {}),
  }
}

function parseHeaders(raw: string | null): { key: string; value: string }[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const row = entry as Record<string, unknown>
      const key = typeof row.key === 'string' ? row.key : typeof row.name === 'string' ? row.name : ''
      return key ? [{ key, value: String(row.value ?? '') }] : []
    })
  } catch (error) {
    console.warn('[inkstone] Email headers could not be parsed:', (error as Error).message)
    return []
  }
}

function parseReferences(raw: string | null): string[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  } catch (error) {
    console.warn('[inkstone] Email references could not be parsed:', (error as Error).message)
    return []
  }
}

function toMessage(row: EmailRow, attachments: EmailAttachment[]): EmailMessage {
  const snippet = (row as SummaryRow).snippet ?? null
  return {
    ...toSummary(row),
    body: row.body,
    bodySource: row.body_source,
    inReplyTo: row.in_reply_to,
    references: parseReferences(row.email_references),
    messageId: row.message_id,
    rawHeaders: parseHeaders(row.raw_headers),
    attachments,
    deliveryError: row.delivery_error,
    attachmentsSkipped: Boolean(row.attachments_skipped),
    deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : new Date(row.deleted_at).toISOString(),
    snippet: snippet ?? row.body.slice(0, 300),
  }
}

async function resolveFolder(mailbox: Mailbox, value: string): Promise<FolderRow> {
  const wanted = value.trim()
  const folders = await mailbox.getFolders()
  const match = folders.find((folder) => folder.id === wanted) ??
    folders.find((folder) => folder.name.toLowerCase() === wanted.toLowerCase())
  if (!match) throw folderNotFound()
  return match
}

async function messageAttachments(env: AppBindings['Bindings'], userId: string, row: EmailRow): Promise<EmailAttachment[]> {
  return (await loadEmailAttachments(env.DB, userId, [row.id])).get(row.id) ?? []
}

function encodeContentDispositionFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function attachmentETag(object: R2Object): string {
  const sha = object.customMetadata?.sha256
  return sha ? `"${sha}"` : object.httpEtag
}

function matchesETag(header: string, tag: string): boolean {
  const target = tag.replace(/^W\//i, '').replace(/^"|"$/g, '')
  return header.split(',').some((item) => {
    const trimmed = item.trim().replace(/^W\//i, '').replace(/^"|"$/g, '')
    return trimmed === '*' || trimmed === target
  })
}

function parseByteRange(header: string, size: number): { start: number; end: number } | 'invalid' {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || size <= 0) return 'invalid'
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (!rawStart && !rawEnd) return 'invalid'
  let start: number
  let end: number
  if (!rawStart) {
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd ? Number(rawEnd) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'invalid'
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

export const emailRoutes = new Hono<AppBindings>()

emailRoutes.use('*', requireAuth)
emailRoutes.use('*', requireOwner)

emailRoutes.get('/config', (c) => {
  const config: EmailConfig = {
    domains: allowedDomains(c.env),
    addresses: configuredAddresses(c.env),
    attachmentsAvailable: Boolean(c.env.FILES) && Boolean(c.env.EMAIL_MAILBOX),
    sendingAvailable: Boolean(c.env.EMAIL),
    autoDraftAvailable: Boolean(c.env.EMAIL_MAILBOX),
    canCreate: true,
  }
  return c.json(config)
})

emailRoutes.get('/accounts', async (c) => {
  const rows = await listEmailAccounts(c.env.DB, c.get('userId'))
  return c.json(rows.map(toEmailAccount))
})

emailRoutes.post('/accounts', async (c) => {
  const body = await readJson<{ localPart?: unknown; domain?: unknown; displayName?: unknown; settings?: unknown }>(
    c,
    JSON_BODY_LIMITS.settings,
  )
  if (typeof body.localPart !== 'string' || typeof body.domain !== 'string') {
    throw ApiError.badRequest('A local part and a domain are required')
  }
  const address = buildAddress(body.localPart, body.domain, c.env)
  if (await findEmailAccountByAddress(c.env.DB, address)) {
    throw new ApiError(409, 'email_account_exists', 'That address is already in use')
  }
  const settings = settingsFrom(body.settings)
  const row = await createEmailAccount(c.env.DB, {
    userId: c.get('userId'),
    address,
    displayName: typeof body.displayName === 'string' ? body.displayName : address.split('@')[0]!,
    settings: { ...settings, autoDraft: settings.autoDraft ?? true },
  })
  return c.json(toEmailAccount(row), 201)
})

emailRoutes.post('/accounts/ensure', async (c) => {
  const userId = c.get('userId')
  const wanted = configuredAddresses(c.env)
  if (!wanted.length) return c.json([])
  const existing = await listEmailAccounts(c.env.DB, userId)
  const known = new Set(existing.map((row) => row.address_normalized))
  const created = []
  for (const address of wanted) {
    if (known.has(address)) continue
    const [localPart, domain] = address.split('@')
    if (!localPart || !domain) continue
    try {
      const row = await createEmailAccount(c.env.DB, {
        userId,
        address,
        displayName: localPart,
      })
      created.push(toEmailAccount(row))
      known.add(address)
    } catch (error) {
      console.warn('[inkstone] configured mailbox could not be created:', (error as Error).message)
    }
  }
  return c.json(created, 201)
})

emailRoutes.get('/accounts/:id', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  return c.json(toEmailAccount(row))
})

emailRoutes.patch('/accounts/:id', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const body = await readJson<{ displayName?: unknown; settings?: unknown }>(c, JSON_BODY_LIMITS.settings)
  const updated = await updateEmailAccount(c.env.DB, c.get('userId'), row.id, {
    displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
    settings: body.settings === undefined ? undefined : settingsFrom(body.settings),
  })
  if (!updated) throw mailboxNotFound()
  return c.json(toEmailAccount(updated))
})

emailRoutes.delete('/accounts/:id', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const keys = await listEmailAttachmentKeys(c.env.DB, c.get('userId'), row.id)
  const pending = await deleteEmailAttachmentObjects(c.env, c.get('userId'), keys)
  if (pending) console.warn('[inkstone] Email attachment cleanup is pending for a deleted mailbox')
  await deleteEmailAttachmentsForAccount(c.env.DB, c.get('userId'), row.id)
  try {
    await emailMailbox(c.env, row.id).deleteAll()
  } catch (error) {
    console.warn('[inkstone] mailbox object cleanup failed:', (error as Error).message)
  }
  const removed = await deleteEmailAccount(c.env.DB, c.get('userId'), row.id)
  if (!removed) throw mailboxNotFound()
  return c.body(null, 204)
})

emailRoutes.get('/accounts/:id/folders', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const folders = await emailMailbox(c.env, row.id).getFolders()
  return c.json(folders.map(toFolder))
})

emailRoutes.post('/accounts/:id/folders', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const body = await readJson<{ name?: unknown }>(c, JSON_BODY_LIMITS.small)
  const name = readFolderName(body.name)
  const folder = await emailMailbox(c.env, row.id).createFolder(name)
  if (!folder) throw new ApiError(409, 'email_folder_exists', 'A folder with that name already exists')
  return c.json(toFolder(folder), 201)
})

emailRoutes.patch('/accounts/:id/folders/:folderId', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const mailbox = emailMailbox(c.env, row.id)
  const folder = await resolveFolder(mailbox, c.req.param('folderId') ?? '')
  if (!folder.is_deletable) throw new ApiError(400, 'email_folder_reserved', 'System folders cannot be renamed')
  const body = await readJson<{ name?: unknown }>(c, JSON_BODY_LIMITS.small)
  const name = readFolderName(body.name)
  const updated = await mailbox.updateFolder(folder.id, name)
  if (!updated) throw new ApiError(409, 'email_folder_exists', 'A folder with that name already exists')
  return c.json(toFolder(updated))
})

emailRoutes.delete('/accounts/:id/folders/:folderId', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const mailbox = emailMailbox(c.env, row.id)
  const folder = await resolveFolder(mailbox, c.req.param('folderId') ?? '')
  if (!folder.is_deletable) throw new ApiError(400, 'email_folder_not_deletable', 'System folders cannot be deleted')
  const deleteEmails = booleanQuery(c.req.query('deleteEmails'), 'deleteEmails') ?? false
  const result = await mailbox.deleteFolder(folder.id, deleteEmails)
  if (!result) throw folderNotFound()
  if (result.deletedMessageIds.length) {
    const pending = await deleteEmailAttachmentsForMessages(c.env, c.get('userId'), result.deletedMessageIds)
    if (pending) console.warn('[inkstone] Email attachment cleanup is pending for a deleted folder')
  }
  return c.body(null, 204)
})

emailRoutes.get('/accounts/:id/emails', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const mailbox = emailMailbox(c.env, row.id)
  const folderParam = c.req.query('folder')?.trim() ?? ''
  const threadId = c.req.query('thread_id')?.trim() || undefined
  const threaded = booleanQuery(c.req.query('threaded'), 'threaded') ?? false
  let folder: string | undefined
  if (folderParam) folder = (await resolveFolder(mailbox, folderParam)).id
  else if (!threadId) folder = 'inbox'
  const { page, limit } = pageParams(c)
  const sortDirection = (c.req.query('sortDirection') ?? '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
  const options = {
    folder,
    threadId,
    page,
    limit,
    sortColumn: c.req.query('sortColumn'),
    sortDirection,
  } as const
  const grouped = threaded && Boolean(folder) && !threadId
  const rows = grouped ? await mailbox.getThreadedEmails(options) : await mailbox.getEmails(options)
  const totalCount = grouped
    ? await mailbox.countThreadedEmails(folder!)
    : await mailbox.countEmails({ folder, threadId })
  return c.json({ emails: rows.map((entry) => toSummary(entry as unknown as SummaryRow)), totalCount })
})

emailRoutes.get('/accounts/:id/emails/:messageId', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const id = messageIdParam(c.req.param('messageId') ?? '')
  const message = await emailMailbox(c.env, row.id).getEmail(id)
  if (!message) throw messageNotFound()
  return c.json(toMessage(message, await messageAttachments(c.env, c.get('userId'), message)))
})

emailRoutes.patch('/accounts/:id/emails/:messageId', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const id = messageIdParam(c.req.param('messageId') ?? '')
  const body = await readJson<{ read?: unknown; starred?: unknown }>(c, JSON_BODY_LIMITS.small)
  const patch: { read?: boolean; starred?: boolean } = {}
  if (body.read !== undefined) {
    if (typeof body.read !== 'boolean') throw ApiError.badRequest('The read flag must be a boolean')
    patch.read = body.read
  }
  if (body.starred !== undefined) {
    if (typeof body.starred !== 'boolean') throw ApiError.badRequest('The starred flag must be a boolean')
    patch.starred = body.starred
  }
  if (patch.read === undefined && patch.starred === undefined) {
    throw ApiError.badRequest('A read or starred flag is required')
  }
  const message = await emailMailbox(c.env, row.id).updateEmail(id, patch)
  if (!message) throw messageNotFound()
  return c.json(toMessage(message, await messageAttachments(c.env, c.get('userId'), message)))
})

emailRoutes.delete('/accounts/:id/emails/:messageId', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const id = messageIdParam(c.req.param('messageId') ?? '')
  const mailbox = emailMailbox(c.env, row.id)
  const permanent = booleanQuery(c.req.query('permanent'), 'permanent') ?? false
  if (!permanent) {
    if (!(await mailbox.trashEmail(id))) throw messageNotFound()
    return c.body(null, 204)
  }
  if (!(await mailbox.deleteEmail(id))) throw messageNotFound()
  const pending = await deleteEmailAttachmentsForMessages(c.env, c.get('userId'), [id])
  if (pending) console.warn('[inkstone] Email attachment cleanup is pending for a deleted message')
  return c.body(null, 204)
})

emailRoutes.post('/accounts/:id/emails/:messageId/restore', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const id = messageIdParam(c.req.param('messageId') ?? '')
  if (!(await emailMailbox(c.env, row.id).restoreEmail(id))) {
    throw new ApiError(404, 'email_not_in_trash', 'Email is not in the trash')
  }
  return c.body(null, 204)
})

emailRoutes.post('/accounts/:id/emails/:messageId/move', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const id = messageIdParam(c.req.param('messageId') ?? '')
  const body = await readJson<{ folderId?: unknown }>(c, JSON_BODY_LIMITS.small)
  if (typeof body.folderId !== 'string' || !body.folderId.trim()) {
    throw ApiError.badRequest('A target folder is required')
  }
  const mailbox = emailMailbox(c.env, row.id)
  const folder = await resolveFolder(mailbox, body.folderId)
  const moved = folder.id === 'trash' ? (await mailbox.trashEmail(id)) !== null : await mailbox.moveEmail(id, folder.id)
  if (!moved) throw messageNotFound()
  return c.body(null, 204)
})

emailRoutes.get('/accounts/:id/trash', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const mailbox = emailMailbox(c.env, row.id)
  const { page, limit } = pageParams(c)
  const rows = await mailbox.listTrash({ page, limit })
  const totalCount = await mailbox.countTrash()
  return c.json({ emails: rows.map((entry) => toSummary(entry as unknown as SummaryRow)), totalCount })
})

emailRoutes.delete('/accounts/:id/trash', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  if (booleanQuery(c.req.query('confirm'), 'confirm') !== true) {
    throw ApiError.badRequest('Emptying the trash requires confirm=true')
  }
  const ids = await emailMailbox(c.env, row.id).emptyTrash()
  const pending = await deleteEmailAttachmentsForMessages(c.env, c.get('userId'), ids)
  if (pending) console.warn('[inkstone] Email attachment cleanup is pending for an emptied trash')
  return c.body(null, 204)
})

emailRoutes.get('/accounts/:id/threads/:threadId', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const threadId = c.req.param('threadId') ?? ''
  if (!threadId) return c.json([])
  const rows = await emailMailbox(c.env, row.id).getThreadEmails(threadId)
  const attachments = await loadEmailAttachments(c.env.DB, c.get('userId'), rows.map((entry) => entry.id))
  return c.json(rows.map((entry) => toMessage(entry, attachments.get(entry.id) ?? [])))
})

emailRoutes.post('/accounts/:id/threads/:threadId/read', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const threadId = c.req.param('threadId') ?? ''
  if (threadId) await emailMailbox(c.env, row.id).markThreadRead(threadId)
  return c.body(null, 204)
})

emailRoutes.get('/accounts/:id/search', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const mailbox = emailMailbox(c.env, row.id)
  const folderParam = c.req.query('folder')?.trim() ?? ''
  const folder = folderParam ? (await resolveFolder(mailbox, folderParam)).id : undefined
  const { page, limit } = pageParams(c)
  const options = {
    query: c.req.query('query')?.trim() || undefined,
    from: c.req.query('from')?.trim() || undefined,
    to: c.req.query('to')?.trim() || undefined,
    subject: c.req.query('subject')?.trim() || undefined,
    folder,
    dateStart: dateQuery(c.req.query('date_start'), 'date_start'),
    dateEnd: dateQuery(c.req.query('date_end'), 'date_end'),
    isRead: booleanQuery(c.req.query('is_read'), 'is_read'),
    isStarred: booleanQuery(c.req.query('is_starred'), 'is_starred'),
    hasAttachment: booleanQuery(c.req.query('has_attachment'), 'has_attachment'),
    page,
    limit,
  }
  const rows = await mailbox.searchEmails(options)
  const totalCount = await mailbox.countSearchResults(options)
  return c.json({
    emails: rows.map((entry) => {
      const summary = toSummary(entry as unknown as SummaryRow)
      return { ...summary, folderName: (entry as unknown as SummaryRow).folder_name ?? null }
    }),
    totalCount,
  } satisfies EmailListResponse)
})

emailRoutes.post('/accounts/:id/drafts', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.note)
  if (typeof body.to !== 'string' || typeof body.subject !== 'string') {
    throw draftInvalid('The recipients and subject must be strings')
  }
  if (typeof body.body !== 'string' || typeof body.bodyHtml !== 'string') {
    throw draftInvalid('The draft body must include both markdown and HTML')
  }
  if (typeof body.cc !== 'undefined' && body.cc !== null && typeof body.cc !== 'string') {
    throw draftInvalid('The cc field must be a string')
  }
  if (typeof body.bcc !== 'undefined' && body.bcc !== null && typeof body.bcc !== 'string') {
    throw draftInvalid('The bcc field must be a string')
  }
  if (utf8ByteLength(body.body) > EMAIL_BODY_MAX_BYTES || utf8ByteLength(body.bodyHtml) > EMAIL_BODY_MAX_BYTES) {
    throw ApiError.tooLarge('The draft body exceeds the 5 MB limit')
  }
  if (body.subject.length > EMAIL_SUBJECT_MAX_CHARS) throw draftInvalid('The subject is too long')
  let draftId: string | null = null
  if (body.draftId !== undefined && body.draftId !== null && body.draftId !== '') {
    if (typeof body.draftId !== 'string' || !isValidId(body.draftId)) throw draftInvalid('The draft id is not valid')
    draftId = body.draftId
  }
  if (body.inReplyTo !== undefined && body.inReplyTo !== null && body.inReplyTo !== '' && typeof body.inReplyTo !== 'string') {
    throw draftInvalid('The in-reply-to value must be a string')
  }
  if (body.threadId !== undefined && body.threadId !== null && body.threadId !== '' && typeof body.threadId !== 'string') {
    throw draftInvalid('The thread id must be a string')
  }
  const mailbox = emailMailbox(c.env, row.id)
  let existing: EmailRow | null = null
  if (draftId) {
    existing = await mailbox.getEmail(draftId)
    if (!existing || existing.folder_id !== 'draft') throw messageNotFound()
  }
  const inReplyTo = typeof body.inReplyTo === 'string' && body.inReplyTo ? body.inReplyTo : null
  let threadId = typeof body.threadId === 'string' && body.threadId ? body.threadId : existing?.thread_id ?? null
  if (!threadId && inReplyTo) {
    const original = await mailbox.getEmail(inReplyTo)
    threadId = original?.thread_id ?? inReplyTo
  }
  const id = draftId ?? newId()
  const saved = await mailbox.saveDraft(draftId, {
    id,
    subject: body.subject,
    sender: row.address,
    recipient: body.to.trim(),
    cc: typeof body.cc === 'string' && body.cc.trim() ? body.cc.trim() : null,
    bcc: typeof body.bcc === 'string' && body.bcc.trim() ? body.bcc.trim() : null,
    date: Date.now(),
    body: body.bodyHtml,
    bodySource: body.body,
    inReplyTo,
    threadId: threadId ?? id,
  })
  if (!saved) throw draftInvalid('The draft could not be saved')
  return c.json({ draftId: saved }, draftId ? 200 : 201)
})

emailRoutes.post('/accounts/:id/drafts/:draftId/attachments', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const draftId = messageIdParam(c.req.param('draftId') ?? '')
  const body = await readJson<{ attachmentId?: unknown }>(c, JSON_BODY_LIMITS.small)
  if (typeof body.attachmentId !== 'string') throw attachmentNotFound()
  const attachmentId = attachmentIdParam(body.attachmentId)
  const mailbox = emailMailbox(c.env, row.id)
  const draft = await mailbox.getEmail(draftId)
  if (!draft || draft.folder_id !== 'draft') throw messageNotFound()
  const attachment = await getEmailAttachmentRow(c.env.DB, c.get('userId'), attachmentId)
  if (!attachment || (attachment.account_id && attachment.account_id !== row.id)) throw attachmentNotFound()
  if (attachment.locked) throw new ApiError(409, 'email_attachment_locked', 'The attachment can no longer be changed')
  if (attachment.email_id !== null) throw attachmentNotFound()
  const linked = await linkEmailAttachment(c.env.DB, c.get('userId'), attachmentId, row.id, draftId)
  if (!linked) {
    const latest = await getEmailAttachmentRow(c.env.DB, c.get('userId'), attachmentId)
    if (latest?.locked) throw new ApiError(409, 'email_attachment_locked', 'The attachment can no longer be changed')
    throw attachmentNotFound()
  }
  await mailbox.setHasAttachment(draftId, true)
  return c.body(null, 204)
})

emailRoutes.delete('/accounts/:id/drafts/:draftId/attachments/:attachmentId', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const draftId = messageIdParam(c.req.param('draftId') ?? '')
  const attachmentId = attachmentIdParam(c.req.param('attachmentId') ?? '')
  const attachment = await getEmailAttachmentRow(c.env.DB, c.get('userId'), attachmentId)
  if (!attachment || attachment.email_id !== draftId) throw attachmentNotFound()
  if (attachment.locked) throw new ApiError(409, 'email_attachment_locked', 'The attachment can no longer be changed')
  const objectKey = await unlinkEmailAttachment(c.env.DB, c.get('userId'), attachmentId, draftId)
  if (!objectKey) throw attachmentNotFound()
  const pending = await deleteEmailAttachmentObject(c.env, c.get('userId'), objectKey)
  if (pending) console.warn('[inkstone] Email attachment cleanup is pending for an unlinked draft attachment')
  const remaining = await countEmailAttachments(c.env.DB, c.get('userId'), draftId)
  await emailMailbox(c.env, row.id).setHasAttachment(draftId, remaining > 0)
  return c.body(null, 204)
})

emailRoutes.get('/files/:attachmentId', async (c) => {
  const attachmentId = attachmentIdParam(c.req.param('attachmentId') ?? '')
  const row = await getEmailAttachmentFileRow(c.env.DB, c.get('userId'), attachmentId)
  if (!row) throw attachmentNotFound()
  if (!c.env.FILES) {
    throw new ApiError(503, 'storage_unavailable', 'Email attachments require R2 storage')
  }
  if (row.storage !== 'r2') {
    throw new ApiError(503, 'storage_unavailable', 'This attachment storage is not available')
  }
  const cacheControl = 'private, no-store'
  const ifNoneMatch = c.req.header('if-none-match')
  if (ifNoneMatch) {
    const head = await c.env.FILES.head(row.object_key)
    if (!head) throw attachmentNotFound()
    const etag = attachmentETag(head)
    if (matchesETag(ifNoneMatch, etag)) {
      return new Response(null, {
        status: 304,
        headers: { 'ETag': etag, 'Cache-Control': cacheControl },
      })
    }
  }
  const rangeHeader = c.req.header('range')
  const range = rangeHeader === undefined ? null : parseByteRange(rangeHeader, row.size)
  if (range === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Range': `bytes */${row.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl,
      },
    })
  }
  const object = range
    ? await c.env.FILES.get(row.object_key, { range: { offset: range.start, length: range.end - range.start + 1 } })
    : await c.env.FILES.get(row.object_key)
  if (!object) throw attachmentNotFound()
  const length = range ? range.end - range.start + 1 : row.size
  const headers = new Headers({
    'Content-Type': row.mime,
    'Content-Length': String(length),
    'Content-Disposition': `${isInlineSafe(row.mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeContentDispositionFilename(row.filename)}`,
    'Cache-Control': cacheControl,
    'ETag': attachmentETag(object),
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  })
  if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${row.size}`)
  return new Response(object.body as BodyInit, { status: range ? 206 : 200, headers })
})

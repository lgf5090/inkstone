import type {
  EmailAccount,
  EmailAccountSettings,
  EmailBatchAction,
  EmailFolder,
  EmailSignature,
  EmailSummary,
  EmailTag,
  EmailVacationSettings,
} from '@shared/email/model'
import {
  EMAIL_BATCH_ACTIONS,
  EMAIL_BATCH_MAX_MESSAGES,
  EMAIL_BODY_MAX_BYTES,
  EMAIL_FOLDER_SEED_NAMES,
  EMAIL_SIGNATURES_MAX,
  EMAIL_SIGNATURE_NAME_MAX_CHARS,
  EMAIL_SIGNATURE_TEXT_MAX_CHARS,
  EMAIL_SUBJECT_MAX_CHARS,
  EMAIL_SYSTEM_FOLDERS,
  EMAIL_VACATION_BODY_MAX_CHARS,
  EMAIL_VACATION_SUBJECT_MAX_CHARS,
  normalizeEmailSignatures,
  normalizeEmailVacation,
} from '@shared/email/model'
import {
  parseEmailContactInput,
  parseEmailContactPatch,
  parseEmailGroupInput,
  parseEmailGroupPatch,
  normalizeContactEmail,
} from '@shared/email/contacts'
import {
  EMAIL_FILTER_MAX_RULES,
  isBlockableSenderAddress,
  normalizeEmailSenderAddress,
  parseEmailFilterInput,
  parseEmailFilterPatch,
  type EmailFilter,
  type EmailFilterAction,
  type EmailFilterCondition,
} from '@shared/email/rules'
import {
  EMAIL_FOLDER_DEPTH_MAX,
  emailFolderDepthAllowed,
  emailFolderNameTaken,
  emailFolderSubtreeHeight,
  emailFolderWouldCycle,
  type EmailFolderLike,
} from '@shared/email/folders'
import { isValidEmailTagPath, normalizeEmailTagPath } from '@shared/email/tags'
import {
  EMAIL_TEMPLATE_MAX,
  parseEmailTemplateInput,
  parseEmailTemplatePatch,
  type EmailTemplate,
} from '@shared/email/templates'
import {
  EMAIL_SAVED_SEARCH_MAX,
  parseEmailSavedSearchInput,
  parseEmailSavedSearchPatch,
  type EmailSavedSearch,
} from '@shared/email/searches'
import { textToEmailHtml } from '@shared/email/format'
import { LIMITS } from '@shared/constants'
import { organizerColorOrNull } from '@shared/organizer-colors'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import type { Env } from '../env'
import {
  getEmailAccount,
  listEmailAccounts,
  readAccountSettings,
  toEmailAccount,
  updateEmailAccount,
  type EmailAccountRow,
} from './account-store'
import { acquireLease } from '../lib/lease'
import { deleteEmailAttachmentsForMessages } from './attachments'
import {
  addEmailGroupMember,
  createEmailContact,
  createEmailGroup,
  deleteEmailContact,
  deleteEmailGroup,
  findEmailContactByEmail,
  findEmailGroupByName,
  getEmailContact,
  getEmailGroup,
  getEmailGroupWithMembers,
  listEmailContacts,
  listEmailGroups,
  removeEmailGroupMember,
  toEmailContact,
  toEmailGroup,
  updateEmailContact,
  updateEmailGroup,
} from './contacts'
import { emailMailbox } from './mailbox-stub'
import type {
  EmailFilterRecord,
  EmailSavedSearchRow,
  EmailTemplateRow,
  FolderRow,
  TagRow,
} from './mailbox-store'
import {
  cancelScheduledSend,
  listScheduledSends,
  scheduleDraftSend,
} from './scheduled-send'
import { sendDraftEmail } from './send-service'
import { assertEmailOwner, draftEmailReplyTool, draftEmailTool, resolveEmailAccount, toEmailSummary } from './tools'

const RESERVED_FOLDER_NAMES = new Set<string>([
  ...EMAIL_SYSTEM_FOLDERS,
  ...Object.values(EMAIL_FOLDER_SEED_NAMES).map((name) => name.toLowerCase()),
])

export type EmailAgentSection =
  | 'overview'
  | 'folders'
  | 'tags'
  | 'searches'
  | 'rules'
  | 'templates'
  | 'contacts'
  | 'settings'
  | 'scheduled'
  | 'stats'

export interface EmailAgentMessageUpdate {
  accountId?: string
  emailId: string
  read?: boolean
  starred?: boolean
  important?: boolean
  muted?: boolean
  folder?: string
  restore?: boolean
  snoozeUntil?: string | number | null
  followUpAt?: string | number | null
}

export interface EmailAgentSendInput {
  accountId?: string
  mode: 'draft' | 'new' | 'reply' | 'forward'
  draftId?: string
  emailId?: string
  to?: string
  subject?: string
  body?: string
}

export interface EmailAgentScheduleInput {
  accountId?: string
  action: 'schedule' | 'cancel'
  scheduledId?: string
  mode?: 'draft' | 'new' | 'reply' | 'forward'
  draftId?: string
  emailId?: string
  to?: string
  subject?: string
  body?: string
  sendAt?: string | number
}

export interface EmailAgentDeleteInput {
  accountId?: string
  kind: 'message' | 'folder' | 'tag' | 'rule' | 'template' | 'signature' | 'search' | 'contact' | 'group' | 'trash'
  id?: string
  permanent?: boolean
  deleteEmails?: boolean
}

function folderDto(row: FolderRow): EmailFolder {
  return {
    id: row.id,
    name: row.name,
    isDeletable: Boolean(row.is_deletable),
    unreadCount: Number(row.unread_count ?? 0),
    totalCount: Number(row.total_count ?? 0),
    parentId: row.parent_id ?? null,
    color: row.color ?? null,
    sortOrder: Number(row.sort_order ?? 0),
  }
}

function tagDto(row: TagRow): EmailTag {
  return {
    id: row.id,
    name: row.name,
    color: row.color ?? null,
    count: Number(row.count ?? 0),
  }
}

function filterDto(row: EmailFilterRecord): EmailFilter {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
    conditions: row.conditions,
    actions: row.actions,
    createdAt: new Date(row.createdAt).toISOString(),
  }
}

function templateDto(row: EmailTemplateRow): EmailTemplate {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    body: row.body,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function savedSearchDto(row: EmailSavedSearchRow): EmailSavedSearch {
  return {
    id: row.id,
    name: row.name,
    query: row.query,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

function accountView(row: EmailAccountRow): EmailAccount {
  return toEmailAccount(row)
}

function folderRefs(folders: readonly FolderRow[]): EmailFolderLike[] {
  return folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    parentId: folder.parent_id ?? null,
    sortOrder: Number(folder.sort_order ?? 0),
  }))
}

function matchFolder(folders: readonly FolderRow[], value: string): FolderRow | null {
  const wanted = value.trim()
  if (!wanted) return null
  const byId = folders.find((folder) => folder.id === wanted)
  if (byId) return byId
  const named = folders.filter((folder) => folder.name.toLowerCase() === wanted.toLowerCase())
  return named.length === 1 ? named[0]! : null
}

function readFolderName(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('A folder name is required')
  const name = value.trim()
  if (!name) throw ApiError.badRequest('A folder name is required')
  if (name.length > LIMITS.folderNameMaxLength) throw ApiError.badRequest('The folder name is too long')
  if (/[\u0000-\u001f\u007f/\\]/.test(name)) throw ApiError.badRequest('The folder name contains invalid characters')
  if (RESERVED_FOLDER_NAMES.has(name.toLowerCase())) throw new ApiError(400, 'email_folder_reserved', 'That folder name is reserved')
  return name
}

function readColor(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  const color = organizerColorOrNull(value)
  if (!color) throw ApiError.badRequest('The color is not valid')
  return color
}

function readTagPath(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('A tag name is required')
  const path = normalizeEmailTagPath(value)
  if (!isValidEmailTagPath(path)) throw ApiError.badRequest('The tag name is not valid')
  return path
}

function isoOrNull(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : new Date(value).toISOString()
}

function signatureView(settings: EmailAccountSettings): { signatures: EmailSignature[]; defaultId: string | null } {
  return normalizeEmailSignatures(settings)
}

function vacationView(settings: EmailAccountSettings): EmailVacationSettings {
  return normalizeEmailVacation(settings)
}

function settingsView(account: EmailAccountRow) {
  const settings = readAccountSettings(account.settings)
  const signatures = signatureView(settings)
  const vacation = vacationView(settings)
  return {
    accountId: account.id,
    address: account.address,
    displayName: account.display_name,
    autoDraft: settings.autoDraft ?? true,
    focusedInbox: settings.focusedInbox !== false,
    agentSystemPrompt: settings.agentSystemPrompt ?? '',
    signatures: signatures.signatures,
    defaultSignatureId: signatures.defaultId,
    vacation: {
      ...vacation,
      start: isoOrNull(vacation.start),
      end: isoOrNull(vacation.end),
    },
  }
}

function timestamp(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw ApiError.badRequest(`The ${field} is not valid`)
    return Math.trunc(value)
  }
  if (typeof value !== 'string') throw ApiError.badRequest(`The ${field} is not valid`)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw ApiError.badRequest(`The ${field} is not valid`)
  return parsed
}

function bareAddress(value: string): string {
  const match = /<([^<>]+)>/.exec(value)
  return (match?.[1] ?? value).trim()
}

function readableTime(at: number, timezone?: string, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale || 'en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone || 'UTC',
    }).format(new Date(at))
  } catch {
    return new Date(at).toISOString()
  }
}

const SETTINGS_LEASE_MS = 5_000

async function withSettingsLock<T>(env: Env, accountId: string, task: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    let release: Awaited<ReturnType<typeof acquireLease>> | null = null
    try {
      release = await acquireLease(env.DB, `email_settings_lock:${accountId}`, SETTINGS_LEASE_MS, 'The mailbox settings are being changed; try again in a moment')
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)))
        continue
      }
      throw error
    }
    try {
      return await task()
    } finally {
      await release()
    }
  }
  throw ApiError.conflict('The mailbox settings are being changed; try again in a moment')
}

function parseFilterTokenConditions(values: readonly string[]): EmailFilterCondition[] {
  const conditions: EmailFilterCondition[] = []
  const fields = new Set<string>()
  for (const raw of values.slice(0, 5)) {
    const token = raw.trim()
    if (!token) continue
    let condition: EmailFilterCondition | null = null
    if (/^(has[-_ ]?attachment)$/i.test(token)) condition = { field: 'hasAttachment', value: true }
    else {
      const match = /^(from|to|subject)\s*(?:contains\s*)?[:=]\s*(.+)$/i.exec(token)
      if (match) {
        const field = match[1]!.toLowerCase() === 'from'
          ? 'fromContains'
          : match[1]!.toLowerCase() === 'to' ? 'toContains' : 'subjectContains'
        condition = { field, value: match[2]!.trim() }
      } else {
        const size = /^(?:min(?:imum)?[-_ ]?bytes|larger)\s*[:=]\s*(\d+)$/i.exec(token)
        if (size) condition = { field: 'minBytes', value: Number(size[1]) }
      }
    }
    if (!condition || fields.has(condition.field)) throw ApiError.badRequest(`The rule condition "${token}" is not valid`)
    fields.add(condition.field)
    conditions.push(condition)
  }
  if (!conditions.length) throw ApiError.badRequest('At least one rule condition is required')
  return conditions
}

function parseFilterTokenActions(values: readonly string[], folders: readonly FolderRow[]): EmailFilterAction[] {
  const actions: EmailFilterAction[] = []
  const types = new Set<string>()
  for (const raw of values.slice(0, 5)) {
    const token = raw.trim()
    if (!token) continue
    let action: EmailFilterAction | null = null
    const move = /^(?:move(?:\s+to)?|folder)\s*[:=]\s*(.+)$/i.exec(token)
    const tag = /^tag\s*[:=]\s*(.+)$/i.exec(token)
    if (move) {
      const folder = matchFolder(folders, move[1]!.trim())
      if (!folder) throw new ApiError(404, 'email_folder_not_found', `Folder "${move[1]!.trim()}" was not found`)
      action = { type: 'moveTo', folder: folder.id }
    } else if (tag) {
      const path = readTagPath(tag[1]!.trim())
      action = { type: 'addTag', tag: path }
    } else if (/^(mark\s+)?read$/i.test(token)) action = { type: 'markRead' }
    else if (/^star$/i.test(token)) action = { type: 'star' }
    else if (/^(move\s+to\s+)?trash$/i.test(token)) action = { type: 'trash' }
    if (!action || types.has(action.type)) throw ApiError.badRequest(`The rule action "${token}" is not valid`)
    types.add(action.type)
    actions.push(action)
  }
  if (!actions.length) throw ApiError.badRequest('At least one rule action is required')
  return actions
}

export async function inspectEmailAgent(
  env: Env,
  userId: string,
  input: { accountId?: string; section: EmailAgentSection },
): Promise<Record<string, unknown>> {
  await assertEmailOwner(env, userId)
  const section = input.section
  if (section === 'contacts') {
    const [contacts, groups] = await Promise.all([
      listEmailContacts(env.DB, userId, { limit: 50 }),
      listEmailGroups(env.DB, userId),
    ])
    return { contacts: contacts.map(toEmailContact), groups }
  }
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const mailbox = emailMailbox(env, account.id)
  switch (section) {
    case 'folders':
      return { account: accountView(account), folders: (await mailbox.getFolders()).map(folderDto) }
    case 'tags':
      return { account: accountView(account), tags: (await mailbox.listTags()).map(tagDto) }
    case 'searches':
      return { account: accountView(account), searches: (await mailbox.listSavedSearches()).map(savedSearchDto) }
    case 'rules':
      return {
        account: accountView(account),
        filters: (await mailbox.listFilters()).map(filterDto),
        blockedSenders: (await mailbox.listBlockedSenders()).map((row) => ({
          address: row.email_normalized,
          createdAt: new Date(Number(row.created_at)).toISOString(),
        })),
      }
    case 'templates':
      return { account: accountView(account), templates: (await mailbox.listTemplates()).map(templateDto) }
    case 'settings':
      return { account: accountView(account), settings: settingsView(account) }
    case 'scheduled':
      return {
        account: accountView(account),
        scheduled: (await listScheduledSends(env, userId, account.id, 50)).map((row) => ({
          id: row.id,
          accountId: row.accountId,
          draftId: row.draftId,
          sendAt: row.sendAt,
          status: row.status,
          lastError: row.lastError,
        })),
      }
    case 'stats':
      return { account: accountView(account), stats: mailbox.mailboxStats() }
    case 'overview': {
      const [folders, tags, searches, filters, blocked, templates, stats] = await Promise.all([
        mailbox.getFolders(),
        mailbox.listTags(),
        mailbox.listSavedSearches(),
        mailbox.listFilters(),
        mailbox.listBlockedSenders(),
        mailbox.listTemplates(),
        Promise.resolve(mailbox.mailboxStats()),
      ])
      return {
        accounts: (await listEmailAccounts(env.DB, userId)).map(accountView),
        account: accountView(account),
        folders: folders.map(folderDto),
        tags: tags.map(tagDto),
        searches: searches.map(savedSearchDto),
        filters: filters.map(filterDto),
        blockedSenders: blocked.map((row) => ({ address: row.email_normalized, createdAt: new Date(Number(row.created_at)).toISOString() })),
        templates: templates.map(templateDto),
        stats,
      }
    }
    default:
      throw ApiError.badRequest('The requested mailbox section is not supported')
  }
}

export async function createEmailFolderAgent(
  env: Env,
  userId: string,
  input: { accountId?: string; name: unknown; parentId?: unknown; color?: unknown },
): Promise<EmailFolder> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const mailbox = emailMailbox(env, account.id)
  const name = readFolderName(input.name)
  const folders = await mailbox.getFolders()
  let parentId: string | null = null
  if (input.parentId !== undefined && input.parentId !== null && input.parentId !== '') {
    if (typeof input.parentId !== 'string') throw ApiError.badRequest('The parent folder is not valid')
    const parent = matchFolder(folders, input.parentId)
    if (!parent) throw new ApiError(404, 'email_folder_not_found', 'Parent folder not found')
    parentId = parent.id
  }
  const refs = folderRefs(folders)
  if (!emailFolderDepthAllowed(refs, parentId)) throw ApiError.badRequest(`Folder nesting is limited to ${EMAIL_FOLDER_DEPTH_MAX} levels`)
  if (emailFolderNameTaken(refs, parentId, name)) throw new ApiError(409, 'email_folder_exists', 'A folder with that name already exists')
  const created = await mailbox.createFolder(name, parentId, readColor(input.color))
  if (!created) throw new ApiError(409, 'email_folder_exists', 'A folder with that name already exists')
  return folderDto(created)
}

export async function updateEmailFolderAgent(
  env: Env,
  userId: string,
  input: { accountId?: string; folderId: string; name?: unknown; parentId?: unknown; color?: unknown; sortOrder?: unknown },
): Promise<EmailFolder> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const mailbox = emailMailbox(env, account.id)
  const folders = await mailbox.getFolders()
  const folder = matchFolder(folders, input.folderId)
  if (!folder) throw new ApiError(404, 'email_folder_not_found', 'Folder not found')
  if (!folder.is_deletable) throw new ApiError(400, 'email_folder_reserved', 'System folders cannot be changed')
  const patch: { name?: string; parentId?: string | null; color?: string | null; sortOrder?: number } = {}
  if (input.name !== undefined) patch.name = readFolderName(input.name)
  if (input.parentId !== undefined) {
    if (input.parentId === null || input.parentId === '') patch.parentId = null
    else if (typeof input.parentId === 'string') {
      const parent = matchFolder(folders, input.parentId)
      if (!parent) throw new ApiError(404, 'email_folder_not_found', 'Parent folder not found')
      patch.parentId = parent.id
    } else throw ApiError.badRequest('The parent folder is not valid')
  }
  if (input.color !== undefined) patch.color = readColor(input.color)
  if (input.sortOrder !== undefined) {
    if (typeof input.sortOrder !== 'number' || !Number.isSafeInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > 1_000_000) {
      throw ApiError.badRequest('The sort order must be a non-negative integer')
    }
    patch.sortOrder = input.sortOrder
  }
  if (!Object.keys(patch).length) throw ApiError.badRequest('No folder changes were supplied')
  const refs = folderRefs(folders)
  if (patch.parentId !== undefined) {
    if (emailFolderWouldCycle(refs, folder.id, patch.parentId)) throw ApiError.badRequest('A folder cannot be moved inside itself')
    if (!emailFolderDepthAllowed(refs, patch.parentId, emailFolderSubtreeHeight(refs, folder.id))) {
      throw ApiError.badRequest(`Folder nesting is limited to ${EMAIL_FOLDER_DEPTH_MAX} levels`)
    }
  }
  const nextParent = patch.parentId !== undefined ? patch.parentId : folder.parent_id ?? null
  const nextName = patch.name ?? folder.name
  if (emailFolderNameTaken(refs, nextParent, nextName, folder.id)) {
    throw new ApiError(409, 'email_folder_exists', 'A folder with that name already exists')
  }
  const updated = await mailbox.updateFolder(folder.id, patch)
  if (!updated) throw new ApiError(409, 'email_folder_exists', 'The folder could not be updated')
  return folderDto(updated)
}

export async function createEmailTagAgent(
  env: Env,
  userId: string,
  input: { accountId?: string; name: unknown; color?: unknown },
): Promise<EmailTag> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const name = readTagPath(input.name)
  const created = await emailMailbox(env, account.id).createTag(name, readColor(input.color))
  if (!created) throw new ApiError(409, 'conflict', 'A tag with that name already exists')
  return tagDto(created)
}

export async function updateEmailTagAgent(
  env: Env,
  userId: string,
  input: { accountId?: string; tagId: string; name?: unknown; color?: unknown },
): Promise<EmailTag> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const mailbox = emailMailbox(env, account.id)
  const tag = isValidId(input.tagId) ? await mailbox.getTag(input.tagId) : null
  if (!tag) throw new ApiError(404, 'not_found', 'Tag not found')
  const patch: { name?: string; color?: string | null } = {}
  if (input.name !== undefined) patch.name = readTagPath(input.name)
  if (input.color !== undefined) patch.color = readColor(input.color)
  if (!Object.keys(patch).length) throw ApiError.badRequest('No tag changes were supplied')
  const updated = await mailbox.updateTag(tag.id, patch)
  if (!updated) throw new ApiError(409, 'conflict', 'A tag with that name already exists')
  return tagDto(updated)
}

export async function tagEmailAgent(
  env: Env,
  userId: string,
  input: { accountId?: string; emailId: string; tagId?: string; name?: string; remove?: boolean },
): Promise<{ emailId: string; tagId: string; attached: boolean }> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const mailbox = emailMailbox(env, account.id)
  if (!(await mailbox.getEmail(input.emailId))) throw new ApiError(404, 'email_message_not_found', 'Email not found')
  let tag: TagRow | null = null
  if (input.tagId !== undefined) {
    if (!isValidId(input.tagId)) throw new ApiError(404, 'not_found', 'Tag not found')
    tag = await mailbox.getTag(input.tagId)
  } else if (input.name !== undefined) {
    const path = readTagPath(input.name)
    tag = await mailbox.findTagByPath(path)
    if (!tag) {
      const ancestors = path.split('/').slice(0, -1)
      if (ancestors.length) {
        const done = await mailbox.attachTagPaths(input.emailId, [path])
        if (!done.length) throw new ApiError(404, 'not_found', 'The tag could not be created')
        tag = await mailbox.findTagByPath(path)
      } else {
        tag = await mailbox.createTag(path)
      }
    }
  }
  if (!tag) throw ApiError.badRequest('Name a tag id or tag path')
  const attached = input.remove
    ? await mailbox.detachTag(input.emailId, tag.id)
    : await mailbox.attachTag(input.emailId, tag.id)
  if (!attached && !input.remove) throw new ApiError(404, 'not_found', 'The tag could not be attached')
  return { emailId: input.emailId, tagId: tag.id, attached: !input.remove }
}

export async function updateEmailMessageAgent(
  env: Env,
  userId: string,
  input: EmailAgentMessageUpdate,
): Promise<EmailSummary> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const mailbox = emailMailbox(env, account.id)
  const current = await mailbox.getEmail(input.emailId)
  if (!current) throw new ApiError(404, 'email_message_not_found', 'Email not found')
  let changed = false
  if (input.read !== undefined || input.starred !== undefined || input.important !== undefined) {
    const patch: { read?: boolean; starred?: boolean; important?: boolean } = {}
    if (input.read !== undefined) patch.read = input.read
    if (input.starred !== undefined) patch.starred = input.starred
    if (input.important !== undefined) patch.important = input.important
    const updated = await mailbox.updateEmail(input.emailId, patch)
    if (!updated) throw new ApiError(404, 'email_message_not_found', 'Email not found')
    changed = true
  }
  if (input.muted !== undefined) {
    await mailbox.muteThread(current.thread_id || current.id, input.muted)
    changed = true
  }
  if (input.folder !== undefined) {
    const folder = matchFolder(await mailbox.getFolders(), input.folder)
    if (!folder) throw new ApiError(404, 'email_folder_not_found', 'Folder not found')
    if (folder.id === 'trash') {
      if (!(await mailbox.trashEmail(input.emailId))) throw new ApiError(404, 'email_message_not_found', 'Email not found')
    } else if (!(await mailbox.moveEmail(input.emailId, folder.id))) {
      throw new ApiError(404, 'email_message_not_found', 'Email not found')
    }
    changed = true
  }
  if (input.restore === true) {
    if (!(await mailbox.restoreEmail(input.emailId))) throw new ApiError(404, 'email_message_not_found', 'Email not found')
    changed = true
  }
  if (input.snoozeUntil !== undefined) {
    if (input.snoozeUntil === null || input.snoozeUntil === '') {
      if (!(await mailbox.clearSnooze(input.emailId))) throw new ApiError(404, 'email_message_not_found', 'Email not found')
    } else {
      const until = timestamp(input.snoozeUntil, 'snooze time')
      if (until === null) throw ApiError.badRequest('The snooze time is not valid')
      if (!(await mailbox.snoozeEmail(input.emailId, until))) throw ApiError.badRequest('The email cannot be snoozed to that time')
    }
    changed = true
  }
  if (input.followUpAt !== undefined) {
    const at = input.followUpAt === null || input.followUpAt === '' ? null : timestamp(input.followUpAt, 'follow-up time')
    if (!(await mailbox.setFollowUp(input.emailId, at))) throw new ApiError(404, 'email_message_not_found', 'Email not found')
    changed = true
  }
  if (!changed) throw ApiError.badRequest('No email changes were supplied')
  const updated = await mailbox.getEmail(input.emailId)
  if (!updated) throw new ApiError(404, 'email_message_not_found', 'Email not found')
  return toEmailSummary(updated)
}

export async function batchEmailAgent(
  env: Env,
  userId: string,
  input: { accountId?: string; ids: readonly string[]; action: string; folder?: string },
): Promise<{ updated: number }> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  if (!Array.isArray(input.ids) || !input.ids.length) throw ApiError.badRequest('A non-empty list of message ids is required')
  if (input.ids.length > EMAIL_BATCH_MAX_MESSAGES) throw ApiError.badRequest(`At most ${EMAIL_BATCH_MAX_MESSAGES} messages can be changed at once`)
  for (const id of input.ids) if (!isValidId(id)) throw ApiError.badRequest('Every message id must be valid')
  if (!(EMAIL_BATCH_ACTIONS as readonly string[]).includes(input.action)) throw ApiError.badRequest('The batch action is not supported')
  const mailbox = emailMailbox(env, account.id)
  let folderId: string | undefined
  if (input.action === 'move') {
    const folder = matchFolder(await mailbox.getFolders(), input.folder ?? '')
    if (!folder) throw new ApiError(404, 'email_folder_not_found', 'Folder not found')
    folderId = folder.id
  }
  return mailbox.batchUpdate([...new Set(input.ids)], input.action as EmailBatchAction, folderId)
}

export async function updateEmailDraftAgent(
  env: Env,
  userId: string,
  input: { accountId?: string; draftId: string; to?: string; cc?: string | null; bcc?: string | null; subject?: string; body?: string },
): Promise<{ draftId: string; threadId: string; to: string; subject: string; body: string }> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const mailbox = emailMailbox(env, account.id)
  const draft = await mailbox.getEmail(input.draftId)
  if (!draft || draft.folder_id !== 'draft') throw new ApiError(404, 'email_message_not_found', 'Draft not found')
  const to = input.to === undefined ? draft.recipient : input.to.trim().toLowerCase()
  const cc = input.cc === undefined ? draft.cc : input.cc?.trim() || null
  const bcc = input.bcc === undefined ? draft.bcc : input.bcc?.trim() || null
  const subject = input.subject === undefined ? draft.subject : input.subject
  if (subject.length > EMAIL_SUBJECT_MAX_CHARS) throw ApiError.badRequest('The subject is too long')
  const bodySource = input.body === undefined ? draft.body_source ?? '' : input.body.trim()
  const body = input.body === undefined ? draft.body : textToEmailHtml(bodySource)
  if (new TextEncoder().encode(body).byteLength > EMAIL_BODY_MAX_BYTES) throw ApiError.tooLarge('The draft body exceeds the 5 MB limit')
  const saved = await mailbox.saveDraft(draft.id, {
    id: draft.id,
    subject,
    sender: account.address,
    recipient: to,
    cc,
    bcc,
    date: draft.date,
    body,
    bodySource,
    inReplyTo: draft.in_reply_to,
    threadId: draft.thread_id ?? draft.id,
  })
  if (!saved) throw ApiError.badRequest('The draft could not be saved')
  return { draftId: saved, threadId: draft.thread_id ?? draft.id, to, subject, body: bodySource }
}

async function createDraftForSend(
  env: Env,
  userId: string,
  accountId: string,
  input: EmailAgentSendInput,
): Promise<string> {
  const account = await resolveEmailAccount(env, userId, accountId)
  if (input.mode === 'draft') {
    if (!input.draftId || !isValidId(input.draftId)) throw ApiError.badRequest('A draft id is required')
    const draft = await emailMailbox(env, account.id).getEmail(input.draftId)
    if (!draft || draft.folder_id !== 'draft') throw new ApiError(404, 'email_message_not_found', 'Draft not found')
    return draft.id
  }
  const body = (input.body ?? '').trim()
  if (!body) throw ApiError.badRequest('A message body is required')
  if (input.mode === 'new') {
    const to = bareAddress(input.to ?? '')
    const subject = (input.subject ?? '').trim()
    if (!to) throw ApiError.badRequest('A recipient is required')
    if (subject.length > EMAIL_SUBJECT_MAX_CHARS) throw ApiError.badRequest('The subject is too long')
    return (await draftEmailTool(env, userId, { accountId: account.id, to, subject, body })).draftId
  }
  const originalId = input.emailId
  if (!originalId) throw ApiError.badRequest('The original email id is required')
  const original = await emailMailbox(env, account.id).getEmail(originalId)
  if (!original) throw new ApiError(404, 'email_message_not_found', 'Email not found')
  const to = bareAddress(input.to ?? original.sender)
  const prefix = input.mode === 'forward' ? 'Fwd:' : 'Re:'
  const subject = (input.subject ?? `${prefix} ${original.subject}`).trim().slice(0, EMAIL_SUBJECT_MAX_CHARS)
  return (await draftEmailReplyTool(env, userId, {
    accountId: account.id,
    originalEmailId: original.id,
    to,
    subject,
    body,
  }))!.draftId
}

export async function sendEmailAgent(
  env: Env,
  userId: string,
  input: EmailAgentSendInput & { operationId: string },
): Promise<{ status: string; messageId?: string; draftId: string; to: string; subject: string; error?: string }> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const draftId = await createDraftForSend(env, userId, account.id, input)
  const mailbox = emailMailbox(env, account.id)
  const draft = await mailbox.getEmail(draftId)
  if (!draft) throw new ApiError(404, 'email_message_not_found', 'Draft not found')
  if (!draft.recipient.trim()) throw ApiError.badRequest('The draft has no recipient')
  const body = draft.body_source?.trim() || draft.body
  const outcome = await sendDraftEmail(env, userId, account, draftId, {
    operationId: input.operationId,
    to: draft.recipient,
    cc: draft.cc ?? undefined,
    bcc: draft.bcc ?? undefined,
    subject: draft.subject,
    body,
    bodyHtml: draft.body,
  })
  return {
    status: outcome.result.status,
    ...(outcome.result.messageId ? { messageId: outcome.result.messageId } : {}),
    draftId,
    to: draft.recipient,
    subject: draft.subject,
    ...(outcome.result.error ? { error: outcome.result.error } : {}),
  }
}

export async function scheduleEmailAgent(
  env: Env,
  userId: string,
  input: EmailAgentScheduleInput,
): Promise<Record<string, unknown>> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  if (input.action === 'cancel') {
    if (!input.scheduledId || !isValidId(input.scheduledId)) throw ApiError.badRequest('A scheduled send id is required')
    if (!(await cancelScheduledSend(env, userId, input.scheduledId, account.id))) {
      throw new ApiError(404, 'not_found', 'No queued scheduled send matches that id')
    }
    return { status: 'cancelled', scheduledId: input.scheduledId }
  }
  const at = timestamp(input.sendAt, 'send time')
  if (at === null) throw ApiError.badRequest('A send time is required')
  if (!input.mode) throw ApiError.badRequest('A send mode is required')
  const draftId = await createDraftForSend(env, userId, account.id, {
    mode: input.mode,
    draftId: input.draftId,
    emailId: input.emailId,
    to: input.to,
    subject: input.subject,
    body: input.body,
  })
  const scheduled = await scheduleDraftSend(env, userId, account.id, draftId, at, `agent-schedule:${draftId}`)
  return {
    status: 'scheduled',
    scheduledId: scheduled.id,
    draftId,
    sendAt: scheduled.sendAt,
  }
}

export async function prepareSendEmailAgent(
  env: Env,
  userId: string,
  input: EmailAgentSendInput,
): Promise<{ targetId: string; targetLabel: string }> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  if (input.mode === 'draft') {
    if (!input.draftId || !isValidId(input.draftId)) throw ApiError.badRequest('A draft id is required')
    const draft = await emailMailbox(env, account.id).getEmail(input.draftId)
    if (!draft || draft.folder_id !== 'draft') throw new ApiError(404, 'email_message_not_found', 'Draft not found')
    return { targetId: draft.id, targetLabel: `${draft.recipient} - ${draft.subject}` }
  }
  if (!(input.body ?? '').trim()) throw ApiError.badRequest('A message body is required')
  if (input.mode === 'new') {
    const to = bareAddress(input.to ?? '')
    if (!to) throw ApiError.badRequest('A recipient is required')
    const subject = (input.subject ?? '').trim()
    return { targetId: `new-${newId()}`, targetLabel: `${to} - ${subject || '(no subject)'}` }
  }
  if (!input.emailId) throw ApiError.badRequest('The original email id is required')
  const original = await emailMailbox(env, account.id).getEmail(input.emailId)
  if (!original) throw new ApiError(404, 'email_message_not_found', 'Email not found')
  const to = bareAddress(input.to ?? original.sender)
  const prefix = input.mode === 'forward' ? 'Fwd:' : 'Re:'
  return { targetId: `reply-${newId()}`, targetLabel: `${to} - ${input.subject?.trim() || `${prefix} ${original.subject}`}` }
}

export async function prepareScheduleEmailAgent(
  env: Env,
  userId: string,
  input: EmailAgentScheduleInput,
  options: { timezone?: string; locale?: string } = {},
): Promise<{ targetId: string; targetLabel: string }> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  if (input.action === 'cancel') {
    if (!input.scheduledId || !isValidId(input.scheduledId)) throw ApiError.badRequest('A scheduled send id is required')
    const jobs = await listScheduledSends(env, userId, account.id, 200)
    const job = jobs.find((entry) => entry.id === input.scheduledId)
    if (!job || job.status !== 'queued') throw new ApiError(404, 'not_found', 'No queued scheduled send matches that id')
    return { targetId: job.id, targetLabel: `cancel ${readableTime(Date.parse(job.sendAt), options.timezone, options.locale)} ${job.draftId}` }
  }
  const at = timestamp(input.sendAt, 'send time')
  if (at === null) throw ApiError.badRequest('A send time is required')
  if (at <= Date.now()) throw ApiError.badRequest('The send time must be in the future')
  if (!input.mode) throw ApiError.badRequest('A send mode is required')
  const when = readableTime(at, options.timezone, options.locale)
  if (input.mode === 'draft') {
    if (!input.draftId || !isValidId(input.draftId)) throw ApiError.badRequest('A draft id is required')
    const draft = await emailMailbox(env, account.id).getEmail(input.draftId)
    if (!draft || draft.folder_id !== 'draft') throw new ApiError(404, 'email_message_not_found', 'Draft not found')
    return { targetId: `schedule-${draft.id}`, targetLabel: `${when} ${draft.recipient} - ${draft.subject}` }
  }
  if (!(input.body ?? '').trim()) throw ApiError.badRequest('A message body is required')
  if (input.mode === 'new') {
    const to = bareAddress(input.to ?? '')
    if (!to) throw ApiError.badRequest('A recipient is required')
    return { targetId: `schedule-new-${newId()}`, targetLabel: `${when} ${to} - ${input.subject?.trim() || '(no subject)'}` }
  }
  if (!input.emailId) throw ApiError.badRequest('The original email id is required')
  const original = await emailMailbox(env, account.id).getEmail(input.emailId)
  if (!original) throw new ApiError(404, 'email_message_not_found', 'Email not found')
  return { targetId: `schedule-reply-${newId()}`, targetLabel: `${when} ${bareAddress(original.sender)} - ${input.subject?.trim() || original.subject}` }
}

export async function manageEmailRuleAgent(
  env: Env,
  userId: string,
  input: {
    accountId?: string
    action: 'create' | 'update' | 'block' | 'unblock'
    filterId?: string
    name?: string
    enabled?: boolean
    conditions?: readonly string[]
    actions?: readonly string[]
    address?: string
  },
): Promise<Record<string, unknown>> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const mailbox = emailMailbox(env, account.id)
  if (input.action === 'block' || input.action === 'unblock') {
    const address = normalizeEmailSenderAddress(input.address ?? '')
    if (!isBlockableSenderAddress(address)) throw ApiError.badRequest('The sender address is not valid')
    if (input.action === 'unblock') {
      if (!(await mailbox.removeBlockedSender(address))) throw new ApiError(404, 'not_found', 'Blocked sender not found')
      return { status: 'unblocked', address }
    }
    const added = await mailbox.addBlockedSender(address)
    if (!added) throw ApiError.badRequest('The sender address is not valid')
    return { status: 'blocked', address }
  }
  if (input.action === 'create') {
    if ((await mailbox.listFilters()).length >= EMAIL_FILTER_MAX_RULES) {
      throw new ApiError(409, 'conflict', `At most ${EMAIL_FILTER_MAX_RULES} filters are allowed`)
    }
    const filters = await mailbox.listFilters()
    const inputValue = {
      name: input.name,
      enabled: input.enabled ?? true,
      conditions: parseFilterTokenConditions(input.conditions ?? []),
      actions: parseFilterTokenActions(input.actions ?? [], await mailbox.getFolders()),
    }
    const parsed = parseEmailFilterInput(inputValue)
    if (!parsed) throw ApiError.badRequest('The filter is not valid')
    const created = await mailbox.createFilter(parsed)
    if (!created) throw new ApiError(409, 'conflict', `At most ${EMAIL_FILTER_MAX_RULES} filters are allowed`)
    return { status: 'created', filter: filterDto(created), filters: filters.length + 1 }
  }
  if (!input.filterId || !isValidId(input.filterId)) throw ApiError.badRequest('A filter id is required')
  if (!(await mailbox.getFilter(input.filterId))) throw new ApiError(404, 'not_found', 'Filter not found')
  const patch: { name?: string; enabled?: boolean; conditions?: EmailFilterCondition[]; actions?: EmailFilterAction[] } = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.enabled !== undefined) patch.enabled = input.enabled
  if (input.conditions !== undefined) patch.conditions = parseFilterTokenConditions(input.conditions)
  if (input.actions !== undefined) patch.actions = parseFilterTokenActions(input.actions, await mailbox.getFolders())
  const parsed = parseEmailFilterPatch(patch)
  if (!parsed) throw ApiError.badRequest('The filter is not valid')
  const updated = await mailbox.updateFilter(input.filterId, parsed)
  if (!updated) throw new ApiError(404, 'not_found', 'Filter not found')
  return { status: 'updated', filter: filterDto(updated) }
}

export async function manageEmailTemplateAgent(
  env: Env,
  userId: string,
  input: { accountId?: string; action: 'create' | 'update'; templateId?: string; name?: string; subject?: string; body?: string },
): Promise<Record<string, unknown>> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const mailbox = emailMailbox(env, account.id)
  if (input.action === 'create') {
    if ((await mailbox.countTemplates()) >= EMAIL_TEMPLATE_MAX) throw new ApiError(409, 'conflict', `At most ${EMAIL_TEMPLATE_MAX} templates are allowed`)
    const parsed = parseEmailTemplateInput({ name: input.name, subject: input.subject ?? '', body: input.body ?? '' })
    if (!parsed) throw ApiError.badRequest('The template is not valid')
    const created = await mailbox.createTemplate(parsed)
    if (!created) throw new ApiError(409, 'conflict', 'A template with that name already exists')
    return { status: 'created', template: templateDto(created) }
  }
  if (!input.templateId || !isValidId(input.templateId)) throw ApiError.badRequest('A template id is required')
  const patch: { name?: string; subject?: string; body?: string } = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.subject !== undefined) patch.subject = input.subject
  if (input.body !== undefined) patch.body = input.body
  const parsed = parseEmailTemplatePatch(patch)
  if (!parsed) throw ApiError.badRequest('The template is not valid')
  const updated = await mailbox.updateTemplate(input.templateId, parsed)
  if (!updated) throw new ApiError(404, 'not_found', 'Template not found')
  return { status: 'updated', template: templateDto(updated) }
}

export async function manageEmailSignatureAgent(
  env: Env,
  userId: string,
  input: {
    accountId?: string
    action: 'create' | 'update' | 'default' | 'toggle'
    signatureId?: string
    name?: string
    text?: string
  },
): Promise<Record<string, unknown>> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  return withSettingsLock(env, account.id, async () => {
    const fresh = await getEmailAccount(env.DB, userId, account.id)
    if (!fresh) throw new ApiError(404, 'email_account_not_found', 'Mailbox not found')
    const settings = readAccountSettings(fresh.settings)
    const current = normalizeEmailSignatures(settings)
    const signatures = current.signatures.map((signature) => ({ ...signature }))
    const signatureId = input.signatureId
    const targetIndex = signatureId ? signatures.findIndex((signature) => signature.id === signatureId) : -1
    if (input.action !== 'create' && targetIndex < 0) throw new ApiError(404, 'not_found', 'Signature not found')
    if (input.action === 'create') {
      if (signatures.length >= EMAIL_SIGNATURES_MAX) throw new ApiError(409, 'conflict', `At most ${EMAIL_SIGNATURES_MAX} signatures are allowed`)
      const name = (input.name ?? '').trim()
      if (!name || name.length > EMAIL_SIGNATURE_NAME_MAX_CHARS) throw ApiError.badRequest('A signature name is required')
      const text = input.text ?? ''
      if (text.length > EMAIL_SIGNATURE_TEXT_MAX_CHARS) throw ApiError.badRequest('The signature text is too long')
      const created: EmailSignature = { id: newId(), name, text, enabled: true }
      signatures.push(created)
      settings.signatures = signatures
      if (!current.defaultId) settings.defaultSignatureId = created.id
      const saved = await updateEmailAccount(env.DB, userId, fresh.id, { settings })
      if (!saved) throw new ApiError(404, 'email_account_not_found', 'Mailbox not found')
      return { status: 'created', signature: created, ...signatureView(readAccountSettings(saved.settings)) }
    }
  const target = signatures[targetIndex]!
  if (input.action === 'update') {
    if (input.name !== undefined) {
      const name = input.name.trim()
      if (!name || name.length > EMAIL_SIGNATURE_NAME_MAX_CHARS) throw ApiError.badRequest('A signature name is required')
      target.name = name
    }
    if (input.text !== undefined) {
      if (input.text.length > EMAIL_SIGNATURE_TEXT_MAX_CHARS) throw ApiError.badRequest('The signature text is too long')
      target.text = input.text
    }
  } else if (input.action === 'default') {
    target.enabled = true
    settings.defaultSignatureId = target.id
  } else {
    target.enabled = !target.enabled
    if (!target.enabled && current.defaultId === target.id) settings.defaultSignatureId = undefined
  }
  settings.signatures = signatures
  const saved = await updateEmailAccount(env.DB, userId, fresh.id, { settings })
  if (!saved) throw new ApiError(404, 'email_account_not_found', 'Mailbox not found')
  return { status: input.action, signature: target, ...signatureView(readAccountSettings(saved.settings)) }
  })
}

export async function manageEmailSearchAgent(
  env: Env,
  userId: string,
  input: { accountId?: string; action: 'create' | 'update'; searchId?: string; name?: string; query?: string },
): Promise<Record<string, unknown>> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const mailbox = emailMailbox(env, account.id)
  if (input.action === 'create') {
    if ((await mailbox.countSavedSearches()) >= EMAIL_SAVED_SEARCH_MAX) {
      throw new ApiError(409, 'conflict', `At most ${EMAIL_SAVED_SEARCH_MAX} saved searches are allowed`)
    }
    const parsed = parseEmailSavedSearchInput({ name: input.name, query: input.query })
    if (!parsed) throw ApiError.badRequest('The saved search is not valid')
    const created = await mailbox.createSavedSearch(parsed)
    if (!created) throw new ApiError(409, 'conflict', 'A saved search with this name already exists')
    return { status: 'created', search: savedSearchDto(created) }
  }
  if (!input.searchId || !isValidId(input.searchId)) throw ApiError.badRequest('A saved search id is required')
  const patch: { name?: string; query?: string } = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.query !== undefined) patch.query = input.query
  const parsed = parseEmailSavedSearchPatch(patch)
  if (!parsed) throw ApiError.badRequest('The saved search is not valid')
  const updated = await mailbox.updateSavedSearch(input.searchId, parsed)
  if (!updated) throw new ApiError(409, 'conflict', 'The saved search could not be updated')
  return { status: 'updated', search: savedSearchDto(updated) }
}

export async function manageEmailContactAgent(
  env: Env,
  userId: string,
  input: {
    action: 'create' | 'update' | 'group_create' | 'group_update' | 'group_add' | 'group_remove'
    contactId?: string
    groupId?: string
    email?: string
    name?: string
    company?: string
    notes?: string
    starred?: boolean
    pinned?: boolean
    avatar?: string
    description?: string
  },
): Promise<Record<string, unknown>> {
  await assertEmailOwner(env, userId)
  if (input.action === 'create') {
    const parsed = parseEmailContactInput({
      email: input.email,
      name: input.name ?? '',
      company: input.company ?? '',
      notes: input.notes ?? '',
      starred: input.starred ?? false,
      pinned: input.pinned ?? false,
      avatar: input.avatar ?? '',
    })
    if (!parsed) throw ApiError.badRequest('The contact is not valid')
    if (await findEmailContactByEmail(env.DB, userId, normalizeContactEmail(parsed.email))) {
      throw new ApiError(409, 'email_contact_exists', 'That email address is already saved')
    }
    const created = await createEmailContact(env.DB, userId, parsed)
    return { status: 'created', contact: toEmailContact(created) }
  }
  if (input.action === 'update') {
    if (!input.contactId || !isValidId(input.contactId)) throw ApiError.badRequest('A contact id is required')
    if (!(await getEmailContact(env.DB, userId, input.contactId))) throw new ApiError(404, 'not_found', 'Contact not found')
    const patch = parseEmailContactPatch({
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.company !== undefined ? { company: input.company } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.starred !== undefined ? { starred: input.starred } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
    })
    if (!patch) throw ApiError.badRequest('The contact is not valid')
    if (patch.email !== undefined) {
      const existing = await findEmailContactByEmail(env.DB, userId, normalizeContactEmail(patch.email))
      if (existing && existing.id !== input.contactId) throw new ApiError(409, 'email_contact_exists', 'That email address is already saved')
    }
    const updated = await updateEmailContact(env.DB, userId, input.contactId, patch)
    if (!updated) throw new ApiError(404, 'not_found', 'Contact not found')
    return { status: 'updated', contact: toEmailContact(updated) }
  }
  if (input.action === 'group_create') {
    const parsed = parseEmailGroupInput({ name: input.name, description: input.description ?? '', starred: input.starred ?? false, pinned: input.pinned ?? false, avatar: input.avatar ?? '' })
    if (!parsed) throw ApiError.badRequest('The group is not valid')
    if (await findEmailGroupByName(env.DB, userId, parsed.name)) throw new ApiError(409, 'email_group_exists', 'A group with that name already exists')
    const created = await createEmailGroup(env.DB, userId, parsed)
    return { status: 'created', group: { ...toEmailGroup(created), members: [] } }
  }
  if (!input.groupId || !isValidId(input.groupId)) throw ApiError.badRequest('A group id is required')
  if (!(await getEmailGroup(env.DB, userId, input.groupId))) throw new ApiError(404, 'not_found', 'Group not found')
  if (input.action === 'group_update') {
    const patch = parseEmailGroupPatch({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.starred !== undefined ? { starred: input.starred } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
    })
    if (!patch) throw ApiError.badRequest('The group is not valid')
    if (patch.name !== undefined) {
      const existing = await findEmailGroupByName(env.DB, userId, patch.name)
      if (existing && existing.id !== input.groupId) throw new ApiError(409, 'email_group_exists', 'A group with that name already exists')
    }
    const updated = await updateEmailGroup(env.DB, userId, input.groupId, patch)
    if (!updated) throw new ApiError(404, 'not_found', 'Group not found')
    const group = await getEmailGroupWithMembers(env.DB, userId, input.groupId)
    return { status: 'updated', group }
  }
  if (!input.contactId || !isValidId(input.contactId)) throw ApiError.badRequest('A contact id is required')
  if (!(await getEmailContact(env.DB, userId, input.contactId))) throw new ApiError(404, 'not_found', 'Contact not found')
  if (input.action === 'group_add') {
    await addEmailGroupMember(env.DB, userId, input.groupId, input.contactId)
    return { status: 'added', groupId: input.groupId, contactId: input.contactId }
  }
  if (!(await removeEmailGroupMember(env.DB, userId, input.groupId, input.contactId))) {
    throw new ApiError(404, 'not_found', 'Group member not found')
  }
  return { status: 'removed', groupId: input.groupId, contactId: input.contactId }
}

export async function updateEmailSettingsAgent(
  env: Env,
  userId: string,
  input: {
    accountId?: string
    displayName?: string
    autoDraft?: boolean
    focusedInbox?: boolean
    agentSystemPrompt?: string
    vacation?: {
      enabled: boolean
      start?: string | number | null
      end?: string | number | null
      subject?: string
      body?: string
    }
  },
): Promise<Record<string, unknown>> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  return withSettingsLock(env, account.id, async () => {
  const fresh = await getEmailAccount(env.DB, userId, account.id)
  if (!fresh) throw new ApiError(404, 'email_account_not_found', 'Mailbox not found')
  const settings = readAccountSettings(fresh.settings)
  let changed = false
  if (input.autoDraft !== undefined) {
    settings.autoDraft = input.autoDraft
    changed = true
  }
  if (input.focusedInbox !== undefined) {
    settings.focusedInbox = input.focusedInbox
    changed = true
  }
  if (input.agentSystemPrompt !== undefined) {
    settings.agentSystemPrompt = input.agentSystemPrompt.trim().slice(0, 8000)
    changed = true
  }
  if (input.vacation !== undefined) {
    const current = vacationView(settings)
    const start = input.vacation.start === undefined ? current.start : timestamp(input.vacation.start, 'vacation start')
    const end = input.vacation.end === undefined ? current.end : timestamp(input.vacation.end, 'vacation end')
    const subject = input.vacation.subject === undefined ? current.subject : input.vacation.subject
    const body = input.vacation.body === undefined ? current.body : input.vacation.body
    if (subject.length > EMAIL_VACATION_SUBJECT_MAX_CHARS) throw ApiError.badRequest('The vacation subject is too long')
    if (body.length > EMAIL_VACATION_BODY_MAX_CHARS) throw ApiError.badRequest('The vacation body is too long')
    if (start !== null && end !== null && start > end) throw ApiError.badRequest('The vacation window is not valid')
    settings.vacation = normalizeEmailVacation({
      vacation: {
        enabled: input.vacation.enabled,
        start,
        end,
        subject: subject.trim(),
        body,
      },
    })
    changed = true
  }
  if (!changed) throw ApiError.badRequest('No mailbox settings were supplied')
  const displayName = input.displayName?.trim()
  const saved = await updateEmailAccount(env.DB, userId, fresh.id, {
    ...(displayName ? { displayName } : {}),
    settings,
  })
  if (!saved) throw new ApiError(404, 'email_account_not_found', 'Mailbox not found')
  return { status: 'updated', settings: settingsView(saved) }
  })
}

export async function prepareDeleteEmailAgent(
  env: Env,
  userId: string,
  input: EmailAgentDeleteInput,
): Promise<{ targetId: string; targetLabel: string }> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const mailbox = emailMailbox(env, account.id)
  if (input.kind === 'trash') return { targetId: 'trash', targetLabel: 'every message in Trash' }
  if (!input.id) throw ApiError.badRequest('An id is required')
  switch (input.kind) {
    case 'message': {
      const row = await mailbox.getEmail(input.id)
      if (!row) throw new ApiError(404, 'email_message_not_found', 'Email not found')
      const action = input.permanent ? 'permanently' : 'to Trash'
      return { targetId: row.id, targetLabel: `${row.recipient} - ${row.subject} (${action})` }
    }
    case 'folder': {
      const folder = matchFolder(await mailbox.getFolders(), input.id)
      if (!folder) throw new ApiError(404, 'email_folder_not_found', 'Folder not found')
      if (!folder.is_deletable) throw new ApiError(400, 'email_folder_not_deletable', 'System folders cannot be deleted')
      return { targetId: folder.id, targetLabel: folder.name }
    }
    case 'tag': {
      const tag = isValidId(input.id) ? await mailbox.getTag(input.id) : null
      if (!tag) throw new ApiError(404, 'not_found', 'Tag not found')
      return { targetId: tag.id, targetLabel: tag.name }
    }
    case 'rule': {
      const filter = isValidId(input.id) ? await mailbox.getFilter(input.id) : null
      if (!filter) throw new ApiError(404, 'not_found', 'Filter not found')
      return { targetId: filter.id, targetLabel: filter.name }
    }
    case 'template': {
      const template = isValidId(input.id) ? await mailbox.getTemplate(input.id) : null
      if (!template) throw new ApiError(404, 'not_found', 'Template not found')
      return { targetId: template.id, targetLabel: template.name }
    }
    case 'signature': {
      const signature = normalizeEmailSignatures(readAccountSettings(account.settings)).signatures.find((entry) => entry.id === input.id)
      if (!signature) throw new ApiError(404, 'not_found', 'Signature not found')
      return { targetId: signature.id, targetLabel: signature.name }
    }
    case 'search': {
      const search = isValidId(input.id) ? await mailbox.getSavedSearch(input.id) : null
      if (!search) throw new ApiError(404, 'not_found', 'Saved search not found')
      return { targetId: search.id, targetLabel: search.name }
    }
    case 'contact': {
      const contact = isValidId(input.id) ? await getEmailContact(env.DB, userId, input.id) : null
      if (!contact) throw new ApiError(404, 'not_found', 'Contact not found')
      return { targetId: contact.id, targetLabel: contact.name || contact.email }
    }
    case 'group': {
      const group = isValidId(input.id) ? await getEmailGroup(env.DB, userId, input.id) : null
      if (!group) throw new ApiError(404, 'not_found', 'Group not found')
      return { targetId: group.id, targetLabel: group.name }
    }
    default:
      throw ApiError.badRequest('The deletion kind is not supported')
  }
}

export async function deleteEmailAgent(
  env: Env,
  userId: string,
  input: EmailAgentDeleteInput,
): Promise<Record<string, unknown>> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const mailbox = emailMailbox(env, account.id)
  const kind = input.kind
  if (kind === 'trash') {
    const ids = await mailbox.emptyTrash()
    if (ids.length) await deleteEmailAttachmentsForMessages(env, userId, ids)
    return { status: 'emptied', deleted: ids.length }
  }
  if (!input.id) throw ApiError.badRequest('An id is required')
  if (kind === 'message') {
    const row = await mailbox.getEmail(input.id)
    if (!row) throw new ApiError(404, 'email_message_not_found', 'Email not found')
    if (input.permanent) {
      if (!(await mailbox.deleteEmail(input.id))) throw new ApiError(404, 'email_message_not_found', 'Email not found')
      await deleteEmailAttachmentsForMessages(env, userId, [input.id])
      return { status: 'deleted', emailId: input.id }
    }
    if (!(await mailbox.trashEmail(input.id))) throw new ApiError(404, 'email_message_not_found', 'Email not found')
    return { status: 'trashed', emailId: input.id }
  }
  if (kind === 'folder') {
    const folder = matchFolder(await mailbox.getFolders(), input.id)
    if (!folder) throw new ApiError(404, 'email_folder_not_found', 'Folder not found')
    if (!folder.is_deletable) throw new ApiError(400, 'email_folder_not_deletable', 'System folders cannot be deleted')
    const result = await mailbox.deleteFolder(folder.id, input.deleteEmails === true)
    if (!result) throw new ApiError(404, 'email_folder_not_found', 'Folder not found')
    if (result.deletedMessageIds.length) await deleteEmailAttachmentsForMessages(env, userId, result.deletedMessageIds)
    return { status: 'deleted', folderId: folder.id, deletedEmails: result.deletedMessageIds.length }
  }
  if (kind === 'tag') {
    if (!isValidId(input.id)) throw new ApiError(404, 'not_found', 'Tag not found')
    if (!(await mailbox.deleteTag(input.id))) throw new ApiError(404, 'not_found', 'Tag not found')
    return { status: 'deleted', tagId: input.id }
  }
  if (kind === 'rule') {
    if (!isValidId(input.id)) throw new ApiError(404, 'not_found', 'Filter not found')
    if (!(await mailbox.deleteFilter(input.id))) throw new ApiError(404, 'not_found', 'Filter not found')
    return { status: 'deleted', filterId: input.id }
  }
  if (kind === 'template') {
    if (!isValidId(input.id) || !(await mailbox.deleteTemplate(input.id))) throw new ApiError(404, 'not_found', 'Template not found')
    return { status: 'deleted', templateId: input.id }
  }
  if (kind === 'search') {
    if (!isValidId(input.id) || !(await mailbox.deleteSavedSearch(input.id))) throw new ApiError(404, 'not_found', 'Saved search not found')
    return { status: 'deleted', searchId: input.id }
  }
  if (kind === 'signature') {
    return withSettingsLock(env, account.id, async () => {
      const fresh = await getEmailAccount(env.DB, userId, account.id)
      if (!fresh) throw new ApiError(404, 'email_account_not_found', 'Mailbox not found')
      const settings = readAccountSettings(fresh.settings)
      const current = normalizeEmailSignatures(settings)
      const signatures = current.signatures.filter((signature) => signature.id !== input.id)
      if (signatures.length === current.signatures.length) throw new ApiError(404, 'not_found', 'Signature not found')
      settings.signatures = signatures
      if (settings.defaultSignatureId === input.id) {
        settings.defaultSignatureId = signatures.find((signature) => signature.enabled)?.id
      }
      const saved = await updateEmailAccount(env.DB, userId, fresh.id, { settings })
      if (!saved) throw new ApiError(404, 'email_account_not_found', 'Mailbox not found')
      return { status: 'deleted', signatureId: input.id, signatures: signatureView(readAccountSettings(saved.settings)).signatures }
    })
  }
  if (kind === 'contact') {
    if (!isValidId(input.id) || !(await deleteEmailContact(env.DB, userId, input.id))) throw new ApiError(404, 'not_found', 'Contact not found')
    return { status: 'deleted', contactId: input.id }
  }
  if (!isValidId(input.id) || !(await deleteEmailGroup(env.DB, userId, input.id))) throw new ApiError(404, 'not_found', 'Group not found')
  return { status: 'deleted', groupId: input.id }
}

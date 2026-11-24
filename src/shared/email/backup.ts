import { LIMITS } from '../constants'
import { utf8ByteLength } from '../text-utils'
import {
  EMAIL_ACCOUNT_SETTINGS_MAX_BYTES,
  EMAIL_BODY_MAX_BYTES,
  EMAIL_EXPORT_MAX_BYTES,
  EMAIL_EXPORT_MAX_MESSAGES,
  EMAIL_FOLDER_SEED_NAMES,
  EMAIL_SIGNATURE_NAME_MAX_CHARS,
  EMAIL_SIGNATURE_TEXT_MAX_CHARS,
  EMAIL_SIGNATURES_MAX,
  EMAIL_SUBJECT_MAX_CHARS,
  EMAIL_SYSTEM_FOLDERS,
  EMAIL_VACATION_BODY_MAX_CHARS,
  EMAIL_VACATION_SUBJECT_MAX_CHARS,
  type EmailAccountSettings,
  type EmailSignature,
  type EmailVacationSettings,
} from './model'
import {
  EMAIL_FILTER_MAX_RULES,
  EMAIL_FILTER_NAME_MAX_CHARS,
  parseEmailFilterActions,
  parseEmailFilterConditions,
  type EmailFilterAction,
  type EmailFilterCondition,
} from './rules'
import { EMAIL_SAVED_SEARCH_MAX, parseEmailSavedSearchInput } from './searches'
import { EMAIL_TEMPLATE_MAX, parseEmailTemplateInput } from './templates'
import { isValidEmailTagPath, normalizeEmailTagPath } from './tags'
import {
  parseEmailContactInput,
  parseEmailGroupInput,
  type EmailContactInput,
  type EmailGroupInput,
} from './contacts'
import { isValidEmailAddress } from './format'
import { organizerColorOrNull } from '../organizer-colors'

export const EMAIL_BACKUP_FORMAT = 'inkstone-email-backup'
export const EMAIL_BACKUP_VERSION = 2 as const
export type EmailBackupVersion = 1 | typeof EMAIL_BACKUP_VERSION
export const EMAIL_BACKUP_ATTACHMENTS_ROOT = 'email-attachments'
export const EMAIL_BACKUP_V1_MISSING_FIELDS = [
  'folders.parentId',
  'folders.color',
  'folders.sortOrder',
  'accounts.settings.signatures',
  'accounts.settings.defaultSignatureId',
  'accounts.settings.vacation',
  'accounts.settings.replyTo',
  'messages.snoozedUntil',
  'accounts.tags',
  'accounts.messageTags',
  'accounts.filters',
  'accounts.blockedSenders',
  'accounts.templates',
  'accounts.savedSearches',
  'contacts',
  'groups',
  'groupMembers',
] as const

export interface EmailBackupFolder {
  id: string
  name: string
  isDeletable: boolean
  createdAt: number
  parentId: string | null
  color: string | null
  sortOrder: number
}

export interface EmailBackupAttachment {
  id: string
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  contentId: string | null
  disposition: string | null
  objectKey: string
  storage: string
  locked: boolean
  createdAt: number
  folderId: string | null
  starred: boolean
  pinned: boolean
  tags: string[]
  sha256?: string
  missing?: boolean
}

export interface EmailBackupMessage {
  id: string
  folderId: string
  subject: string
  sender: string
  recipient: string
  cc: string | null
  bcc: string | null
  date: number
  receivedAt: number
  read: boolean
  starred: boolean
  important: boolean
  muted: boolean
  focused: boolean
  followUpAt: number | null
  snoozedUntil: number | null
  body: string
  bodySource: string | null
  inReplyTo: string | null
  emailReferences: string | null
  threadId: string | null
  messageId: string | null
  rawHeaders: string | null
  deliveryStatus: string | null
  deliveryError: string | null
  providerMessageId: string | null
  attachmentsSkipped: boolean
  hasAttachment: boolean
  size: number
  deletedAt: number | null
  createdAt: number
  updatedAt: number
  attachments: EmailBackupAttachment[]
}

export interface EmailBackupTag {
  id: string
  name: string
  color: string | null
  createdAt: number
}

export interface EmailBackupMessageTag {
  messageId: string
  tagId: string
  createdAt: number
}

export interface EmailBackupFilter {
  id: string
  name: string
  enabled: boolean
  sortOrder: number
  conditions: EmailFilterCondition[]
  actions: EmailFilterAction[]
  createdAt: number
}

export interface EmailBackupBlockedSender {
  address: string
  createdAt: number
}

export interface EmailBackupTemplate {
  id: string
  name: string
  subject: string
  body: string
  createdAt: number
  updatedAt: number
}

export interface EmailBackupSavedSearch {
  id: string
  name: string
  query: string
  createdAt: number
}

export interface EmailBackupAccount {
  id: string
  address: string
  displayName: string
  settings: EmailAccountSettings
  createdAt: number
  updatedAt: number
  folders: EmailBackupFolder[]
  messages: EmailBackupMessage[]
  tags: EmailBackupTag[]
  messageTags: EmailBackupMessageTag[]
  filters: EmailBackupFilter[]
  blockedSenders: EmailBackupBlockedSender[]
  templates: EmailBackupTemplate[]
  savedSearches: EmailBackupSavedSearch[]
}

export interface EmailBackupContact extends EmailContactInput {
  id: string
  usageCount: number
  lastUsedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface EmailBackupGroup extends EmailGroupInput {
  id: string
  createdAt: number
  updatedAt: number
}

export interface EmailBackupGroupMember {
  groupId: string
  contactId: string
  createdAt: number
}

export interface EmailBackupBundle {
  format: typeof EMAIL_BACKUP_FORMAT
  version: EmailBackupVersion
  exportedAt: string
  snapshot: string
  includesAttachments: boolean
  accounts: EmailBackupAccount[]
  contacts: EmailBackupContact[]
  groups: EmailBackupGroup[]
  groupMembers: EmailBackupGroupMember[]
  /** v1 is normalized to the v2 shape; this names everything the old file could not carry. */
  missingFields: string[]
}

const ID_RE = /^[0-9a-hjkmnp-tv-z]{26}$/
const STAMP_RE = /^\d{8}-\d{6}-\d{3}$/
const HASH_RE = /^[0-9a-f]{64}$/
const MIME_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/
const SIGNATURE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const SYSTEM_FOLDER_IDS = new Set<string>(EMAIL_SYSTEM_FOLDERS)
const RESERVED_FOLDER_NAMES = new Set(Object.values(EMAIL_FOLDER_SEED_NAMES).map((name) => name.toLowerCase()))
const RAW_HEADERS_MAX_CHARS = 1_000_000
const FILENAME_MAX_CHARS = 255
const SORT_ORDER_MAX = 1_000_000
const FOLDER_DEPTH_MAX = 5

export function backupEmailPath(snapshot: string, version: EmailBackupVersion = EMAIL_BACKUP_VERSION): string {
  if (version !== 1 && version !== EMAIL_BACKUP_VERSION) throw new Error('Unsupported email backup version')
  if (!STAMP_RE.test(snapshot)) throw new Error('Invalid backup snapshot name')
  return `email-${snapshot}.json`
}

export function backupEmailAttachmentPath(
  snapshot: string,
  accountId: string,
  messageId: string,
  attachmentId: string,
  filename: string,
): string {
  if (!STAMP_RE.test(snapshot)) throw new Error('Invalid backup snapshot name')
  if (!ID_RE.test(accountId) || !ID_RE.test(messageId) || !ID_RE.test(attachmentId)) {
    throw new Error('Invalid email backup attachment id')
  }
  return `${EMAIL_BACKUP_ATTACHMENTS_ROOT}/${snapshot}/${accountId}/${messageId}/${attachmentId}/${safeFilename(filename)}`
}

export function emailBackupAttachmentPrefix(snapshot: string): string {
  if (!STAMP_RE.test(snapshot)) throw new Error('Invalid backup snapshot name')
  return `${EMAIL_BACKUP_ATTACHMENTS_ROOT}/${snapshot}/`
}

export function parseEmailBackupBundle(value: unknown): EmailBackupBundle | null {
  if (!isRecord(value)) return null
  if (value.format !== EMAIL_BACKUP_FORMAT || (value.version !== 1 && value.version !== EMAIL_BACKUP_VERSION)) return null
  if (typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt))) return null
  if (typeof value.snapshot !== 'string' || !STAMP_RE.test(value.snapshot)) return null
  if (typeof value.includesAttachments !== 'boolean') return null
  if (!Array.isArray(value.accounts)) return null

  const version = value.version
  const accounts: EmailBackupAccount[] = []
  const accountIds = new Set<string>()
  const accountAddresses = new Set<string>()
  for (const raw of value.accounts) {
    if (!isRecord(raw)) return null
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id) || accountIds.has(raw.id)) return null
    if (typeof raw.address !== 'string' || !isValidEmailAddress(raw.address)) return null
    const normalizedAddress = raw.address.trim().toLowerCase()
    if (accountAddresses.has(normalizedAddress)) return null
    if (typeof raw.displayName !== 'string' || raw.displayName.length > 255) return null
    const settings = accountSettings(raw.settings)
    if (!settings) return null
    if (!isTimestamp(raw.createdAt) || !isTimestamp(raw.updatedAt)) return null
    if (!Array.isArray(raw.folders) || !Array.isArray(raw.messages)) return null

    const folders = parseFolders(raw.folders, version)
    if (!folders) return null
    const messages = parseMessages(raw.messages, folders, version, value.includesAttachments)
    if (!messages) return null
    const tags = parseTags(version === 1 ? [] : raw.tags)
    if (!tags) return null
    const messageTags = parseMessageTags(version === 1 ? [] : raw.messageTags, messages, tags)
    if (!messageTags) return null
    const filters = parseFilters(version === 1 ? [] : raw.filters)
    if (!filters) return null
    const blockedSenders = parseBlockedSenders(version === 1 ? [] : raw.blockedSenders)
    if (!blockedSenders) return null
    const templates = parseTemplates(version === 1 ? [] : raw.templates)
    if (!templates) return null
    const savedSearches = parseSavedSearches(version === 1 ? [] : raw.savedSearches)
    if (!savedSearches) return null

    accountIds.add(raw.id)
    accountAddresses.add(normalizedAddress)
    accounts.push({
      id: raw.id,
      address: raw.address,
      displayName: raw.displayName,
      settings,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      folders,
      messages,
      tags,
      messageTags,
      filters,
      blockedSenders,
      templates,
      savedSearches,
    })
  }

  const contacts = parseContacts(version === 1 ? [] : value.contacts)
  if (!contacts) return null
  const groups = parseGroups(version === 1 ? [] : value.groups)
  if (!groups) return null
  const groupMembers = parseGroupMembers(version === 1 ? [] : value.groupMembers, contacts, groups)
  if (!groupMembers) return null

  const messageCount = accounts.reduce((total, account) => total + account.messages.length, 0)
  if (messageCount > EMAIL_EXPORT_MAX_MESSAGES) return null
  const bundle: EmailBackupBundle = {
    format: EMAIL_BACKUP_FORMAT,
    version,
    exportedAt: value.exportedAt,
    snapshot: value.snapshot,
    includesAttachments: value.includesAttachments,
    accounts,
    contacts,
    groups,
    groupMembers,
    missingFields: version === 1 ? [...EMAIL_BACKUP_V1_MISSING_FIELDS] : [],
  }
  return utf8ByteLength(JSON.stringify(bundle)) <= EMAIL_EXPORT_MAX_BYTES ? bundle : null
}

export function safeFilename(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  const truncated = [...cleaned].slice(0, 120).join('').trim()
  return truncated || 'file'
}

function parseFolders(value: unknown[], version: EmailBackupVersion): EmailBackupFolder[] | null {
  const folders: EmailBackupFolder[] = []
  const ids = new Set<string>()
  const siblingNames = new Set<string>()
  for (const raw of value) {
    if (!isRecord(raw)) return null
    if (typeof raw.id !== 'string' || !isFolderId(raw.id) || ids.has(raw.id)) return null
    if (
      typeof raw.name !== 'string' ||
      !raw.name ||
      raw.name.length > LIMITS.folderNameMaxLength ||
      raw.name.trim() !== raw.name ||
      /[\u0000-\u001f\u007f/\\]/.test(raw.name)
    ) return null
    const system = SYSTEM_FOLDER_IDS.has(raw.id)
    if (!system && RESERVED_FOLDER_NAMES.has(raw.name.toLowerCase())) return null
    if (typeof raw.isDeletable !== 'boolean' || (system && raw.isDeletable)) return null
    if (!isFiniteNumber(raw.createdAt)) return null

    const parentId = version === 1 ? null : raw.parentId
    if (parentId !== null && (typeof parentId !== 'string' || !isFolderId(parentId) || parentId === raw.id)) return null
    if (system && parentId !== null) return null
    const color = version === 1 ? null : raw.color
    if (color !== null && organizerColorOrNull(color) === null) return null
    const sortOrder = version === 1 ? 0 : raw.sortOrder
    if (!isFiniteNumber(sortOrder) || sortOrder > SORT_ORDER_MAX) return null

    const siblingKey = `${parentId ?? ''}\u0000${raw.name.toLowerCase()}`
    if (siblingNames.has(siblingKey)) return null
    ids.add(raw.id)
    siblingNames.add(siblingKey)
    folders.push({
      id: raw.id,
      name: raw.name,
      isDeletable: raw.isDeletable,
      createdAt: raw.createdAt,
      parentId,
      color: color === null ? null : organizerColorOrNull(color),
      sortOrder,
    })
  }

  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  for (const folder of folders) {
    if (folder.parentId && !byId.has(folder.parentId)) return null
  }
  const depths = new Map<string, number>()
  const depthOf = (id: string): number => {
    const known = depths.get(id)
    if (known !== undefined) return known
    const folder = byId.get(id)!
    const depth = folder.parentId ? depthOf(folder.parentId) + 1 : 1
    depths.set(id, depth)
    return depth
  }
  const visiting = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false
    visiting.add(id)
    const parentId = byId.get(id)?.parentId
    if (parentId && !visit(parentId)) return false
    visiting.delete(id)
    return depthOf(id) <= FOLDER_DEPTH_MAX
  }
  return folders.every((folder) => visit(folder.id)) ? folders : null
}

function parseMessages(
  value: unknown[],
  folders: EmailBackupFolder[],
  version: EmailBackupVersion,
  includesAttachments: boolean,
): EmailBackupMessage[] | null {
  const folderIds = new Set(folders.map((folder) => folder.id))
  const messages: EmailBackupMessage[] = []
  const ids = new Set<string>()
  const attachmentIds = new Set<string>()
  for (const raw of value) {
    if (!isRecord(raw)) return null
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id) || ids.has(raw.id)) return null
    if (typeof raw.folderId !== 'string' || !folderIds.has(raw.folderId)) return null
    if (
      typeof raw.subject !== 'string' ||
      raw.subject.length > EMAIL_SUBJECT_MAX_CHARS ||
      typeof raw.sender !== 'string' ||
      typeof raw.recipient !== 'string'
    ) return null
    if (
      !isNullableString(raw.cc) ||
      !isNullableString(raw.bcc) ||
      !isNullableString(raw.bodySource) ||
      !isNullableString(raw.inReplyTo) ||
      !isNullableString(raw.emailReferences) ||
      !isNullableString(raw.threadId) ||
      !isNullableString(raw.messageId) ||
      !isNullableString(raw.rawHeaders) ||
      !isNullableString(raw.deliveryStatus) ||
      !isNullableString(raw.deliveryError) ||
      !isNullableString(raw.providerMessageId)
    ) return null
    if (raw.deliveryStatus !== null && raw.deliveryStatus !== 'pending' && raw.deliveryStatus !== 'sent' && raw.deliveryStatus !== 'failed') {
      return null
    }
    if (typeof raw.body !== 'string' || utf8ByteLength(raw.body) > EMAIL_BODY_MAX_BYTES) return null
    if (typeof raw.bodySource === 'string' && utf8ByteLength(raw.bodySource) > EMAIL_BODY_MAX_BYTES) return null
    if (typeof raw.rawHeaders === 'string' && raw.rawHeaders.length > RAW_HEADERS_MAX_CHARS) return null
    if (!isFiniteNumber(raw.date) || !isFiniteNumber(raw.receivedAt)) return null
    if (
      typeof raw.read !== 'boolean' ||
      typeof raw.starred !== 'boolean' ||
      typeof raw.attachmentsSkipped !== 'boolean' ||
      typeof raw.hasAttachment !== 'boolean'
    ) return null
    const important = raw.important === undefined ? false : raw.important
    const muted = raw.muted === undefined ? false : raw.muted
    const focused = raw.focused === undefined ? true : raw.focused
    const followUpAt = raw.followUpAt === undefined || raw.followUpAt === null ? null : raw.followUpAt
    const snoozedUntil = version === 1 ? null : raw.snoozedUntil
    if (typeof important !== 'boolean' || typeof muted !== 'boolean' || typeof focused !== 'boolean') return null
    if (followUpAt !== null && !isTimestamp(followUpAt)) return null
    if (snoozedUntil !== null && !isTimestamp(snoozedUntil)) return null
    if (!isFiniteNumber(raw.size) || !isTimestamp(raw.createdAt) || !isTimestamp(raw.updatedAt)) return null
    if (raw.deletedAt !== null && !isTimestamp(raw.deletedAt)) return null
    if (!Array.isArray(raw.attachments)) return null
    const attachments = parseAttachments(raw.attachments, version, includesAttachments, attachmentIds)
    if (!attachments) return null

    ids.add(raw.id)
    messages.push({
      id: raw.id,
      folderId: raw.folderId,
      subject: raw.subject,
      sender: raw.sender,
      recipient: raw.recipient,
      cc: raw.cc,
      bcc: raw.bcc,
      date: raw.date,
      receivedAt: raw.receivedAt,
      read: raw.read,
      starred: raw.starred,
      important,
      muted,
      focused,
      followUpAt,
      snoozedUntil,
      body: raw.body,
      bodySource: raw.bodySource,
      inReplyTo: raw.inReplyTo,
      emailReferences: raw.emailReferences,
      threadId: raw.threadId,
      messageId: raw.messageId,
      rawHeaders: raw.rawHeaders,
      deliveryStatus: raw.deliveryStatus,
      deliveryError: raw.deliveryError,
      providerMessageId: raw.providerMessageId,
      attachmentsSkipped: raw.attachmentsSkipped,
      hasAttachment: raw.hasAttachment,
      size: raw.size,
      deletedAt: raw.deletedAt,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      attachments,
    })
  }
  return messages
}

function parseAttachments(
  value: unknown[],
  version: EmailBackupVersion,
  includesAttachments: boolean,
  attachmentIds: Set<string>,
): EmailBackupAttachment[] | null {
  const attachments: EmailBackupAttachment[] = []
  for (const raw of value) {
    if (!isRecord(raw)) return null
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id) || attachmentIds.has(raw.id)) return null
    if (
      typeof raw.filename !== 'string' ||
      !raw.filename ||
      raw.filename.length > FILENAME_MAX_CHARS ||
      /[\u0000-\u001f]/.test(raw.filename) ||
      typeof raw.mime !== 'string' ||
      raw.mime.length > 255 ||
      !MIME_RE.test(raw.mime)
    ) return null
    if (!isFiniteNumber(raw.size) || raw.size > LIMITS.attachmentMaxBytes) return null
    if (
      (raw.width !== null && !isFiniteNumber(raw.width)) ||
      (raw.height !== null && !isFiniteNumber(raw.height)) ||
      !isNullableString(raw.contentId) ||
      !isNullableString(raw.disposition)
    ) return null
    if ((typeof raw.contentId === 'string' && raw.contentId.length > 128) ||
      (typeof raw.disposition === 'string' && raw.disposition.length > 64)) return null
    if (typeof raw.objectKey !== 'string' || !isEmailObjectKey(raw.objectKey)) return null
    if (raw.storage !== 'r2') return null
    if (typeof raw.locked !== 'boolean' || !isTimestamp(raw.createdAt)) return null
    if (raw.sha256 !== undefined && raw.sha256 !== null && (typeof raw.sha256 !== 'string' || !HASH_RE.test(raw.sha256))) {
      return null
    }
    if (raw.missing !== undefined && typeof raw.missing !== 'boolean') return null
    if (version === 2 && includesAttachments && raw.missing !== true && typeof raw.sha256 !== 'string') return null

    const folderId = version === 1 ? null : raw.folderId
    if (folderId !== null && (typeof folderId !== 'string' || !folderId || folderId.length > 255 || /[\u0000-\u001f]/.test(folderId))) {
      return null
    }
    const starred = version === 1 ? false : raw.starred
    const pinned = version === 1 ? false : raw.pinned
    if (typeof starred !== 'boolean' || typeof pinned !== 'boolean') return null
    const tags = version === 1 ? [] : raw.tags
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || !tag || tag.length > 255)) return null

    attachmentIds.add(raw.id)
    attachments.push({
      id: raw.id,
      filename: raw.filename,
      mime: raw.mime,
      size: raw.size,
      width: raw.width,
      height: raw.height,
      contentId: raw.contentId,
      disposition: raw.disposition,
      objectKey: raw.objectKey,
      storage: raw.storage,
      locked: raw.locked,
      createdAt: raw.createdAt,
      folderId,
      starred,
      pinned,
      tags: [...new Set(tags)],
      ...(typeof raw.sha256 === 'string' ? { sha256: raw.sha256 } : {}),
      ...(raw.missing === true ? { missing: true } : {}),
    })
  }
  return attachments
}

function parseTags(value: unknown): EmailBackupTag[] | null {
  if (!Array.isArray(value)) return null
  const tags: EmailBackupTag[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const raw of value) {
    if (!isRecord(raw)) return null
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id) || ids.has(raw.id)) return null
    if (typeof raw.name !== 'string') return null
    const name = normalizeEmailTagPath(raw.name)
    if (!isValidEmailTagPath(name) || names.has(name.toLowerCase())) return null
    const color = raw.color === undefined ? null : raw.color
    if (color !== null && organizerColorOrNull(color) === null) return null
    if (!isTimestamp(raw.createdAt)) return null
    ids.add(raw.id)
    names.add(name.toLowerCase())
    tags.push({ id: raw.id, name, color: color === null ? null : organizerColorOrNull(color), createdAt: raw.createdAt })
  }
  return tags
}

function parseMessageTags(
  value: unknown,
  messages: EmailBackupMessage[],
  tags: EmailBackupTag[],
): EmailBackupMessageTag[] | null {
  if (!Array.isArray(value)) return null
  const messageIds = new Set(messages.map((message) => message.id))
  const tagIds = new Set(tags.map((tag) => tag.id))
  const keys = new Set<string>()
  const links: EmailBackupMessageTag[] = []
  for (const raw of value) {
    if (!isRecord(raw)) return null
    if (typeof raw.messageId !== 'string' || !messageIds.has(raw.messageId)) return null
    if (typeof raw.tagId !== 'string' || !tagIds.has(raw.tagId)) return null
    const key = `${raw.messageId}\u0000${raw.tagId}`
    if (keys.has(key) || !isTimestamp(raw.createdAt)) return null
    keys.add(key)
    links.push({ messageId: raw.messageId, tagId: raw.tagId, createdAt: raw.createdAt })
  }
  return links
}

function parseFilters(value: unknown): EmailBackupFilter[] | null {
  if (!Array.isArray(value) || value.length > EMAIL_FILTER_MAX_RULES) return null
  const filters: EmailBackupFilter[] = []
  const ids = new Set<string>()
  for (const raw of value) {
    if (!isRecord(raw)) return null
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id) || ids.has(raw.id)) return null
    if (typeof raw.name !== 'string' || typeof raw.enabled !== 'boolean') return null
    const name = raw.name.trim()
    if (!name || name.length > EMAIL_FILTER_NAME_MAX_CHARS) return null
    if (!isFiniteNumber(raw.sortOrder) || raw.sortOrder > SORT_ORDER_MAX || !isTimestamp(raw.createdAt)) return null
    const conditions = parseEmailFilterConditions(raw.conditions)
    const actions = parseEmailFilterActions(raw.actions)
    if (!conditions || !actions) return null
    ids.add(raw.id)
    filters.push({
      id: raw.id,
      name,
      enabled: raw.enabled,
      sortOrder: raw.sortOrder,
      conditions,
      actions,
      createdAt: raw.createdAt,
    })
  }
  return filters
}

function parseBlockedSenders(value: unknown): EmailBackupBlockedSender[] | null {
  if (!Array.isArray(value)) return null
  const addresses = new Set<string>()
  const blocked: EmailBackupBlockedSender[] = []
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.address !== 'string' || !isValidEmailAddress(raw.address) || !isTimestamp(raw.createdAt)) {
      return null
    }
    const address = raw.address.trim().toLowerCase()
    if (addresses.has(address)) return null
    addresses.add(address)
    blocked.push({ address, createdAt: raw.createdAt })
  }
  return blocked
}

function parseTemplates(value: unknown): EmailBackupTemplate[] | null {
  if (!Array.isArray(value) || value.length > EMAIL_TEMPLATE_MAX) return null
  const templates: EmailBackupTemplate[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const raw of value) {
    if (!isRecord(raw)) return null
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id) || ids.has(raw.id)) return null
    const parsed = parseEmailTemplateInput(raw)
    if (!parsed || names.has(parsed.name.toLowerCase())) return null
    if (!isTimestamp(raw.createdAt) || !isTimestamp(raw.updatedAt)) return null
    ids.add(raw.id)
    names.add(parsed.name.toLowerCase())
    templates.push({ id: raw.id, ...parsed, createdAt: raw.createdAt, updatedAt: raw.updatedAt })
  }
  return templates
}

function parseSavedSearches(value: unknown): EmailBackupSavedSearch[] | null {
  if (!Array.isArray(value) || value.length > EMAIL_SAVED_SEARCH_MAX) return null
  const searches: EmailBackupSavedSearch[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const raw of value) {
    if (!isRecord(raw)) return null
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id) || ids.has(raw.id)) return null
    const parsed = parseEmailSavedSearchInput(raw)
    if (!parsed || names.has(parsed.name.toLowerCase()) || !isTimestamp(raw.createdAt)) return null
    ids.add(raw.id)
    names.add(parsed.name.toLowerCase())
    searches.push({ id: raw.id, ...parsed, createdAt: raw.createdAt })
  }
  return searches
}

function parseContacts(value: unknown): EmailBackupContact[] | null {
  if (!Array.isArray(value)) return null
  const contacts: EmailBackupContact[] = []
  const ids = new Set<string>()
  const emails = new Set<string>()
  for (const raw of value) {
    if (!isRecord(raw)) return null
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id) || ids.has(raw.id)) return null
    const parsed = parseEmailContactInput(raw)
    if (!parsed || emails.has(parsed.email.toLowerCase())) return null
    if (!isFiniteNumber(raw.usageCount) || (raw.lastUsedAt !== null && !isTimestamp(raw.lastUsedAt))) return null
    if (!isTimestamp(raw.createdAt) || !isTimestamp(raw.updatedAt)) return null
    ids.add(raw.id)
    emails.add(parsed.email.toLowerCase())
    contacts.push({
      id: raw.id,
      ...parsed,
      usageCount: raw.usageCount,
      lastUsedAt: raw.lastUsedAt,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    })
  }
  return contacts
}

function parseGroups(value: unknown): EmailBackupGroup[] | null {
  if (!Array.isArray(value)) return null
  const groups: EmailBackupGroup[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const raw of value) {
    if (!isRecord(raw)) return null
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id) || ids.has(raw.id)) return null
    const parsed = parseEmailGroupInput(raw)
    if (!parsed || names.has(parsed.name.toLowerCase())) return null
    if (!isTimestamp(raw.createdAt) || !isTimestamp(raw.updatedAt)) return null
    ids.add(raw.id)
    names.add(parsed.name.toLowerCase())
    groups.push({ id: raw.id, ...parsed, createdAt: raw.createdAt, updatedAt: raw.updatedAt })
  }
  return groups
}

function parseGroupMembers(
  value: unknown,
  contacts: EmailBackupContact[],
  groups: EmailBackupGroup[],
): EmailBackupGroupMember[] | null {
  if (!Array.isArray(value)) return null
  const contactIds = new Set(contacts.map((contact) => contact.id))
  const groupIds = new Set(groups.map((group) => group.id))
  const keys = new Set<string>()
  const members: EmailBackupGroupMember[] = []
  for (const raw of value) {
    if (!isRecord(raw)) return null
    if (typeof raw.groupId !== 'string' || !groupIds.has(raw.groupId)) return null
    if (typeof raw.contactId !== 'string' || !contactIds.has(raw.contactId)) return null
    const key = `${raw.groupId}\u0000${raw.contactId}`
    if (keys.has(key) || !isTimestamp(raw.createdAt)) return null
    keys.add(key)
    members.push({ groupId: raw.groupId, contactId: raw.contactId, createdAt: raw.createdAt })
  }
  return members
}

function accountSettings(value: unknown): EmailAccountSettings | null {
  if (value === undefined) return {}
  if (!isRecord(value)) return null
  const settings: EmailAccountSettings = {}
  if (value.signature !== undefined) {
    if (!isRecord(value.signature)) return null
    if (
      typeof value.signature.enabled !== 'boolean' ||
      typeof value.signature.text !== 'string' ||
      value.signature.text.length > EMAIL_SIGNATURE_TEXT_MAX_CHARS
    ) return null
    settings.signature = { enabled: value.signature.enabled, text: value.signature.text }
  }
  if (value.signatures !== undefined) {
    if (!Array.isArray(value.signatures) || value.signatures.length > EMAIL_SIGNATURES_MAX) return null
    const signatures: EmailSignature[] = []
    const ids = new Set<string>()
    for (const raw of value.signatures) {
      if (!isRecord(raw) || typeof raw.id !== 'string' || !SIGNATURE_ID_RE.test(raw.id) || ids.has(raw.id)) return null
      if (typeof raw.name !== 'string' || typeof raw.text !== 'string') return null
      const name = raw.name.trim()
      if (!name || name.length > EMAIL_SIGNATURE_NAME_MAX_CHARS || raw.text.length > EMAIL_SIGNATURE_TEXT_MAX_CHARS) return null
      if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return null
      ids.add(raw.id)
      signatures.push({ id: raw.id, name, text: raw.text, enabled: raw.enabled !== false })
    }
    settings.signatures = signatures
  }
  if (value.defaultSignatureId !== undefined) {
    if (typeof value.defaultSignatureId !== 'string') return null
    if (value.defaultSignatureId !== '' && !settings.signatures?.some((signature) => signature.id === value.defaultSignatureId)) return null
    settings.defaultSignatureId = value.defaultSignatureId
  }
  if (value.agentSystemPrompt !== undefined) {
    if (typeof value.agentSystemPrompt !== 'string' || value.agentSystemPrompt.length > 8000) return null
    settings.agentSystemPrompt = value.agentSystemPrompt
  }
  if (value.autoDraft !== undefined) {
    if (typeof value.autoDraft !== 'boolean') return null
    settings.autoDraft = value.autoDraft
  }
  if (value.focusedInbox !== undefined) {
    if (typeof value.focusedInbox !== 'boolean') return null
    settings.focusedInbox = value.focusedInbox
  }
  if (value.replyTo !== undefined) {
    if (typeof value.replyTo !== 'string' || value.replyTo.length > 320) return null
    const replyTo = value.replyTo.trim()
    if (replyTo && !isValidEmailAddress(replyTo)) return null
    settings.replyTo = replyTo
  }
  if (value.vacation !== undefined) {
    const vacation = parseVacation(value.vacation)
    if (!vacation) return null
    settings.vacation = vacation
  }
  if (utf8ByteLength(JSON.stringify(settings)) > EMAIL_ACCOUNT_SETTINGS_MAX_BYTES) return null
  return settings
}

function parseVacation(value: unknown): EmailVacationSettings | null {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return null
  if (value.subject !== undefined && typeof value.subject !== 'string') return null
  if (value.body !== undefined && typeof value.body !== 'string') return null
  if (typeof value.subject === 'string' && value.subject.length > EMAIL_VACATION_SUBJECT_MAX_CHARS) return null
  if (typeof value.body === 'string' && value.body.length > EMAIL_VACATION_BODY_MAX_CHARS) return null
  const start = vacationTimestamp(value.start)
  const end = vacationTimestamp(value.end)
  if (start === false || end === false || (start !== null && end !== null && start > end)) return null
  return {
    enabled: value.enabled,
    start,
    end,
    subject: typeof value.subject === 'string' ? value.subject.trim() : '',
    body: typeof value.body === 'string' ? value.body : '',
  }
}

function vacationTimestamp(value: unknown): number | null | false {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : false
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : false
  }
  return false
}

function isFolderId(value: string): boolean {
  return SYSTEM_FOLDER_IDS.has(value) || ID_RE.test(value)
}

function isEmailObjectKey(value: string): boolean {
  if (!value || value.length > 2048 || value.includes('\\')) return false
  const parts = value.split('/')
  return parts.length >= 3 &&
    parts[0] === 'mail' &&
    parts.every((part) => part !== '' && part !== '.' && part !== '..' && !/[\u0000-\u001f]/.test(part))
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

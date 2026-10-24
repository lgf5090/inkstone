import { LIMITS } from '../constants'
import { utf8ByteLength } from '../text-utils'
import {
  EMAIL_ACCOUNT_SETTINGS_MAX_BYTES,
  EMAIL_BODY_MAX_BYTES,
  EMAIL_SUBJECT_MAX_CHARS,
  EMAIL_SYSTEM_FOLDERS,
  type EmailAccountSettings,
} from './model'

export const EMAIL_BACKUP_FORMAT = 'inkstone-email-backup'
export const EMAIL_BACKUP_VERSION = 1
export const EMAIL_BACKUP_ATTACHMENTS_ROOT = 'email-attachments'

export interface EmailBackupFolder {
  id: string
  name: string
  isDeletable: boolean
  createdAt: number
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

export interface EmailBackupAccount {
  id: string
  address: string
  displayName: string
  settings: EmailAccountSettings
  createdAt: number
  updatedAt: number
  folders: EmailBackupFolder[]
  messages: EmailBackupMessage[]
}

export interface EmailBackupBundle {
  format: typeof EMAIL_BACKUP_FORMAT
  version: typeof EMAIL_BACKUP_VERSION
  exportedAt: string
  snapshot: string
  includesAttachments: boolean
  accounts: EmailBackupAccount[]
}

const ID_RE = /^[0-9a-hjkmnp-tv-z]{26}$/
const STAMP_RE = /^\d{8}-\d{6}-\d{3}$/
const HASH_RE = /^[0-9a-f]{64}$/
const SYSTEM_FOLDER_IDS = new Set<string>(EMAIL_SYSTEM_FOLDERS)
const RAW_HEADERS_MAX_CHARS = 1_000_000
const FILENAME_MAX_CHARS = 255

export function backupEmailPath(snapshot: string, version = EMAIL_BACKUP_VERSION): string {
  if (version !== EMAIL_BACKUP_VERSION) throw new Error('Unsupported email backup version')
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
  if (value.format !== EMAIL_BACKUP_FORMAT || value.version !== EMAIL_BACKUP_VERSION) return null
  if (typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt))) return null
  if (typeof value.snapshot !== 'string' || !STAMP_RE.test(value.snapshot)) return null
  if (typeof value.includesAttachments !== 'boolean') return null
  if (!Array.isArray(value.accounts)) return null

  const accounts: EmailBackupAccount[] = []
  const accountIds = new Set<string>()
  const accountAddresses = new Set<string>()
  for (const raw of value.accounts) {
    if (!isRecord(raw)) return null
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id) || accountIds.has(raw.id)) return null
    if (typeof raw.address !== 'string' || !raw.address || raw.address.length > 320) return null
    const normalizedAddress = raw.address.trim().toLowerCase()
    if (!normalizedAddress || accountAddresses.has(normalizedAddress)) return null
    if (typeof raw.displayName !== 'string' || raw.displayName.length > 255) return null
    const settings = accountSettings(raw.settings)
    if (!settings) return null
    if (!isTimestamp(raw.createdAt) || !isTimestamp(raw.updatedAt)) return null
    if (!Array.isArray(raw.folders) || !Array.isArray(raw.messages)) return null

    const folders = parseFolders(raw.folders)
    if (!folders) return null
    const messages = parseMessages(raw.messages, folders)
    if (!messages) return null

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
    })
  }

  return {
    format: EMAIL_BACKUP_FORMAT,
    version: EMAIL_BACKUP_VERSION,
    exportedAt: value.exportedAt,
    snapshot: value.snapshot,
    includesAttachments: value.includesAttachments,
    accounts,
  }
}

export function safeFilename(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  const truncated = [...cleaned].slice(0, 120).join('').trim()
  return truncated || 'file'
}

function parseFolders(value: unknown[]): EmailBackupFolder[] | null {
  const folders: EmailBackupFolder[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const raw of value) {
    if (!isRecord(raw)) return null
    if (typeof raw.id !== 'string' || !isFolderId(raw.id) || ids.has(raw.id)) return null
    if (
      typeof raw.name !== 'string' ||
      !raw.name ||
      raw.name.length > LIMITS.folderNameMaxLength ||
      raw.name.trim() !== raw.name ||
      /[\u0000-\u001f/\\]/.test(raw.name)
    ) return null
    const nameKey = raw.name.toLowerCase()
    if (names.has(nameKey)) return null
    if (typeof raw.isDeletable !== 'boolean' || !isFiniteNumber(raw.createdAt)) return null
    ids.add(raw.id)
    names.add(nameKey)
    folders.push({
      id: raw.id,
      name: raw.name,
      isDeletable: raw.isDeletable,
      createdAt: raw.createdAt,
    })
  }
  return folders
}

function parseMessages(value: unknown[], folders: EmailBackupFolder[]): EmailBackupMessage[] | null {
  const folderIds = new Set(folders.map((folder) => folder.id))
  const messages: EmailBackupMessage[] = []
  const ids = new Set<string>()
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
    if (typeof raw.body !== 'string' || utf8ByteLength(raw.body) > EMAIL_BODY_MAX_BYTES) return null
    if (
      typeof raw.bodySource === 'string' &&
      utf8ByteLength(raw.bodySource) > EMAIL_BODY_MAX_BYTES
    ) return null
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
    if (typeof important !== 'boolean' || typeof muted !== 'boolean' || typeof focused !== 'boolean') return null
    if (followUpAt !== null && !isTimestamp(followUpAt)) return null
    if (!isFiniteNumber(raw.size) || !isTimestamp(raw.createdAt) || !isTimestamp(raw.updatedAt)) return null
    if (raw.deletedAt !== null && !isTimestamp(raw.deletedAt)) return null
    if (!Array.isArray(raw.attachments)) return null
    const attachments = parseAttachments(raw.attachments)
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

function parseAttachments(value: unknown[]): EmailBackupAttachment[] | null {
  const attachments: EmailBackupAttachment[] = []
  const ids = new Set<string>()
  for (const raw of value) {
    if (!isRecord(raw)) return null
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id) || ids.has(raw.id)) return null
    if (
      typeof raw.filename !== 'string' ||
      !raw.filename ||
      raw.filename.length > FILENAME_MAX_CHARS ||
      /[\u0000-\u001f]/.test(raw.filename) ||
      typeof raw.mime !== 'string' ||
      !raw.mime ||
      raw.mime.length > 255
    ) return null
    if (!isFiniteNumber(raw.size) || raw.size > LIMITS.attachmentMaxBytes) return null
    if (
      (raw.width !== null && !isFiniteNumber(raw.width)) ||
      (raw.height !== null && !isFiniteNumber(raw.height)) ||
      !isNullableString(raw.contentId) ||
      !isNullableString(raw.disposition)
    ) return null
    if (typeof raw.objectKey !== 'string' || !isEmailObjectKey(raw.objectKey)) return null
    if (raw.storage !== 'r2') return null
    if (typeof raw.locked !== 'boolean' || !isTimestamp(raw.createdAt)) return null
    if (raw.sha256 !== undefined && raw.sha256 !== null && (typeof raw.sha256 !== 'string' || !HASH_RE.test(raw.sha256))) {
      return null
    }
    if (raw.missing !== undefined && typeof raw.missing !== 'boolean') return null

    ids.add(raw.id)
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
      ...(typeof raw.sha256 === 'string' ? { sha256: raw.sha256 } : {}),
      ...(raw.missing === true ? { missing: true } : {}),
    })
  }
  return attachments
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
      value.signature.text.length > 4000
    ) return null
    settings.signature = { enabled: value.signature.enabled, text: value.signature.text }
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
  if (utf8ByteLength(JSON.stringify(settings)) > EMAIL_ACCOUNT_SETTINGS_MAX_BYTES) return null
  return settings
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

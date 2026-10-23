import { LIMITS } from '@shared/constants'

export const EMAIL_SUBJECT_MAX_CHARS = 1000
export const EMAIL_BODY_MAX_BYTES = 5 * 1024 * 1024
export const EMAIL_INBOUND_MAX_BYTES = 25 * 1024 * 1024
export const EMAIL_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024
export const EMAIL_ATTACHMENT_QUOTA_BYTES = LIMITS.attachmentQuotaBytes
export const EMAIL_RECIPIENTS_MAX = 50
export const EMAIL_ACCOUNT_SETTINGS_MAX_BYTES = 64 * 1024
export const EMAIL_TRASH_RETENTION_DAYS = 30
export const EMAIL_AUTO_DRAFT_MAX_ATTEMPTS = 3
export const EMAIL_AUTO_DRAFT_LEASE_MS = 10 * 60 * 1000
export const EMAIL_SEND_RATE_LIMIT_HOUR = 20
export const EMAIL_SEND_RATE_LIMIT_DAY = 100
export const EMAIL_ATTACHMENT_R2_PREFIX = 'mail'
export const EMAIL_PAGE_SIZE = 25
export const EMAIL_MAX_PAGE_SIZE = 100
export const EMAIL_BATCH_MAX_MESSAGES = 100
export const EMAIL_SNOOZE_MAX_MS = 365 * 24 * 60 * 60 * 1000
export const EMAIL_SNOOZE_WAKE_BATCH = 200
export const EMAIL_SCHEDULE_MAX_MS = 365 * 24 * 60 * 60 * 1000
export const EMAIL_SCHEDULE_MAX_ATTEMPTS = 3
export const EMAIL_SCHEDULE_RETRY_MS = 5 * 60 * 1000
export const EMAIL_SCHEDULE_LEASE_MS = 10 * 60 * 1000
export const EMAIL_SCHEDULE_OPERATION_MAX_CHARS = 200

export const EMAIL_BATCH_ACTIONS = [
  'read',
  'unread',
  'star',
  'unstar',
  'move',
  'archive',
  'trash',
  'restore',
] as const

export type EmailBatchAction = (typeof EMAIL_BATCH_ACTIONS)[number]

export interface EmailBatchInput {
  ids: string[]
  action: EmailBatchAction
  folderId?: string
}

export interface EmailBatchResult {
  updated: number
}

export interface EmailSnoozeResult {
  id: string
  snoozedUntil: string
}

export const EMAIL_ATTACHMENT_CATEGORIES = [
  'images',
  'docs',
  'audio',
  'video',
  'archives',
  'code',
  'other',
] as const

export type EmailAttachmentCategory = (typeof EMAIL_ATTACHMENT_CATEGORIES)[number]

export const EMAIL_SYSTEM_FOLDERS = ['inbox', 'sent', 'draft', 'archive', 'trash', 'spam'] as const

export type EmailSystemFolder = (typeof EMAIL_SYSTEM_FOLDERS)[number]

export const EMAIL_SIDEBAR_FOLDERS: readonly EmailSystemFolder[] = ['inbox', 'sent', 'draft', 'archive', 'trash']

export const EMAIL_FOLDER_SEED_NAMES: Record<EmailSystemFolder, string> = {
  inbox: 'Inbox',
  sent: 'Sent',
  draft: 'Drafts',
  archive: 'Archive',
  trash: 'Trash',
  spam: 'Spam',
}

export type EmailDeliveryStatus = 'pending' | 'sent' | 'failed'

export type EmailAutoDraftStatus = 'queued' | 'running' | 'done' | 'skipped' | 'failed'

export type EmailAutoDraftReason =
  | 'no_model'
  | 'injection'
  | 'rate_limited'
  | 'model_error'
  | 'no_body'
  | 'duplicate'
  | 'scanner_unavailable'
  | 'account_missing'
  | 'message_missing'
  | 'disabled'
  | 'invalid_output'

export interface EmailSignatureSettings {
  enabled: boolean
  text: string
}

export interface EmailAccountSettings {
  signature?: EmailSignatureSettings
  agentSystemPrompt?: string
  autoDraft?: boolean
}

export interface EmailAccount {
  id: string
  address: string
  displayName: string
  settings: EmailAccountSettings
  createdAt: string
  updatedAt: string
}

export interface EmailFolder {
  id: string
  name: string
  isDeletable: boolean
  unreadCount: number
  parentId: string | null
  color: string | null
  sortOrder: number
}

export interface EmailFolderInput {
  name: string
  parentId?: string | null
  color?: string | null
}

export interface EmailFolderPatch {
  name?: string
  parentId?: string | null
  color?: string | null
  sortOrder?: number
}

export interface EmailTag {
  id: string
  name: string
  color: string | null
  count: number
}

export interface EmailTagInput {
  name: string
  color?: string | null
}

export interface EmailTagPatch {
  name?: string
  color?: string | null
}

export interface EmailMessageTagInput {
  tagId?: string
  path?: string
}

export interface EmailFolderStats {
  folderId: string
  total: number
  read: number
  unread: number
  starred: number
  withAttachments: number
}

export interface EmailDailyCount {
  date: string
  count: number
}

export interface EmailMailboxStats {
  total: number
  read: number
  unread: number
  starred: number
  withAttachments: number
  sent: number
  draft: number
  trash: number
  attachmentBytes: number
  folders: EmailFolderStats[]
  receivedLast7Days: EmailDailyCount[]
  sentLast7Days: EmailDailyCount[]
}

export interface EmailAttachment {
  id: string
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  contentId: string | null
  disposition: string | null
  url: string
  createdAt: string
}

export interface EmailSummary {
  id: string
  folderId: string
  subject: string
  sender: string
  recipient: string
  cc: string | null
  bcc: string | null
  date: string
  read: boolean
  starred: boolean
  threadId: string | null
  threadCount?: number
  threadUnreadCount?: number
  participants?: string
  needsReply?: boolean
  hasDraft?: boolean
  hasAttachment?: boolean
  snippet?: string | null
  deliveryStatus?: EmailDeliveryStatus | null
}

export interface EmailMessage extends EmailSummary {
  body: string
  bodySource: string | null
  inReplyTo: string | null
  references: string[]
  messageId: string | null
  rawHeaders: { key: string; value: string }[]
  attachments: EmailAttachment[]
  deliveryError?: string | null
  attachmentsSkipped?: boolean
  deletedAt?: string | null
}

export interface EmailListResponse {
  emails: EmailSummary[]
  totalCount: number
}

export interface EmailDraftInput {
  to: string
  cc?: string
  bcc?: string
  subject: string
  body: string
  bodyHtml: string
  inReplyTo?: string
  threadId?: string
  draftId?: string
}

export interface EmailSendInput extends EmailDraftInput {
  attachmentIds?: string[]
  operationId: string
}

export interface EmailSendResult {
  id: string
  status: EmailDeliveryStatus
  messageId?: string
  error?: string
}

export type EmailScheduledSendStatus = 'queued' | 'running' | 'sent' | 'failed' | 'cancelled'

export interface EmailScheduledSend {
  id: string
  accountId: string
  draftId: string
  sendAt: string
  status: EmailScheduledSendStatus
  attempts: number
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export interface EmailScheduledSendInput {
  sendAt: string | number
  operationId?: string
}

export interface EmailConfig {
  domains: string[]
  addresses: string[]
  attachmentsAvailable: boolean
  sendingAvailable: boolean
  autoDraftAvailable: boolean
  canCreate: boolean
}

export interface EmailSearchQuery {
  query: string
  from?: string
  to?: string
  subject?: string
  folder?: string
  isRead?: boolean
  isStarred?: boolean
  hasAttachment?: boolean
  tag?: string
  dateStart?: string
  dateEnd?: string
}

export type EmailErrorCode =
  | 'email_account_not_found'
  | 'email_account_exists'
  | 'email_address_invalid'
  | 'email_address_reserved'
  | 'email_domain_not_allowed'
  | 'email_forbidden'
  | 'email_mailbox_unavailable'
  | 'email_folder_not_found'
  | 'email_folder_exists'
  | 'email_folder_reserved'
  | 'email_folder_not_deletable'
  | 'email_message_not_found'
  | 'email_attachment_not_found'
  | 'email_attachment_locked'
  | 'email_attachment_too_large'
  | 'email_settings_invalid'
  | 'email_draft_invalid'
  | 'email_send_unavailable'
  | 'email_send_failed'
  | 'email_rate_limited'
  | 'email_quota_exceeded'
  | 'email_not_in_trash'
  | 'email_not_retryable'
  | 'email_auto_draft_unavailable'
  | 'email_export_too_large'
  | 'email_backup_no_target'

export function isEmailSystemFolder(value: unknown): value is EmailSystemFolder {
  return typeof value === 'string' && (EMAIL_SYSTEM_FOLDERS as readonly string[]).includes(value)
}

export function isEmailAttachmentCategory(value: unknown): value is EmailAttachmentCategory {
  return typeof value === 'string' && (EMAIL_ATTACHMENT_CATEGORIES as readonly string[]).includes(value)
}

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'swift', 'rb', 'php',
  'c', 'h', 'cpp', 'hpp', 'cs', 'css', 'scss', 'html', 'htm', 'xml', 'json', 'yaml', 'yml', 'toml',
  'sh', 'sql', 'md', 'txt', 'log', 'ini', 'conf', 'env', 'diff', 'patch',
])

const ARCHIVE_EXTENSIONS = new Set(['zip', 'zipx', '7z', 'rar', 'tar', 'gz', 'gzip', 'tgz', 'bz2', 'xz', 'zst', 'cab', 'iso', 'jar'])

export function emailAttachmentCategory(mime: string, filename: string): EmailAttachmentCategory {
  const type = mime.toLowerCase()
  const extension = filename.toLowerCase().split('.').pop() ?? ''
  if (type.startsWith('image/')) return 'images'
  if (type.startsWith('audio/')) return 'audio'
  if (type.startsWith('video/')) return 'video'
  if (ARCHIVE_EXTENSIONS.has(extension) || type.includes('zip') || type.includes('archive') || type.includes('compressed')) return 'archives'
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  if (type.startsWith('text/') || type.includes('pdf') || type.includes('word') || type.includes('document') || type.includes('sheet') || type.includes('presentation')) return 'docs'
  return 'other'
}


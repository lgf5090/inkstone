import type { EmailAccountSettings } from './model'

export const EMAIL_BACKUP_FORMAT = 'inkstone-email-backup'
export const EMAIL_BACKUP_VERSION = 1

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
  accounts: EmailBackupAccount[]
}

export function backupEmailPath(snapshot: string, version = EMAIL_BACKUP_VERSION): string {
  return `email-${snapshot}-v${version}.json`
}

export function parseEmailBackupBundle(value: unknown): EmailBackupBundle | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.format !== EMAIL_BACKUP_FORMAT || row.version !== EMAIL_BACKUP_VERSION) return null
  if (!Array.isArray(row.accounts)) return null
  return value as EmailBackupBundle
}

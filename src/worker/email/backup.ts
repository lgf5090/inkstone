import { LIMITS } from '@shared/constants'
import {
  backupEmailAttachmentPath,
  backupEmailPath,
  EMAIL_BACKUP_FORMAT,
  EMAIL_BACKUP_VERSION,
  parseEmailBackupBundle,
  type EmailBackupAccount,
  type EmailBackupAttachment,
  type EmailBackupBundle,
  type EmailBackupMessage,
} from '@shared/email/backup'
import { putAttachmentObject } from '../attachments/backend'
import type { Env } from '../env'
import { sha256Hex } from '../lib/encoding'
import { storedObject } from '../lib/json'
import { ApiError } from '../lib/errors'
import {
  findEmailAccountByAddress,
  getEmailAccount,
  listEmailAccounts,
  type EmailAccountRow,
} from './account-store'
import { emailMailbox } from './mailbox-stub'
import { emailAttachmentObjectKey } from '../attachments/keys'
import { assertEmailOwner } from './tools'

export interface EmailBackupFile {
  path: string
  byteLength: number
  sha256: string
  contentType: string
  kind: 'email' | 'email-attachment'
  open: () => Promise<ReadableStream<Uint8Array>>
}

export interface ReadBackupEmailOptions {
  includeAttachments: boolean
  snapshot: string
  accountId?: string
}

export interface ReadBackupEmailResult {
  file: EmailBackupFile | null
  attachments: EmailBackupFile[]
  includesAttachments: boolean
  accountCount: number
  messageCount: number
  attachmentCount: number
}

export interface EmailBackupArchive {
  bundle: EmailBackupBundle
  attachments: ReadonlyMap<string, Uint8Array>
}

export interface EmailRestoreSummary {
  accounts: number
  createdAccounts: number
  skippedAccounts: number
  folders: number
  createdFolders: number
  skippedFolders: number
  messages: number
  createdMessages: number
  skippedMessages: number
  attachments: number
  createdAttachments: number
  skippedAttachments: number
  restoredAttachmentBytes: number
  missingAttachments: number
  warnings: string[]
}

interface EmailAttachmentRow {
  id: string
  email_id: string | null
  account_id: string | null
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  content_id: string | null
  disposition: string | null
  object_key: string
  storage: string
  locked: number
  created_at: number
}

interface EmailMessageRow {
  id: string
  folder_id: string
  subject: string
  sender: string
  recipient: string
  cc: string | null
  bcc: string | null
  date: number
  received_at: number
  read: number
  starred: number
  body: string
  body_source: string | null
  in_reply_to: string | null
  email_references: string | null
  thread_id: string | null
  message_id: string | null
  raw_headers: string | null
  delivery_status: string | null
  delivery_error: string | null
  provider_message_id: string | null
  attachments_skipped: number
  has_attachment: number
  size: number
  deleted_at: number | null
  created_at: number
  updated_at: number
}

const HASH_RE = /^[0-9a-f]{64}$/
const encoder = new TextEncoder()

export async function readBackupEmail(
  env: Env,
  userId: string,
  options: ReadBackupEmailOptions,
): Promise<ReadBackupEmailResult> {
  const accounts = await selectedAccounts(env.DB, userId, options.accountId)
  if (!accounts.length) {
    return {
      file: null,
      attachments: [],
      includesAttachments: options.includeAttachments,
      accountCount: 0,
      messageCount: 0,
      attachmentCount: 0,
    }
  }
  if (options.includeAttachments && !env.FILES) {
    throw new ApiError(503, 'storage_unavailable', 'Email attachments require R2 storage')
  }

  const attachmentFiles: EmailBackupFile[] = []
  const backupAccounts: EmailBackupAccount[] = []
  let messageCount = 0
  let attachmentCount = 0
  let attachmentBytes = 0

  for (const account of accounts) {
    const mailbox = emailMailbox(env, account.id)
    const folderRows = await mailbox.getFolders()
    const messageRows = await mailbox.listAllEmails()
    const attachmentsByMessage = await loadAccountAttachments(env.DB, userId, account.id)
    const folders = folderRows.map((folder) => ({
      id: folder.id,
      name: folder.name,
      isDeletable: folder.is_deletable === 1,
      createdAt: folder.created_at,
    }))

    const messages: EmailBackupMessage[] = []
    for (const row of messageRows) {
      const rows = attachmentsByMessage.get(row.id) ?? []
      const attachments: EmailBackupAttachment[] = []
      for (const attachment of rows) {
        attachmentCount++
        const path = backupEmailAttachmentPath(
          options.snapshot,
          account.id,
          row.id,
          attachment.id,
          attachment.filename,
        )
        const meta: EmailBackupAttachment = {
          id: attachment.id,
          filename: attachment.filename,
          mime: attachment.mime,
          size: attachment.size,
          width: attachment.width,
          height: attachment.height,
          contentId: attachment.content_id,
          disposition: attachment.disposition,
          objectKey: attachment.object_key,
          storage: attachment.storage,
          locked: attachment.locked === 1,
          createdAt: attachment.created_at,
        }
        if (options.includeAttachments) {
          attachmentBytes += attachment.size
          if (attachmentBytes > LIMITS.attachmentQuotaBytes) {
            throw new ApiError(
              413,
              'email_export_too_large',
              `Email attachments exceed the ${LIMITS.attachmentQuotaBytes}-byte account budget`,
            )
          }
          const object = await env.FILES!.head(attachment.object_key)
          if (!object) {
            meta.missing = true
          } else {
            if (object.size !== attachment.size) {
              throw new Error(`Email attachment size changed while the backup was running: ${attachment.filename}`)
            }
            const sha256 = await attachmentSha256(env, attachment, object.customMetadata?.sha256)
            meta.sha256 = sha256
            attachmentFiles.push({
              path,
              byteLength: attachment.size,
              sha256,
              contentType: attachment.mime,
              kind: 'email-attachment',
              open: () => openEmailAttachment(env, attachment),
            })
          }
        }
        attachments.push(meta)
      }
      messages.push(toBackupMessage(row, attachments))
    }

    backupAccounts.push({
      id: account.id,
      address: account.address,
      displayName: account.display_name,
      settings: parseStoredSettings(account.settings),
      createdAt: account.created_at,
      updatedAt: account.updated_at,
      folders,
      messages,
    })
    messageCount += messages.length
  }

  const bundle: EmailBackupBundle = {
    format: EMAIL_BACKUP_FORMAT,
    version: EMAIL_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    snapshot: options.snapshot,
    includesAttachments: options.includeAttachments,
    accounts: backupAccounts,
  }
  const bytes = encoder.encode(JSON.stringify(bundle))
  const file: EmailBackupFile = {
    path: backupEmailPath(options.snapshot),
    byteLength: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    contentType: 'application/json; charset=utf-8',
    kind: 'email',
    open: async () => streamBytes(bytes),
  }
  return {
    file,
    attachments: attachmentFiles,
    includesAttachments: options.includeAttachments,
    accountCount: accounts.length,
    messageCount,
    attachmentCount,
  }
}

export async function applyBackupEmail(
  env: Env,
  userId: string,
  archive: EmailBackupArchive,
): Promise<EmailRestoreSummary> {
  await assertEmailOwner(env, userId)
  const bundle = parseEmailBackupBundle(archive.bundle)
  if (!bundle) throw ApiError.badRequest('The email backup is not valid')
  const summary = emptySummary()
  const declared = bundle.includesAttachments ? declaredAttachmentPaths(bundle) : new Map<string, true>()
  for (const path of archive.attachments.keys()) {
    if (!declared.has(path.toLowerCase())) {
      throw ApiError.badRequest(`The email attachment is not listed in the backup: ${path}`)
    }
  }
  const existingAttachmentIds = await loadExistingAttachmentIds(env.DB, userId)

  for (const account of bundle.accounts) {
    summary.accounts++
    const owner = await env.DB.prepare(
      `SELECT user_id FROM email_accounts WHERE id = ?1`,
    ).bind(account.id).first<{ user_id: string }>()
    if (owner && owner.user_id !== userId) {
      throw ApiError.badRequest('The email backup contains an account owned by another user')
    }
    const existing = await getEmailAccount(env.DB, userId, account.id)
    if (existing) {
      summary.skippedAccounts++
    } else {
      const addressOwner = await findEmailAccountByAddress(env.DB, account.address.trim().toLowerCase())
      if (addressOwner) {
        summary.skippedAccounts++
        addWarning(summary, `The mailbox ${account.address} is already in use`)
        continue
      }
      await env.DB.prepare(
        `INSERT INTO email_accounts (
           id, user_id, address, address_normalized, display_name, settings, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(
        account.id,
        userId,
        account.address,
        account.address.trim().toLowerCase(),
        account.displayName,
        JSON.stringify(account.settings),
        account.createdAt,
        account.updatedAt,
      ).run()
      summary.createdAccounts++
    }

    const mailbox = emailMailbox(env, account.id)
    const folderMap = await restoreFolders(mailbox, account, summary)
    for (const message of account.messages) {
      summary.messages++
      const folderId = folderMap.get(message.folderId) ?? message.folderId
      const inserted = await mailbox.importEmail({
        id: message.id,
        folderId,
        subject: message.subject,
        sender: message.sender,
        recipient: message.recipient,
        cc: message.cc,
        bcc: message.bcc,
        date: message.date,
        receivedAt: message.receivedAt,
        read: message.read,
        starred: message.starred,
        body: message.body,
        bodySource: message.bodySource,
        inReplyTo: message.inReplyTo,
        emailReferences: message.emailReferences,
        threadId: message.threadId,
        messageId: message.messageId,
        rawHeaders: message.rawHeaders,
        deliveryStatus: message.deliveryStatus,
        deliveryError: message.deliveryError,
        providerMessageId: message.providerMessageId,
        attachmentsSkipped: message.attachmentsSkipped,
        hasAttachment: message.hasAttachment,
        size: message.size,
        deletedAt: message.deletedAt,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      })
      if (inserted) summary.createdMessages++
      else summary.skippedMessages++

      for (const attachment of message.attachments) {
        summary.attachments++
        if (existingAttachmentIds.has(attachment.id)) {
          summary.skippedAttachments++
          continue
        }
        const path = backupEmailAttachmentPath(
          bundle.snapshot,
          account.id,
          message.id,
          attachment.id,
          attachment.filename,
        )
        const bytes = archive.attachments.get(path.toLowerCase())
        const objectKey = emailAttachmentObjectKey({
          user_id: userId,
          id: attachment.id,
          mime: attachment.mime,
          filename: attachment.filename,
        })
        if (attachment.missing === true) summary.missingAttachments++
        else if (bundle.includesAttachments && !bytes) summary.missingAttachments++
        if (bytes) {
          const digest = await sha256Hex(bytes)
          if (bytes.byteLength !== attachment.size) {
            throw ApiError.badRequest(`The email attachment size does not match: ${attachment.filename}`)
          }
          if (attachment.sha256 && digest !== attachment.sha256) {
            throw ApiError.badRequest(`The email attachment checksum does not match: ${attachment.filename}`)
          }
          if (!env.FILES) {
            throw new ApiError(503, 'storage_unavailable', 'Email attachments require R2 storage')
          }
          await putAttachmentObject(env, 'r2', objectKey, bytes, {
            userId,
            objectId: attachment.id,
            kind: 'attachment',
            filename: attachment.filename,
            mime: attachment.mime,
            sha256: digest,
          })
          summary.restoredAttachmentBytes += bytes.byteLength
        }
        const insertedAttachment = await insertAttachment(
          env,
          userId,
          account.id,
          message.id,
          attachment,
          objectKey,
        )
        if (insertedAttachment) {
          summary.createdAttachments++
          existingAttachmentIds.add(attachment.id)
        } else {
          summary.skippedAttachments++
        }
      }
    }
  }

  return summary
}

async function selectedAccounts(
  db: D1Database,
  userId: string,
  accountId?: string,
): Promise<EmailAccountRow[]> {
  if (!accountId) return listEmailAccounts(db, userId)
  const account = await getEmailAccount(db, userId, accountId)
  if (!account) throw new ApiError(404, 'email_account_not_found', 'Mailbox not found')
  return [account]
}

async function loadAccountAttachments(
  db: D1Database,
  userId: string,
  accountId: string,
): Promise<Map<string, EmailAttachmentRow[]>> {
  const { results } = await db.prepare(
    `SELECT id, email_id, account_id, filename, mime, size, width, height, content_id,
            disposition, object_key, storage, locked, created_at
       FROM email_attachments
      WHERE user_id = ?1 AND account_id = ?2 AND email_id IS NOT NULL
      ORDER BY created_at ASC, id ASC`,
  ).bind(userId, accountId).all<EmailAttachmentRow>()
  const byMessage = new Map<string, EmailAttachmentRow[]>()
  for (const row of results) {
    if (!row.email_id) continue
    const list = byMessage.get(row.email_id) ?? []
    list.push(row)
    byMessage.set(row.email_id, list)
  }
  return byMessage
}

async function attachmentSha256(
  env: Env,
  attachment: EmailAttachmentRow,
  declared: string | undefined,
): Promise<string> {
  if (declared && HASH_RE.test(declared)) return declared
  const object = await env.FILES!.get(attachment.object_key)
  if (!object) throw new Error(`Email attachment data is missing: ${attachment.filename}`)
  const bytes = new Uint8Array(await object.arrayBuffer())
  if (bytes.byteLength !== attachment.size) {
    throw new Error(`Email attachment size changed while the backup was running: ${attachment.filename}`)
  }
  return sha256Hex(bytes)
}

async function openEmailAttachment(
  env: Env,
  attachment: EmailAttachmentRow,
): Promise<ReadableStream<Uint8Array>> {
  if (!env.FILES) throw new Error('R2 attachment storage is not configured')
  const object = await env.FILES.get(attachment.object_key)
  if (!object) throw new Error(`Email attachment data is missing: ${attachment.filename}`)
  if (object.size !== attachment.size) {
    await object.body.cancel().catch((error) => {
      console.warn('[inkstone] email attachment stream could not be cancelled:', (error as Error).message)
    })
    throw new Error(`Email attachment size changed while the backup was running: ${attachment.filename}`)
  }
  return object.body
}

function toBackupMessage(
  row: EmailMessageRow,
  attachments: EmailBackupAttachment[],
): EmailBackupMessage {
  return {
    id: row.id,
    folderId: row.folder_id,
    subject: row.subject,
    sender: row.sender,
    recipient: row.recipient,
    cc: row.cc,
    bcc: row.bcc,
    date: row.date,
    receivedAt: row.received_at,
    read: row.read === 1,
    starred: row.starred === 1,
    body: row.body,
    bodySource: row.body_source,
    inReplyTo: row.in_reply_to,
    emailReferences: row.email_references,
    threadId: row.thread_id,
    messageId: row.message_id,
    rawHeaders: row.raw_headers,
    deliveryStatus: row.delivery_status,
    deliveryError: row.delivery_error,
    providerMessageId: row.provider_message_id,
    attachmentsSkipped: row.attachments_skipped === 1,
    hasAttachment: row.has_attachment === 1,
    size: row.size,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachments,
  }
}

function parseStoredSettings(raw: string): EmailBackupAccount['settings'] {
  return storedObject(raw) as EmailBackupAccount['settings']
}

function emptySummary(): EmailRestoreSummary {
  return {
    accounts: 0,
    createdAccounts: 0,
    skippedAccounts: 0,
    folders: 0,
    createdFolders: 0,
    skippedFolders: 0,
    messages: 0,
    createdMessages: 0,
    skippedMessages: 0,
    attachments: 0,
    createdAttachments: 0,
    skippedAttachments: 0,
    restoredAttachmentBytes: 0,
    missingAttachments: 0,
    warnings: [],
  }
}

async function restoreFolders(
  mailbox: ReturnType<typeof emailMailbox>,
  account: EmailBackupAccount,
  summary: EmailRestoreSummary,
): Promise<Map<string, string>> {
  const existing = await mailbox.getFolders()
  const byId = new Map(existing.map((folder) => [folder.id, folder.id]))
  const byName = new Map(existing.map((folder) => [folder.name.toLowerCase(), folder.id]))
  const mapping = new Map<string, string>()
  for (const folder of account.folders) {
    summary.folders++
    const exact = byId.get(folder.id)
    if (exact) {
      mapping.set(folder.id, exact)
      summary.skippedFolders++
      continue
    }
    const named = byName.get(folder.name.toLowerCase())
    if (named) {
      mapping.set(folder.id, named)
      summary.skippedFolders++
      continue
    }
    const created = await mailbox.importFolder({
      id: folder.id,
      name: folder.name,
      isDeletable: folder.isDeletable,
      createdAt: folder.createdAt,
    })
    if (created) {
      mapping.set(folder.id, folder.id)
      byId.set(folder.id, folder.id)
      byName.set(folder.name.toLowerCase(), folder.id)
      summary.createdFolders++
    } else {
      const refreshed = await mailbox.getFolders()
      const match = refreshed.find((row) => row.id === folder.id) ??
        refreshed.find((row) => row.name.toLowerCase() === folder.name.toLowerCase())
      if (match) mapping.set(folder.id, match.id)
      summary.skippedFolders++
    }
  }
  return mapping
}

function declaredAttachmentPaths(bundle: EmailBackupBundle): Map<string, true> {
  const paths = new Map<string, true>()
  for (const account of bundle.accounts) {
    for (const message of account.messages) {
      for (const attachment of message.attachments) {
        const path = backupEmailAttachmentPath(
          bundle.snapshot,
          account.id,
          message.id,
          attachment.id,
          attachment.filename,
        )
        if (paths.has(path.toLowerCase())) {
          throw ApiError.badRequest(`The email backup contains a duplicate attachment path: ${path}`)
        }
        paths.set(path.toLowerCase(), true)
      }
    }
  }
  return paths
}

async function loadExistingAttachmentIds(db: D1Database, userId: string): Promise<Set<string>> {
  const { results } = await db.prepare(
    `SELECT id FROM email_attachments WHERE user_id = ?1`,
  ).bind(userId).all<{ id: string }>()
  return new Set(results.map((row) => row.id))
}

async function insertAttachment(
  env: Env,
  userId: string,
  accountId: string,
  messageId: string,
  attachment: EmailBackupAttachment,
  objectKey: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO email_attachments (
       id, user_id, account_id, email_id, filename, mime, size, width, height,
       content_id, disposition, object_key, storage, folder_id, is_starred,
       is_pinned, tags, locked, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'r2', NULL, 0, 0, '[]', ?13, ?14)`,
  ).bind(
    attachment.id,
    userId,
    accountId,
    messageId,
    attachment.filename,
    attachment.mime,
    attachment.size,
    attachment.width,
    attachment.height,
    attachment.contentId,
    attachment.disposition,
    objectKey,
    attachment.locked ? 1 : 0,
    attachment.createdAt,
  ).run()
  return Number(result.meta.changes ?? 0) > 0
}

function addWarning(summary: EmailRestoreSummary, message: string): void {
  if (summary.warnings.length < 100) summary.warnings.push(message)
}

function streamBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

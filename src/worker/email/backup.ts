import { LIMITS } from '@shared/constants'
import {
  backupEmailAttachmentPath,
  backupEmailPath,
  backupEmailRawMimePath,
  EMAIL_BACKUP_FORMAT,
  EMAIL_BACKUP_VERSION,
  parseEmailBackupBundle,
  type EmailBackupAccount,
  type EmailBackupAttachment,
  type EmailBackupBlockedSender,
  type EmailBackupBundle,
  type EmailBackupContact,
  type EmailBackupFilter,
  type EmailBackupFolder,
  type EmailBackupGroup,
  type EmailBackupGroupMember,
  type EmailBackupMessage,
  type EmailBackupMessageTag,
  type EmailBackupRawMime,
  type EmailBackupSavedSearch,
  type EmailBackupTag,
  type EmailBackupTemplate,
} from '@shared/email/backup'
import { EMAIL_EXPORT_MAX_BYTES, EMAIL_EXPORT_MAX_MESSAGES, type EmailAccountSettings } from '@shared/email/model'
import { emailAttachmentObjectKey } from '../attachments/keys'
import type { Env } from '../env'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import {
  hasReasonableImageDimensions,
  readImageSize,
  safeAttachmentMime,
} from '../lib/image'
import { persistEmailAttachment, sanitizeAttachmentFilename } from '../attachments/storage'
import {
  findEmailAccountByAddress,
  getEmailAccount,
  listEmailAccounts,
  readAccountSettings,
  type EmailAccountRow,
} from './account-store'
import { validateMailboxAddress } from './address-validation'
import { effectiveEmailDomains } from './deployment'
import { emailMailbox } from './mailbox-stub'
import {
  getEmailRawMimeOwner,
  listEmailRawMimesForAccount,
  openEmailRawMime,
  readEmailRawMime,
  saveEmailRawMime,
  sumEmailRawMimeBytes,
} from './raw-mime'
import { settingsFrom } from './settings'
import { assertEmailOwner } from './tools'

export interface EmailBackupFile {
  path: string
  byteLength: number
  sha256: string
  contentType: string
  kind: 'email' | 'email-attachment' | 'email-raw-mime'
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
  rawMimeCount: number
  rawMimeBytes: number
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
  rawMime: number
  createdRawMime: number
  skippedRawMime: number
  restoredRawMimeBytes: number
  missingRawMime: number
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
  folder_id: string | null
  is_starred: number
  is_pinned: number
  tags: string
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
  important: number
  muted: number
  focused: number
  follow_up_at: number | null
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
  deleted_folder_id: string | null
  snoozed_until: number | null
  created_at: number
  updated_at: number
}

interface EmailContactRow {
  id: string
  email: string
  name: string
  company: string
  notes: string
  starred: number
  pinned: number
  avatar: string
  usage_count: number
  last_used_at: number | null
  created_at: number
  updated_at: number
}

interface EmailGroupRow {
  id: string
  name: string
  description: string
  starred: number
  pinned: number
  avatar: string
  created_at: number
  updated_at: number
}

interface EmailGroupMemberRow {
  group_id: string
  contact_id: string
  created_at: number
}

interface PreparedAccount {
  backup: EmailBackupAccount
  address: string
  settings: EmailAccountSettings
  existing: EmailAccountRow | null
}

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
      rawMimeCount: 0,
      rawMimeBytes: 0,
    }
  }
  if (options.includeAttachments && !env.FILES) {
    throw new ApiError(503, 'storage_unavailable', 'Email attachments require R2 storage')
  }

  const { contacts, groups, groupMembers } = await loadAddressBook(env.DB, userId)
  const attachmentFiles: EmailBackupFile[] = []
  const backupAccounts: EmailBackupAccount[] = []
  let messageCount = 0
  let attachmentCount = 0
  let attachmentBytes = 0
  let rawMimeCount = 0
  let rawMimeBytes = 0

  for (const account of accounts) {
    const mailbox = emailMailbox(env, account.id)
    const folderRows = await mailbox.getFolders()
    const attachmentsByMessage = await loadAccountAttachments(env.DB, userId, account.id)
    const rawByMessage = new Map((await listEmailRawMimesForAccount(env.DB, userId, account.id))
      .map((row) => [row.message_id, row]))
    const folders: EmailBackupFolder[] = folderRows.map((folder) => ({
      id: folder.id,
      name: folder.name,
      isDeletable: folder.is_deletable === 1,
      createdAt: folder.created_at,
      parentId: folder.parent_id ?? null,
      color: folder.color ?? null,
      sortOrder: Number(folder.sort_order ?? 0),
    }))
    const tags: EmailBackupTag[] = (await mailbox.listTags()).map((tag) => ({
      id: tag.id,
      name: tag.name,
      color: tag.color ?? null,
      createdAt: tag.created_at,
    }))
    const messageTags: EmailBackupMessageTag[] = await mailbox.listMessageTags()
    const filters: EmailBackupFilter[] = await mailbox.listFilters()
    const blockedSenders: EmailBackupBlockedSender[] = (await mailbox.listBlockedSenders()).map((entry) => ({
      address: entry.email_normalized,
      createdAt: entry.created_at,
    }))
    const templates: EmailBackupTemplate[] = (await mailbox.listTemplates()).map((template) => ({
      id: template.id,
      name: template.name,
      subject: template.subject,
      body: template.body,
      createdAt: template.created_at,
      updatedAt: template.updated_at,
    }))
    const savedSearches: EmailBackupSavedSearch[] = (await mailbox.listSavedSearches()).map((search) => ({
      id: search.id,
      name: search.name,
      query: search.query,
      createdAt: search.created_at,
    }))

    const messages: EmailBackupMessage[] = []
    let afterId = ''
    let exportBytes = 0
    for (;;) {
      const messageRows = await mailbox.listAllEmailsPage(afterId, 100)
      if (!messageRows.length) break
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
            folderId: attachment.folder_id,
            starred: attachment.is_starred === 1,
            pinned: attachment.is_pinned === 1,
            tags: attachmentTags(attachment.tags, attachment.id),
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
              const sha256 = await attachmentSha256(env, attachment)
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
        const rawRow = rawByMessage.get(row.id)
        let rawMime: EmailBackupRawMime | undefined
        if (rawRow) {
          rawMimeCount++
          rawMime = { size: rawRow.size, sha256: rawRow.sha256 }
          if (options.includeAttachments) {
            const object = await env.FILES!.head(rawRow.object_key)
            if (!object) {
              rawMime.missing = true
            } else {
              if (object.size !== rawRow.size) throw new Error(`Email raw MIME size changed while the backup was running: ${row.id}`)
              const bytes = await readEmailRawMime(env, rawRow)
              if (!bytes) throw new Error(`Email raw MIME data is missing: ${row.id}`)
              rawMimeBytes += rawRow.size
              attachmentBytes += rawRow.size
              if (attachmentBytes > LIMITS.attachmentQuotaBytes) {
                throw new ApiError(
                  413,
                  'email_export_too_large',
                  `Email files exceed the ${LIMITS.attachmentQuotaBytes}-byte account budget`,
                )
              }
              const path = backupEmailRawMimePath(options.snapshot, account.id, row.id)
              attachmentFiles.push({
                path,
                byteLength: rawRow.size,
                sha256: rawRow.sha256,
                contentType: 'message/rfc822',
                kind: 'email-raw-mime',
                open: () => openEmailRawMime(env, rawRow),
              })
            }
          }
        }
        const message = toBackupMessage(row, attachments, rawMime)
        exportBytes += encoder.encode(JSON.stringify(message)).byteLength
        if (messageCount + messages.length >= EMAIL_EXPORT_MAX_MESSAGES || exportBytes > EMAIL_EXPORT_MAX_BYTES) {
          throw ApiError.tooLarge('The email export exceeds the safe mailbox export budget')
        }
        messages.push(message)
      }
      afterId = messageRows[messageRows.length - 1]!.id
    }

    backupAccounts.push({
      id: account.id,
      address: account.address,
      displayName: account.display_name,
      settings: settingsFrom(readAccountSettings(account.settings)),
      createdAt: account.created_at,
      updatedAt: account.updated_at,
      folders,
      messages,
      tags,
      messageTags,
      filters,
      blockedSenders,
      templates,
      savedSearches,
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
    contacts,
    groups,
    groupMembers,
    missingFields: [],
  }
  const bytes = encoder.encode(JSON.stringify(bundle))
  if (bytes.byteLength > EMAIL_EXPORT_MAX_BYTES) {
    throw ApiError.tooLarge('The email export exceeds the safe mailbox export budget')
  }
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
    rawMimeCount,
    rawMimeBytes,
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
  summary.accounts = bundle.accounts.length
  if (bundle.version === 1) {
    addWarning(summary, `This v1 email backup does not contain: ${bundle.missingFields.join(', ')}`)
  }

  const declared = bundle.includesAttachments ? declaredAttachmentPaths(bundle) : new Map<string, true>()
  for (const path of archive.attachments.keys()) {
    if (!declared.has(path.toLowerCase())) {
      throw ApiError.badRequest(`The email attachment is not listed in the backup: ${path}`)
    }
  }
  for (const account of bundle.accounts) {
    for (const message of account.messages) {
      if (message.rawMime) {
        const path = backupEmailRawMimePath(bundle.snapshot, account.id, message.id).toLowerCase()
        const bytes = archive.attachments.get(path)
        if (!bytes) continue
        if (message.rawMime.missing === true) throw ApiError.badRequest('Missing raw MIME cannot include file bytes')
        if (bytes.byteLength !== message.rawMime.size) {
          throw ApiError.badRequest(`The email raw MIME size does not match: ${message.id}`)
        }
        if (await sha256Hex(bytes) !== message.rawMime.sha256) {
          throw ApiError.badRequest(`The email raw MIME checksum does not match: ${message.id}`)
        }
      }
      for (const attachment of message.attachments) {
        const path = backupEmailAttachmentPath(
          bundle.snapshot,
          account.id,
          message.id,
          attachment.id,
          attachment.filename,
        ).toLowerCase()
        const bytes = archive.attachments.get(path)
        if (!bytes) continue
        if (attachment.missing === true) throw ApiError.badRequest('A missing attachment cannot include file bytes')
        if (bytes.byteLength !== attachment.size) {
          throw ApiError.badRequest(`The email attachment size does not match: ${attachment.filename}`)
        }
        if (attachment.sha256 && await sha256Hex(bytes) !== attachment.sha256) {
          throw ApiError.badRequest(`The email attachment checksum does not match: ${attachment.filename}`)
        }
      }
    }
  }

  const domains = await effectiveEmailDomains(env, env.DB)
  const prepared: PreparedAccount[] = []
  for (const account of bundle.accounts) {
    const owner = await env.DB.prepare(`SELECT user_id FROM email_accounts WHERE id = ?1`)
      .bind(account.id).first<{ user_id: string }>()
    if (owner && owner.user_id !== userId) {
      throw ApiError.badRequest('The email backup contains an account owned by another user')
    }
    const address = validateMailboxAddress(account.address, domains, env)
    const settings = settingsFrom(account.settings)
    const existing = await getEmailAccount(env.DB, userId, account.id)
    const addressOwner = await findEmailAccountByAddress(env.DB, address)
    if (addressOwner && addressOwner.id !== account.id) {
      summary.skippedAccounts++
      addWarning(summary, `The mailbox ${account.address} is already in use`)
      continue
    }
    prepared.push({ backup: account, address, settings, existing })
  }

  const rawToRestore = new Set<string>()
  for (const { backup } of prepared) {
    for (const message of backup.messages) {
      if (!message.rawMime) continue
      const owner = await getEmailRawMimeOwner(env.DB, message.id)
      if (owner && (owner.user_id !== userId || owner.account_id !== backup.id)) {
        throw ApiError.badRequest('The email backup contains raw MIME owned by another account')
      }
      if (!owner) rawToRestore.add(`${backup.id}\u0000${message.id}`)
    }
  }

  const existingAttachmentIds = await loadExistingAttachmentIds(env.DB)
  const ownedAttachmentIds = await loadOwnedAttachmentIds(env.DB, userId)
  const usage = await env.DB.prepare(
    `SELECT COALESCE(SUM(size), 0) AS bytes FROM email_attachments WHERE user_id = ?1`,
  ).bind(userId).first<{ bytes: number }>()
  let plannedBytes = Number(usage?.bytes ?? 0) + await sumEmailRawMimeBytes(env.DB, userId)
  for (const { backup } of prepared) {
    for (const message of backup.messages) {
      if (bundle.includesAttachments && message.rawMime && !message.rawMime.missing &&
        rawToRestore.has(`${backup.id}\u0000${message.id}`) &&
        archive.attachments.has(backupEmailRawMimePath(bundle.snapshot, backup.id, message.id).toLowerCase())) {
        plannedBytes += message.rawMime.size
      }
      for (const attachment of message.attachments) {
        if (!ownedAttachmentIds.has(attachment.id)) plannedBytes += attachment.size
      }
    }
  }
  if (plannedBytes > LIMITS.attachmentQuotaBytes) {
    throw ApiError.tooLarge('The account email storage quota has been reached')
  }

  await restoreAddressBook(env.DB, userId, bundle)
  for (const { backup: account, address, settings, existing } of prepared) {
    if (existing) {
      summary.skippedAccounts++
    } else {
      await env.DB.prepare(
        `INSERT INTO email_accounts (
           id, user_id, address, address_normalized, display_name, settings, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(
        account.id,
        userId,
        address,
        address,
        account.displayName,
        JSON.stringify(settings),
        account.createdAt,
        account.updatedAt,
      ).run()
      summary.createdAccounts++
    }

    const mailbox = emailMailbox(env, account.id)
    const folderMap = await restoreFolders(mailbox, account, summary)
    const tagMap = await restoreTags(mailbox, account)
    for (const filter of account.filters) {
      const actions = filter.actions.map((action) => action.type === 'moveTo'
        ? { ...action, folder: folderMap.get(action.folder) ?? action.folder }
        : action)
      await mailbox.importFilter({ ...filter, actions })
    }
    for (const blocked of account.blockedSenders) await mailbox.importBlockedSender(blocked)
    for (const template of account.templates) await mailbox.importTemplate(template)
    for (const search of account.savedSearches) await mailbox.importSavedSearch(search)

    for (const message of account.messages) {
      summary.messages++
      const folderId = folderMap.get(message.folderId)
      if (!folderId) throw ApiError.badRequest(`The email folder could not be restored: ${message.folderId}`)
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
        important: message.important,
        muted: message.muted,
        focused: message.focused,
        followUpAt: message.followUpAt,
        snoozedUntil: message.snoozedUntil,
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
        deletedFolderId: message.deletedFolderId,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      })
      if (inserted) summary.createdMessages++
      else summary.skippedMessages++

      if (message.rawMime) {
        summary.rawMime++
        const rawKey = `${account.id}\u0000${message.id}`
        if (!rawToRestore.has(rawKey)) {
          summary.skippedRawMime++
        } else if (!bundle.includesAttachments) {
          summary.skippedRawMime++
        } else {
          const path = backupEmailRawMimePath(bundle.snapshot, account.id, message.id).toLowerCase()
          const bytes = archive.attachments.get(path)
          if (bytes) {
            const saved = await saveEmailRawMime(env, {
              userId,
              accountId: account.id,
              messageId: message.id,
              receivedAt: message.receivedAt,
              bytes,
            })
            summary.createdRawMime++
            summary.restoredRawMimeBytes += saved.size
          } else {
            summary.missingRawMime++
          }
        }
      }

      for (const attachment of message.attachments) {
        summary.attachments++
        if (ownedAttachmentIds.has(attachment.id)) {
          summary.skippedAttachments++
          continue
        }
        const path = backupEmailAttachmentPath(
          bundle.snapshot,
          account.id,
          message.id,
          attachment.id,
          attachment.filename,
        ).toLowerCase()
        const bytes = archive.attachments.get(path)
        const id = await allocateAttachmentId(env, userId, attachment, bytes, existingAttachmentIds)
        if (attachment.missing === true) summary.missingAttachments++
        else if (bundle.includesAttachments && !bytes) summary.missingAttachments++

        if (bytes) {
          const persisted = await persistEmailAttachment(env, {
            id,
            userId,
            accountId: account.id,
            emailId: message.id,
            filename: attachment.filename,
            reportedMime: attachment.mime,
            bytes,
            contentId: attachment.contentId,
            disposition: attachment.disposition,
            locked: attachment.locked,
            createdAt: attachment.createdAt,
          })
          await env.DB.prepare(
            `UPDATE email_attachments SET folder_id = ?1, is_starred = ?2, is_pinned = ?3, tags = ?4
              WHERE user_id = ?5 AND id = ?6`,
          ).bind(
            attachment.folderId,
            attachment.starred ? 1 : 0,
            attachment.pinned ? 1 : 0,
            JSON.stringify(attachment.tags),
            userId,
            persisted.id,
          ).run()
          summary.restoredAttachmentBytes += persisted.size
        } else {
          const objectKey = emailAttachmentObjectKey({
            user_id: userId,
            id,
            mime: attachment.mime,
            filename: attachment.filename,
          })
          await insertAttachment(env, userId, account.id, message.id, { ...attachment, id }, objectKey)
        }
        summary.createdAttachments++
        ownedAttachmentIds.add(id)
        existingAttachmentIds.add(id)
      }
    }

    for (const link of account.messageTags) {
      const tagId = tagMap.get(link.tagId)
      if (tagId) await mailbox.importMessageTag({ ...link, tagId })
    }
  }

  if (summary.missingRawMime > 0) {
    addWarning(summary, `${summary.missingRawMime} original email MIME files were not present in the backup`)
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
            disposition, object_key, storage, folder_id, is_starred, is_pinned, tags, locked, created_at
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

async function attachmentSha256(env: Env, attachment: EmailAttachmentRow): Promise<string> {
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

function attachmentTags(raw: string, attachmentId: string): string[] {
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string')) {
      throw new Error('attachment tags are not a string array')
    }
    return value
  } catch (error) {
    throw new Error(`Email attachment tags could not be read (${attachmentId}): ${(error as Error).message}`)
  }
}

function toBackupMessage(
  row: EmailMessageRow,
  attachments: EmailBackupAttachment[],
  rawMime?: EmailBackupRawMime,
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
    important: row.important === 1,
    muted: row.muted === 1,
    focused: row.focused === 1,
    followUpAt: row.follow_up_at,
    snoozedUntil: row.snoozed_until,
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
    deletedFolderId: row.deleted_folder_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachments,
    ...(rawMime ? { rawMime } : {}),
  }
}

async function loadAddressBook(db: D1Database, userId: string): Promise<{
  contacts: EmailBackupContact[]
  groups: EmailBackupGroup[]
  groupMembers: EmailBackupGroupMember[]
}> {
  const { results: contactRows } = await db.prepare(
    `SELECT id, email, name, company, notes, starred, pinned, avatar, usage_count, last_used_at, created_at, updated_at
       FROM email_contacts WHERE user_id = ?1 ORDER BY created_at ASC, id ASC`,
  ).bind(userId).all<EmailContactRow>()
  const { results: groupRows } = await db.prepare(
    `SELECT id, name, description, starred, pinned, avatar, created_at, updated_at
       FROM email_groups WHERE user_id = ?1 ORDER BY created_at ASC, id ASC`,
  ).bind(userId).all<EmailGroupRow>()
  const { results: memberRows } = await db.prepare(
    `SELECT group_id, contact_id, created_at FROM email_group_members
      WHERE user_id = ?1 ORDER BY created_at ASC, group_id ASC, contact_id ASC`,
  ).bind(userId).all<EmailGroupMemberRow>()
  return {
    contacts: contactRows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      company: row.company,
      notes: row.notes,
      starred: row.starred === 1,
      pinned: row.pinned === 1,
      avatar: row.avatar,
      usageCount: Number(row.usage_count),
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    groups: groupRows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      starred: row.starred === 1,
      pinned: row.pinned === 1,
      avatar: row.avatar,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    groupMembers: memberRows.map((row) => ({
      groupId: row.group_id,
      contactId: row.contact_id,
      createdAt: row.created_at,
    })),
  }
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
    rawMime: 0,
    createdRawMime: 0,
    skippedRawMime: 0,
    restoredRawMimeBytes: 0,
    missingRawMime: 0,
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
  const byName = new Map(existing.map((folder) => [
    `${folder.parent_id ?? ''}\u0000${folder.name.toLowerCase()}`,
    folder.id,
  ]))
  const mapping = new Map<string, string>()
  const depth = (folder: EmailBackupFolder): number => {
    let value = 0
    let current: EmailBackupFolder | undefined = folder
    while (current) {
      value++
      current = current.parentId ? account.folders.find((entry) => entry.id === current!.parentId) : undefined
    }
    return value
  }
  const folders = [...account.folders].sort((a, b) => depth(a) - depth(b) || a.sortOrder - b.sortOrder)
  for (const folder of folders) {
    summary.folders++
    const exact = byId.get(folder.id)
    if (exact) {
      mapping.set(folder.id, exact)
      summary.skippedFolders++
      continue
    }
    const parentId = folder.parentId ? mapping.get(folder.parentId) : null
    if (folder.parentId && !parentId) throw ApiError.badRequest('The email backup has an unresolved parent folder')
    const key = `${parentId ?? ''}\u0000${folder.name.toLowerCase()}`
    const named = byName.get(key)
    if (named) {
      mapping.set(folder.id, named)
      byId.set(folder.id, named)
      summary.skippedFolders++
      continue
    }
    const created = await mailbox.importFolder({
      id: folder.id,
      name: folder.name,
      isDeletable: folder.isDeletable,
      createdAt: folder.createdAt,
      parentId: parentId ?? null,
      color: folder.color,
      sortOrder: folder.sortOrder,
    })
    if (created) {
      mapping.set(folder.id, folder.id)
      byId.set(folder.id, folder.id)
      byName.set(key, folder.id)
      summary.createdFolders++
    } else {
      const refreshed = await mailbox.getFolders()
      const match = refreshed.find((row) => row.id === folder.id) ??
        refreshed.find((row) => (row.parent_id ?? null) === parentId && row.name.toLowerCase() === folder.name.toLowerCase())
      if (!match) throw ApiError.badRequest(`The email folder could not be restored: ${folder.name}`)
      mapping.set(folder.id, match.id)
      byId.set(folder.id, match.id)
      byName.set(`${match.parent_id ?? ''}\u0000${match.name.toLowerCase()}`, match.id)
      summary.skippedFolders++
    }
  }
  return mapping
}

async function restoreTags(
  mailbox: ReturnType<typeof emailMailbox>,
  account: EmailBackupAccount,
): Promise<Map<string, string>> {
  const existing = await mailbox.listTags()
  const byId = new Map(existing.map((tag) => [tag.id, tag.id]))
  const byName = new Map(existing.map((tag) => [tag.name.toLowerCase(), tag.id]))
  const mapping = new Map<string, string>()
  for (const tag of account.tags) {
    const id = byId.get(tag.id) ?? byName.get(tag.name.toLowerCase())
    if (id) {
      mapping.set(tag.id, id)
      continue
    }
    if (await mailbox.importTag(tag)) {
      mapping.set(tag.id, tag.id)
      byId.set(tag.id, tag.id)
      byName.set(tag.name.toLowerCase(), tag.id)
      continue
    }
    const refreshed = await mailbox.listTags()
    const match = refreshed.find((entry) => entry.id === tag.id) ??
      refreshed.find((entry) => entry.name.toLowerCase() === tag.name.toLowerCase())
    if (!match) throw ApiError.badRequest(`The email tag could not be restored: ${tag.name}`)
    mapping.set(tag.id, match.id)
  }
  return mapping
}

async function restoreAddressBook(db: D1Database, userId: string, bundle: EmailBackupBundle): Promise<void> {
  const { results: contactRows } = await db.prepare(
    `SELECT id, user_id, email_normalized FROM email_contacts`,
  ).all<{ id: string; user_id: string; email_normalized: string }>()
  const { results: groupRows } = await db.prepare(
    `SELECT id, user_id, name FROM email_groups`,
  ).all<{ id: string; user_id: string; name: string }>()
  const contactIds = new Set(contactRows.map((row) => row.id))
  const groupIds = new Set(groupRows.map((row) => row.id))
  const ownedContacts = new Map(contactRows.filter((row) => row.user_id === userId).map((row) => [row.email_normalized, row.id]))
  const ownedContactIds = new Map(contactRows.filter((row) => row.user_id === userId).map((row) => [row.id, row.id]))
  const ownedGroups = new Map(groupRows.filter((row) => row.user_id === userId).map((row) => [row.name.toLowerCase(), row.id]))
  const ownedGroupIds = new Map(groupRows.filter((row) => row.user_id === userId).map((row) => [row.id, row.id]))
  const contactMap = new Map<string, string>()
  const groupMap = new Map<string, string>()

  for (const contact of bundle.contacts) {
    const email = contact.email.toLowerCase()
    const existingId = ownedContactIds.get(contact.id) ?? ownedContacts.get(email)
    if (existingId) {
      contactMap.set(contact.id, existingId)
      continue
    }
    let id = contact.id
    while (contactIds.has(id)) id = newId()
    const result = await db.prepare(
      `INSERT OR IGNORE INTO email_contacts (
         id, user_id, email, email_normalized, name, company, notes, starred, pinned, avatar,
         usage_count, last_used_at, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    ).bind(
      id,
      userId,
      contact.email,
      email,
      contact.name,
      contact.company,
      contact.notes,
      contact.starred ? 1 : 0,
      contact.pinned ? 1 : 0,
      contact.avatar,
      contact.usageCount,
      contact.lastUsedAt,
      contact.createdAt,
      contact.updatedAt,
    ).run()
    if (!result.meta.changes) {
      const existing = await db.prepare(
        `SELECT id FROM email_contacts WHERE user_id = ?1 AND email_normalized = ?2`,
      ).bind(userId, email).first<{ id: string }>()
      if (!existing) throw new Error(`The email contact could not be restored: ${contact.email}`)
      contactMap.set(contact.id, existing.id)
      continue
    }
    contactIds.add(id)
    contactMap.set(contact.id, id)
  }

  for (const group of bundle.groups) {
    const name = group.name.toLowerCase()
    const existingId = ownedGroupIds.get(group.id) ?? ownedGroups.get(name)
    if (existingId) {
      groupMap.set(group.id, existingId)
      continue
    }
    let id = group.id
    while (groupIds.has(id)) id = newId()
    const result = await db.prepare(
      `INSERT OR IGNORE INTO email_groups (
         id, user_id, name, description, starred, pinned, avatar, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(
      id,
      userId,
      group.name,
      group.description,
      group.starred ? 1 : 0,
      group.pinned ? 1 : 0,
      group.avatar,
      group.createdAt,
      group.updatedAt,
    ).run()
    if (!result.meta.changes) {
      const existing = await db.prepare(
        `SELECT id FROM email_groups WHERE user_id = ?1 AND name = ?2 COLLATE NOCASE`,
      ).bind(userId, group.name).first<{ id: string }>()
      if (!existing) throw new Error(`The email group could not be restored: ${group.name}`)
      groupMap.set(group.id, existing.id)
      continue
    }
    groupIds.add(id)
    groupMap.set(group.id, id)
  }

  for (const member of bundle.groupMembers) {
    const groupId = groupMap.get(member.groupId)
    const contactId = contactMap.get(member.contactId)
    if (!groupId || !contactId) throw ApiError.badRequest('The email backup has an unresolved group member')
    await db.prepare(
      `INSERT OR IGNORE INTO email_group_members (user_id, group_id, contact_id, created_at)
       VALUES (?1, ?2, ?3, ?4)`,
    ).bind(userId, groupId, contactId, member.createdAt).run()
  }
}

function declaredAttachmentPaths(bundle: EmailBackupBundle): Map<string, true> {
  const paths = new Map<string, true>()
  for (const account of bundle.accounts) {
    for (const message of account.messages) {
      if (message.rawMime) {
        const path = backupEmailRawMimePath(bundle.snapshot, account.id, message.id)
        if (paths.has(path.toLowerCase())) {
          throw ApiError.badRequest(`The email backup contains a duplicate raw MIME path: ${path}`)
        }
        paths.set(path.toLowerCase(), true)
      }
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

async function loadExistingAttachmentIds(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare(`SELECT id FROM email_attachments`).all<{ id: string }>()
  return new Set(results.map((row) => row.id))
}

async function loadOwnedAttachmentIds(db: D1Database, userId: string): Promise<Set<string>> {
  const { results } = await db.prepare(`SELECT id FROM email_attachments WHERE user_id = ?1`)
    .bind(userId).all<{ id: string }>()
  return new Set(results.map((row) => row.id))
}

async function allocateAttachmentId(
  env: Env,
  userId: string,
  attachment: EmailBackupAttachment,
  bytes: Uint8Array | undefined,
  existingIds: Set<string>,
): Promise<string> {
  const filename = sanitizeAttachmentFilename(attachment.filename)
  let mime = attachment.mime
  if (bytes) {
    mime = safeAttachmentMime(bytes, mime)
    if (!hasReasonableImageDimensions(readImageSize(bytes, mime))) mime = 'application/octet-stream'
  }
  let id = attachment.id
  for (;;) {
    const key = emailAttachmentObjectKey({ user_id: userId, id, mime, filename })
    if (!existingIds.has(id) && (!env.FILES || !await env.FILES.head(key))) return id
    id = newId()
  }
}

async function insertAttachment(
  env: Env,
  userId: string,
  accountId: string,
  messageId: string,
  attachment: EmailBackupAttachment,
  objectKey: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO email_attachments (
       id, user_id, account_id, email_id, filename, mime, size, width, height,
       content_id, disposition, object_key, storage, folder_id, is_starred,
       is_pinned, tags, locked, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'r2', ?13, ?14, ?15, ?16, ?17, ?18)`,
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
    attachment.folderId,
    attachment.starred ? 1 : 0,
    attachment.pinned ? 1 : 0,
    JSON.stringify(attachment.tags),
    attachment.locked ? 1 : 0,
    attachment.createdAt,
  ).run()
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

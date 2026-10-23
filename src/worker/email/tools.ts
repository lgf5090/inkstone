import type { EmailAccount, EmailAttachment, EmailFolder, EmailMessage, EmailSummary } from '@shared/email/model'
import { buildEmailQuoteHtml, buildEmailQuoteMarkdown, stripEmailHtmlToText, textToEmailHtml } from '@shared/email/format'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import type { Env } from '../env'
import { findEmailAccountByAddress, getEmailAccount, listEmailAccounts, toEmailAccount, type EmailAccountRow } from './account-store'
import { loadEmailAttachments } from './attachments'
import { emailMailbox } from './mailbox-stub'
import type { EmailRow } from './mailbox-store'

function iso(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : new Date(value).toISOString()
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
  } catch {
    return []
  }
}

function parseReferences(raw: string | null): string[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

export function toEmailSummary(row: EmailRow & { thread_count?: number; thread_unread_count?: number; participants?: string; needs_reply?: number; has_draft?: number; snippet?: string }): EmailSummary {
  return {
    id: row.id,
    folderId: row.folder_id,
    subject: row.subject,
    sender: row.sender,
    recipient: row.recipient,
    cc: row.cc,
    bcc: row.bcc,
    date: new Date(row.date).toISOString(),
    read: Boolean(row.read),
    starred: Boolean(row.starred),
    important: Boolean(row.important),
    muted: Boolean(row.muted),
    focused: Boolean(row.focused),
    followUpAt: iso(row.follow_up_at),
    snoozedUntil: iso(row.snoozed_until),
    threadId: row.thread_id,
    ...(row.thread_count !== undefined ? { threadCount: Number(row.thread_count) } : {}),
    ...(row.thread_unread_count !== undefined ? { threadUnreadCount: Number(row.thread_unread_count) } : {}),
    ...(row.participants ? { participants: row.participants } : {}),
    ...(row.needs_reply !== undefined ? { needsReply: Boolean(row.needs_reply) } : {}),
    ...(row.has_draft !== undefined ? { hasDraft: Boolean(row.has_draft) } : {}),
    hasAttachment: Boolean(row.has_attachment),
    snippet: row.snippet ?? null,
    deliveryStatus: row.delivery_status as EmailSummary['deliveryStatus'],
  }
}

export function toEmailMessage(row: EmailRow, attachments: EmailAttachment[]): EmailMessage {
  return {
    ...toEmailSummary(row),
    body: row.body,
    bodySource: row.body_source,
    inReplyTo: row.in_reply_to,
    references: parseReferences(row.email_references),
    messageId: row.message_id,
    rawHeaders: parseHeaders(row.raw_headers),
    attachments,
    deliveryError: row.delivery_error,
    attachmentsSkipped: Boolean(row.attachments_skipped),
    deletedAt: iso(row.deleted_at),
  }
}

export async function assertEmailOwner(env: Env, userId: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT role FROM users WHERE id = ?1`).bind(userId).first<{ role: string }>()
  if (row?.role !== 'owner') throw ApiError.forbidden('Email is available to the owner only')
}

export async function resolveEmailAccount(
  env: Env,
  userId: string,
  accountId?: string,
): Promise<EmailAccountRow> {
  await assertEmailOwner(env, userId)
  if (accountId) {
    const account = await getEmailAccount(env.DB, userId, accountId)
    if (!account) throw ApiError.notFound('Mailbox not found')
    return account
  }
  const accounts = await listEmailAccounts(env.DB, userId)
  if (accounts.length === 1) return accounts[0]!
  if (!accounts.length) throw ApiError.badRequest('No mailbox exists for this account')
  throw ApiError.badRequest(`Name a mailbox: ${accounts.map((account) => `${account.address} (${account.id})`).join(', ')}`)
}

export async function listEmailToolAccounts(env: Env, userId: string): Promise<EmailAccount[]> {
  await assertEmailOwner(env, userId)
  return (await listEmailAccounts(env.DB, userId)).map(toEmailAccount)
}

export async function listEmailToolFolders(env: Env, userId: string, accountId?: string): Promise<EmailFolder[]> {
  const account = await resolveEmailAccount(env, userId, accountId)
  const folders = await emailMailbox(env, account.id).getFolders()
  return folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    isDeletable: Boolean(folder.is_deletable),
    unreadCount: Number(folder.unread_count ?? 0),
    parentId: folder.parent_id ?? null,
    color: folder.color ?? null,
    sortOrder: Number(folder.sort_order ?? 0),
  }))
}

export async function listEmailToolMessages(
  env: Env,
  userId: string,
  input: {
    accountId?: string
    folder?: string
    tag?: string
    important?: boolean
    focused?: boolean
    followUp?: boolean
    limit?: number
    page?: number
  },
): Promise<EmailSummary[]> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const rows = await emailMailbox(env, account.id).getEmails({
    folder: input.folder ?? 'inbox',
    tag: input.tag,
    important: input.important,
    focused: input.focused,
    followUp: input.followUp,
    limit: Math.min(Math.max(input.limit ?? 20, 1), 100),
    page: Math.max(input.page ?? 1, 1),
  })
  return rows.map((row) => toEmailSummary(row))
}

export async function getEmailToolMessage(
  env: Env,
  userId: string,
  input: { accountId?: string; emailId: string },
): Promise<EmailMessage | null> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const row = await emailMailbox(env, account.id).getEmail(input.emailId)
  if (!row) return null
  const attachments = (await loadEmailAttachments(env.DB, userId, [row.id])).get(row.id) ?? []
  return toEmailMessage(row, attachments)
}

export async function getEmailToolThread(
  env: Env,
  userId: string,
  input: { accountId?: string; threadId: string },
): Promise<{ threadId: string; messages: EmailMessage[] }> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const rows = await emailMailbox(env, account.id).getThreadEmails(input.threadId)
  const attachments = await loadEmailAttachments(env.DB, userId, rows.map((row) => row.id))
  return {
    threadId: input.threadId,
    messages: rows.map((row) => toEmailMessage(row, attachments.get(row.id) ?? [])),
  }
}

export async function searchEmailToolMessages(
  env: Env,
  userId: string,
  input: { accountId?: string; query: string; folder?: string },
): Promise<EmailSummary[]> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const rows = await emailMailbox(env, account.id).searchEmails({
    query: input.query,
    folder: input.folder,
    limit: 20,
  })
  return rows.map((row) => toEmailSummary(row))
}

export interface EmailDraftToolResult {
  draftId: string
  threadId: string
  to: string
  subject: string
  body: string
}

export async function draftEmailReplyTool(
  env: Env,
  userId: string,
  input: { accountId?: string; originalEmailId: string; to: string; subject: string; body: string },
): Promise<EmailDraftToolResult | null> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const original = await emailMailbox(env, account.id).getEmail(input.originalEmailId)
  if (!original) return null
  const draftId = newId()
  const quoteMarkdown = buildEmailQuoteMarkdown(iso(original.date) ?? undefined, original.sender, original.body)
  const quoteHtml = buildEmailQuoteHtml(iso(original.date) ?? undefined, original.sender, original.body)
  const bodySource = `${input.body.trim()}${quoteMarkdown}`
  const body = `${textToEmailHtml(input.body.trim())}${quoteHtml}`
  const threadId = original.thread_id || original.id
  await emailMailbox(env, account.id).createEmail('draft', {
    id: draftId,
    subject: input.subject,
    sender: account.address,
    recipient: input.to.trim().toLowerCase(),
    date: Date.now(),
    body,
    bodySource,
    inReplyTo: original.id,
    threadId,
  })
  return { draftId, threadId, to: input.to, subject: input.subject, body: input.body.trim() }
}

export async function draftEmailTool(
  env: Env,
  userId: string,
  input: { accountId?: string; to: string; subject: string; body: string },
): Promise<EmailDraftToolResult> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const draftId = newId()
  await emailMailbox(env, account.id).createEmail('draft', {
    id: draftId,
    subject: input.subject,
    sender: account.address,
    recipient: input.to.trim().toLowerCase(),
    date: Date.now(),
    body: textToEmailHtml(input.body.trim()),
    bodySource: input.body.trim(),
    threadId: draftId,
  })
  return { draftId, threadId: draftId, to: input.to, subject: input.subject, body: input.body.trim() }
}

export async function markEmailReadTool(
  env: Env,
  userId: string,
  input: { accountId?: string; emailId: string; read: boolean },
): Promise<boolean> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const updated = await emailMailbox(env, account.id).updateEmail(input.emailId, { read: input.read })
  return Boolean(updated)
}

export async function moveEmailTool(
  env: Env,
  userId: string,
  input: { accountId?: string; emailId: string; folderId: string },
): Promise<boolean> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  return emailMailbox(env, account.id).moveEmail(input.emailId, input.folderId)
}

export async function discardDraftTool(
  env: Env,
  userId: string,
  input: { accountId?: string; draftId: string },
): Promise<boolean> {
  const account = await resolveEmailAccount(env, userId, input.accountId)
  const row = await emailMailbox(env, account.id).getEmail(input.draftId)
  if (!row || row.folder_id !== 'draft') return false
  return emailMailbox(env, account.id).deleteEmail(input.draftId)
}

export async function findEmailAccountForInbound(env: Env, address: string): Promise<EmailAccountRow | null> {
  const normalized = address.trim().toLowerCase()
  const owner = await findEmailAccountByAddress(env.DB, normalized)
  return owner?.role === 'owner' ? owner : null
}

export function emailBodyText(row: EmailRow): string {
  return stripEmailHtmlToText(row.body)
}

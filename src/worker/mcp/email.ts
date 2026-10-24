import type { EmailMessage, EmailSummary } from '@shared/email/model'
import { EMAIL_BODY_MAX_BYTES, EMAIL_SUBJECT_MAX_CHARS } from '@shared/email/model'
import { stripEmailHtmlToText, textToEmailHtml } from '@shared/email/format'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { storedStringArray } from '../lib/json'
import { listEmailAccounts, readAccountSettings, type EmailAccountRow } from '../email/account-store'
import { loadEmailAttachments, lockEmailAttachments } from '../email/attachments'
import { emailMailbox } from '../email/mailbox-stub'
import {
  buildThreadingHeaders,
  loadOutgoingAttachments,
  normalizeRecipients,
  outgoingMessageId,
  replyToHeader,
  sendViaProvider,
} from '../email/outbound'
import {
  draftEmailReplyTool,
  draftEmailTool,
  getEmailToolMessage,
  getEmailToolThread,
  listEmailToolMessages,
  markEmailReadTool,
  resolveEmailAccount,
  searchEmailToolMessages,
  type EmailDraftToolResult,
} from '../email/tools'

export interface McpEmailContext {
  env: Env
  userId: string
  role: 'owner' | 'member'
}

export interface McpEmailAccountSummary {
  id: string
  address: string
  displayName: string
}

export interface McpEmailSendResult {
  status: 'sent'
  messageId: string
  deliveryStatus: 'sent'
  verified: boolean
}

export interface McpEmailSendInput {
  accountId: string
  draftId?: string
  to?: string
  subject?: string
  body?: string
}

export interface McpEmailReplyInput {
  accountId: string
  emailId: string
  subject?: string
  body: string
}

function requireOwner(context: McpEmailContext): void {
  if (context.role !== 'owner') throw ApiError.forbidden('Email is available to the owner only')
}

function mailboxId(id: string): string {
  if (!isValidId(id)) throw new ApiError(404, 'email_account_not_found', 'Mailbox not found')
  return id
}

function emailId(id: string): string {
  if (!isValidId(id)) throw new ApiError(404, 'email_message_not_found', 'Email not found')
  return id
}

function senderValue(account: EmailAccountRow): string | { email: string; name: string } {
  return account.display_name && account.display_name !== account.address
    ? { email: account.address, name: account.display_name }
    : account.address
}

function recipientAddress(value: string): string {
  const match = /<([^<>]+)>/.exec(value)
  return (match?.[1] ?? value).trim()
}

function replySubject(subject: string): string {
  const prefixed = /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`
  return prefixed.slice(0, EMAIL_SUBJECT_MAX_CHARS)
}

function sentHeaders(
  account: EmailAccountRow,
  subject: string,
  recipients: readonly string[],
  outgoingId: string,
  threading?: Record<string, string>,
): string {
  const replyTo = readAccountSettings(account.settings).replyTo
  return JSON.stringify([
    { key: 'from', value: `${account.display_name} <${account.address}>` },
    { key: 'to', value: recipients.join(', ') },
    { key: 'subject', value: subject },
    { key: 'date', value: new Date().toISOString() },
    { key: 'message-id', value: `<${outgoingId}>` },
    ...Object.entries(threading ?? {}).map(([key, value]) => ({ key: key.toLowerCase(), value })),
    ...(replyTo ? [{ key: 'reply-to', value: replyTo }] : []),
  ])
}

function assertBodyFits(html: string): void {
  if (new TextEncoder().encode(html).byteLength > EMAIL_BODY_MAX_BYTES) {
    throw ApiError.tooLarge('The message body exceeds the 5 MB limit')
  }
}

function optionalList(value: string | null | undefined, field: string): string[] {
  return normalizeRecipients(value ?? undefined, field)
}

function sendParams(value: string[]): string | string[] {
  return value.length === 1 ? value[0]! : value
}

export async function listMcpEmailAccounts(context: McpEmailContext): Promise<McpEmailAccountSummary[]> {
  requireOwner(context)
  const rows = await listEmailAccounts(context.env.DB, context.userId)
  return rows.map((row) => ({ id: row.id, address: row.address, displayName: row.display_name }))
}

export async function listMcpEmailMessages(
  context: McpEmailContext,
  input: { accountId: string; folder?: string; limit?: number; page?: number },
): Promise<EmailSummary[]> {
  requireOwner(context)
  return listEmailToolMessages(context.env, context.userId, {
    accountId: mailboxId(input.accountId),
    folder: input.folder,
    limit: input.limit,
    page: input.page,
  })
}

export async function getMcpEmail(
  context: McpEmailContext,
  input: { accountId: string; emailId: string },
): Promise<EmailMessage> {
  requireOwner(context)
  const message = await getEmailToolMessage(context.env, context.userId, {
    accountId: mailboxId(input.accountId),
    emailId: emailId(input.emailId),
  })
  if (!message) throw new ApiError(404, 'email_message_not_found', 'Email not found')
  return message
}

export async function getMcpEmailThread(
  context: McpEmailContext,
  input: { accountId: string; threadId: string },
): Promise<{ threadId: string; messages: EmailMessage[] }> {
  requireOwner(context)
  return getEmailToolThread(context.env, context.userId, {
    accountId: mailboxId(input.accountId),
    threadId: input.threadId,
  })
}

export async function searchMcpEmailMessages(
  context: McpEmailContext,
  input: { accountId: string; query: string; folder?: string },
): Promise<EmailSummary[]> {
  requireOwner(context)
  return searchEmailToolMessages(context.env, context.userId, {
    accountId: mailboxId(input.accountId),
    query: input.query,
    folder: input.folder,
  })
}

export async function draftMcpEmailReply(
  context: McpEmailContext,
  input: { accountId: string; emailId: string; to: string; subject: string; body: string },
): Promise<EmailDraftToolResult> {
  requireOwner(context)
  const draft = await draftEmailReplyTool(context.env, context.userId, {
    accountId: mailboxId(input.accountId),
    originalEmailId: emailId(input.emailId),
    to: input.to,
    subject: input.subject,
    body: input.body,
  })
  if (!draft) throw new ApiError(404, 'email_message_not_found', 'Email not found')
  return draft
}

export async function createMcpEmailDraft(
  context: McpEmailContext,
  input: { accountId: string; to: string; subject: string; body: string },
): Promise<EmailDraftToolResult> {
  requireOwner(context)
  assertBodyFits(textToEmailHtml(input.body))
  return draftEmailTool(context.env, context.userId, {
    accountId: mailboxId(input.accountId),
    to: input.to,
    subject: input.subject,
    body: input.body,
  })
}

export async function updateMcpEmailDraft(
  context: McpEmailContext,
  input: { accountId: string; draftId: string; to?: string; subject?: string; body?: string },
): Promise<EmailDraftToolResult> {
  requireOwner(context)
  if (input.to === undefined && input.subject === undefined && input.body === undefined) {
    throw ApiError.badRequest('Name at least one of to, subject, or body to change')
  }
  const account = await resolveEmailAccount(context.env, context.userId, mailboxId(input.accountId))
  const draftId = emailId(input.draftId)
  const mailbox = emailMailbox(context.env, account.id)
  const draft = await mailbox.getEmail(draftId)
  if (!draft || draft.folder_id !== 'draft') throw new ApiError(404, 'email_message_not_found', 'Draft not found')
  const body = input.body?.trim()
  const bodySource = body ?? draft.body_source ?? stripEmailHtmlToText(draft.body)
  const bodyHtml = body === undefined ? draft.body : textToEmailHtml(body)
  assertBodyFits(bodyHtml)
  const recipient = input.to === undefined ? draft.recipient : normalizeRecipients(input.to, 'to').join(', ')
  const subject = input.subject ?? draft.subject
  const saved = await mailbox.saveDraft(draftId, {
    id: draftId,
    subject,
    sender: account.address,
    recipient,
    cc: draft.cc,
    bcc: draft.bcc,
    date: draft.date,
    body: bodyHtml,
    bodySource,
    inReplyTo: draft.in_reply_to,
    threadId: draft.thread_id ?? draftId,
  })
  if (!saved) throw new ApiError(400, 'email_draft_invalid', 'The draft could not be saved')
  return {
    draftId: saved,
    threadId: draft.thread_id ?? draftId,
    to: recipient,
    subject,
    body: bodySource,
  }
}

export async function deleteMcpEmail(
  context: McpEmailContext,
  input: { accountId: string; emailId: string; permanent?: boolean },
): Promise<{ status: 'trashed' | 'deleted'; emailId: string; permanent: boolean }> {
  requireOwner(context)
  const account = await resolveEmailAccount(context.env, context.userId, mailboxId(input.accountId))
  const targetId = emailId(input.emailId)
  const mailbox = emailMailbox(context.env, account.id)
  if (input.permanent) {
    if (!await mailbox.deleteEmail(targetId)) {
      throw new ApiError(404, 'email_message_not_found', 'Email not found')
    }
    return { status: 'deleted', emailId: targetId, permanent: true }
  }
  if (await mailbox.trashEmail(targetId) === null) {
    throw new ApiError(404, 'email_message_not_found', 'Email not found')
  }
  return { status: 'trashed', emailId: targetId, permanent: false }
}

export async function markMcpEmailRead(
  context: McpEmailContext,
  input: { accountId: string; emailId: string; read: boolean },
): Promise<{ emailId: string; read: boolean }> {
  requireOwner(context)
  const targetId = emailId(input.emailId)
  const updated = await markEmailReadTool(context.env, context.userId, {
    accountId: mailboxId(input.accountId),
    emailId: targetId,
    read: input.read,
  })
  if (!updated) throw new ApiError(404, 'email_message_not_found', 'Email not found')
  return { emailId: targetId, read: input.read }
}

export async function moveMcpEmail(
  context: McpEmailContext,
  input: { accountId: string; emailId: string; folder: string },
): Promise<{ emailId: string; folder: string }> {
  requireOwner(context)
  const account = await resolveEmailAccount(context.env, context.userId, mailboxId(input.accountId))
  const targetId = emailId(input.emailId)
  const mailbox = emailMailbox(context.env, account.id)
  const wanted = input.folder.trim()
  const folders = await mailbox.getFolders()
  const target = folders.find((folder) => folder.id === wanted || folder.name.toLowerCase() === wanted.toLowerCase())
  if (!target) throw new ApiError(404, 'email_folder_not_found', 'Folder not found')
  if (target.id === 'trash') {
    if (await mailbox.trashEmail(targetId) === null) {
      throw new ApiError(404, 'email_message_not_found', 'Email not found')
    }
    return { emailId: targetId, folder: target.id }
  }
  if (!await mailbox.moveEmail(targetId, target.id)) {
    throw new ApiError(404, 'email_message_not_found', 'Email not found')
  }
  return { emailId: targetId, folder: target.id }
}

export async function sendMcpEmail(
  context: McpEmailContext,
  input: McpEmailSendInput,
): Promise<McpEmailSendResult> {
  requireOwner(context)
  if (input.draftId) {
    if (input.to !== undefined || input.subject !== undefined || input.body !== undefined) {
      throw ApiError.badRequest('Name either draft_id or the message fields, not both')
    }
    return sendStoredDraft(context, mailboxId(input.accountId), emailId(input.draftId))
  }
  if (input.to === undefined || input.subject === undefined || input.body === undefined) {
    throw ApiError.badRequest('A recipient, subject, and body are required when no draft_id is named')
  }
  const account = await resolveEmailAccount(context.env, context.userId, mailboxId(input.accountId))
  const mailbox = emailMailbox(context.env, account.id)
  const rate = await mailbox.checkSendRateLimit()
  if (rate) throw new ApiError(429, 'email_rate_limited', rate)
  const html = textToEmailHtml(input.body.trim())
  assertBodyFits(html)
  const to = normalizeRecipients(input.to, 'to')
  const messageId = newId()
  const outgoingId = outgoingMessageId(messageId, account.address)
  const created = await mailbox.createEmail('sent', {
    id: messageId,
    subject: input.subject,
    sender: account.address,
    recipient: to.join(', '),
    date: Date.now(),
    body: html,
    bodySource: input.body.trim(),
    threadId: messageId,
    messageId: outgoingId,
    rawHeaders: sentHeaders(account, input.subject, to, outgoingId),
    deliveryStatus: 'pending',
    size: new TextEncoder().encode(html).byteLength,
  })
  if (!created) throw new ApiError(500, 'internal', 'The sent message could not be stored')
  try {
    const sent = await sendViaProvider(context.env, context.userId, {
      to: sendParams(to),
      from: senderValue(account),
      subject: input.subject,
      html,
      text: input.body.trim(),
      headers: replyToHeader(readAccountSettings(account.settings)),
    })
    await mailbox.updateDelivery(messageId, 'sent', null, sent.messageId)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'The email could not be sent'
    await mailbox.updateDelivery(messageId, 'failed', reason)
    throw new ApiError(502, 'email_send_failed', reason)
  }
  return { status: 'sent', messageId, deliveryStatus: 'sent', verified: false }
}

export async function sendMcpEmailReply(
  context: McpEmailContext,
  input: McpEmailReplyInput,
): Promise<McpEmailSendResult> {
  requireOwner(context)
  const account = await resolveEmailAccount(context.env, context.userId, mailboxId(input.accountId))
  const mailbox = emailMailbox(context.env, account.id)
  const original = await mailbox.getEmail(emailId(input.emailId))
  if (!original) throw new ApiError(404, 'email_message_not_found', 'Email not found')
  const rate = await mailbox.checkSendRateLimit()
  if (rate) throw new ApiError(429, 'email_rate_limited', rate)
  const to = normalizeRecipients(recipientAddress(original.sender), 'to')
  if (!to.length) throw ApiError.badRequest('The original message has no sender to reply to')
  const subject = input.subject?.trim() || replySubject(original.subject)
  const html = textToEmailHtml(input.body.trim())
  assertBodyFits(html)
  const messageId = newId()
  const outgoingId = outgoingMessageId(messageId, account.address)
  const references = [...storedStringArray(original.email_references ?? ''), original.message_id || original.id]
  const inReplyTo = original.message_id || original.id
  const threadId = original.thread_id || original.id
  const threading = buildThreadingHeaders(inReplyTo, references)
  const created = await mailbox.createEmail('sent', {
    id: messageId,
    subject,
    sender: account.address,
    recipient: to.join(', '),
    date: Date.now(),
    body: html,
    bodySource: input.body.trim(),
    inReplyTo,
    emailReferences: JSON.stringify(references),
    threadId,
    messageId: outgoingId,
    rawHeaders: sentHeaders(account, subject, to, outgoingId, threading),
    deliveryStatus: 'pending',
    size: new TextEncoder().encode(html).byteLength,
  })
  if (!created) throw new ApiError(500, 'internal', 'The sent message could not be stored')
  try {
    const sent = await sendViaProvider(context.env, context.userId, {
      to: sendParams(to),
      from: senderValue(account),
      subject,
      html,
      text: input.body.trim(),
      headers: { ...threading, ...replyToHeader(readAccountSettings(account.settings)) },
    })
    await mailbox.updateDelivery(messageId, 'sent', null, sent.messageId)
    await mailbox.markThreadRead(threadId)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'The email could not be sent'
    await mailbox.updateDelivery(messageId, 'failed', reason)
    throw new ApiError(502, 'email_send_failed', reason)
  }
  return { status: 'sent', messageId, deliveryStatus: 'sent', verified: false }
}

async function sendStoredDraft(
  context: McpEmailContext,
  accountId: string,
  draftId: string,
): Promise<McpEmailSendResult> {
  const account = await resolveEmailAccount(context.env, context.userId, accountId)
  const mailbox = emailMailbox(context.env, account.id)
  const draft = await mailbox.getEmail(draftId)
  if (!draft || draft.folder_id !== 'draft') throw new ApiError(404, 'email_message_not_found', 'Draft not found')
  const rate = await mailbox.checkSendRateLimit()
  if (rate) throw new ApiError(429, 'email_rate_limited', rate)
  const to = normalizeRecipients(draft.recipient, 'to')
  if (!to.length) throw ApiError.badRequest('The draft has no recipient')
  const cc = optionalList(draft.cc, 'cc')
  const bcc = optionalList(draft.bcc, 'bcc')
  const html = draft.body
  assertBodyFits(html)
  const text = draft.body_source ?? stripEmailHtmlToText(draft.body)
  const attached = (await loadEmailAttachments(context.env.DB, context.userId, [draftId])).get(draftId) ?? []
  const attachments = await loadOutgoingAttachments(
    context.env,
    context.userId,
    draftId,
    attached.map((attachment) => attachment.id),
    true,
  )
  const outgoingId = outgoingMessageId(draftId, account.address)
  let references: string[] = []
  let threadId = draft.thread_id || draftId
  let inReplyTo = draft.in_reply_to
  const original = inReplyTo ? await mailbox.getEmail(inReplyTo) : null
  if (original) {
    const originalMessageId = original.message_id || original.id
    references = [...storedStringArray(original.email_references ?? ''), originalMessageId]
    inReplyTo = originalMessageId
    threadId = original.thread_id || original.id
  }
  const threading = inReplyTo ? buildThreadingHeaders(inReplyTo, references) : undefined
  const moved = await mailbox.sendDraft(draftId, {
    body: html,
    bodySource: text,
    messageId: outgoingId,
    date: Date.now(),
    sender: account.address,
    recipient: to.join(', '),
    cc: cc.length ? cc.join(', ') : null,
    bcc: bcc.length ? bcc.join(', ') : null,
    inReplyTo,
    threadId,
    emailReferences: references.length ? JSON.stringify(references) : null,
    rawHeaders: sentHeaders(account, draft.subject, to, outgoingId, threading),
    subject: draft.subject,
  })
  if (!moved) throw new ApiError(404, 'email_message_not_found', 'Draft not found')
  await lockEmailAttachments(context.env.DB, context.userId, draftId)
  try {
    const sent = await sendViaProvider(context.env, context.userId, {
      to: sendParams(to),
      cc: cc.length ? sendParams(cc) : undefined,
      bcc: bcc.length ? sendParams(bcc) : undefined,
      from: senderValue(account),
      subject: draft.subject,
      html,
      text,
      ...(attachments.length ? { attachments } : {}),
      headers: { ...(threading ?? {}), ...replyToHeader(readAccountSettings(account.settings)) },
    })
    await mailbox.updateDelivery(draftId, 'sent', null, sent.messageId)
    if (inReplyTo) await mailbox.markThreadRead(threadId)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'The email could not be sent'
    await mailbox.updateDelivery(draftId, 'failed', reason)
    throw new ApiError(502, 'email_send_failed', reason)
  }
  return { status: 'sent', messageId: draftId, deliveryStatus: 'sent', verified: false }
}

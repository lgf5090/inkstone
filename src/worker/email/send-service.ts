import type { EmailSendInput, EmailSendResult } from '@shared/email/model'
import { normalizeRecipients } from './outbound'
import { buildThreadingHeaders } from './outbound'
import { loadOutgoingAttachments } from './outbound'
import { outgoingMessageId } from './outbound'
import { sendViaBinding } from './outbound'
import { validateBody } from './outbound'
import { ApiError } from '../lib/errors'
import { sha256Hex } from '../lib/encoding'
import type { Env } from '../env'
import type { EmailAccountRow } from './account-store'
import { emailMailbox } from './mailbox-stub'
import type { EmailRow } from './mailbox-store'
import { loadEmailAttachments, lockEmailAttachments } from './attachments'
import { rememberRecipientAddresses } from './contacts'

export function sender(account: EmailAccountRow): string | { email: string; name: string } {
  return account.display_name && account.display_name !== account.address
    ? { email: account.address, name: account.display_name }
    : account.address
}

export function headerList(account: EmailAccountRow, input: EmailSendInput, outgoingId: string): string {
  const to = normalizeRecipients(input.to, 'to')
  const cc = normalizeRecipients(input.cc, 'cc')
  const bcc = normalizeRecipients(input.bcc, 'bcc')
  return JSON.stringify([
    { key: 'from', value: `${account.display_name} <${account.address}>` },
    { key: 'to', value: to.join(', ') },
    ...(cc.length ? [{ key: 'cc', value: cc.join(', ') }] : []),
    ...(bcc.length ? [{ key: 'bcc', value: bcc.join(', ') }] : []),
    { key: 'subject', value: input.subject },
    { key: 'date', value: new Date().toISOString() },
    { key: 'message-id', value: `<${outgoingId}>` },
    ...(input.inReplyTo ? [{ key: 'in-reply-to', value: `<${input.inReplyTo}>` }] : []),
  ])
}

export async function alreadySent(env: Env, accountId: string, messageId: string): Promise<EmailSendResult> {
  const row = await emailMailbox(env, accountId).getEmail(messageId)
  return { id: messageId, status: (row?.delivery_status as EmailSendResult['status']) ?? 'sent' }
}

export interface DraftSendOutcome {
  result: EmailSendResult
  replayed: boolean
}

export async function sendDraftEmail(
  env: Env,
  userId: string,
  account: EmailAccountRow,
  draftId: string,
  input: EmailSendInput,
): Promise<DraftSendOutcome> {
  const mailbox = emailMailbox(env, account.id)
  const draft = await mailbox.getEmail(draftId)
  if (!draft || draft.folder_id !== 'draft') throw ApiError.notFound('Draft not found')
  const to = normalizeRecipients(input.to, 'to')
  const cc = normalizeRecipients(input.cc, 'cc')
  const bcc = normalizeRecipients(input.bcc, 'bcc')
  const body = validateBody(input)
  const rate = await mailbox.checkSendRateLimit()
  if (rate) throw new ApiError(429, 'email_rate_limited', rate)
  const requestHash = await sha256Hex(JSON.stringify({ mode: 'draft', account: account.id, draftId, input }))
  const claim = await mailbox.claimOperation(input.operationId.trim(), requestHash, draftId)
  if (claim.status === 'conflict') throw ApiError.conflict('operationId was already used with different arguments')
  if (claim.status === 'duplicate') {
    return { result: await alreadySent(env, account.id, draftId), replayed: true }
  }
  const attachments = await loadOutgoingAttachments(env, userId, draftId, [...new Set([
    ...(input.attachmentIds ?? []),
    ...((await loadEmailAttachments(env.DB, userId, [draftId])).get(draftId) ?? []).map((entry) => entry.id),
  ])], true)
  let references: string[] = []
  let threadId = draft.thread_id || draftId
  let inReplyTo = draft.in_reply_to
  const original = inReplyTo ? await mailbox.getEmail(inReplyTo) : null
  if (original) {
    try {
      const parsed: unknown = JSON.parse(original.email_references ?? '[]')
      references = Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
    } catch {
      references = []
    }
    const originalMsgId = original.message_id || original.id
    references = [...references, originalMsgId]
    inReplyTo = originalMsgId
    threadId = original.thread_id || original.id
  }
  const outgoingId = outgoingMessageId(draftId, account.address)
  const headers = inReplyTo ? buildThreadingHeaders(inReplyTo, references) : undefined
  const moved = await mailbox.sendDraft(draftId, {
    body: body.html,
    bodySource: input.body,
    messageId: outgoingId,
    date: Date.now(),
    sender: account.address,
    recipient: to.join(', '),
    cc: cc.length ? cc.join(', ') : null,
    bcc: bcc.length ? bcc.join(', ') : null,
    inReplyTo,
    threadId,
    emailReferences: references.length ? JSON.stringify(references) : null,
    rawHeaders: headerList(account, input, outgoingId),
    subject: input.subject,
  })
  if (!moved) throw ApiError.notFound('Draft not found')
  await lockEmailAttachments(env.DB, userId, draftId)
  try {
    const sent = await sendViaBinding(env, {
      to: to.length === 1 ? to[0]! : to,
      cc: cc.length ? (cc.length === 1 ? cc[0]! : cc) : undefined,
      bcc: bcc.length ? (bcc.length === 1 ? bcc[0]! : bcc) : undefined,
      from: sender(account),
      subject: input.subject,
      html: body.html,
      text: body.text,
      ...(attachments.length ? { attachments } : {}),
      ...(headers ? { headers } : {}),
    })
    await mailbox.updateDelivery(draftId, 'sent', null, sent.messageId)
    void rememberRecipientAddresses(env.DB, userId, [...to, ...cc, ...bcc]).catch((error) => {
      console.warn('[inkstone] sent recipients could not be saved as contacts:', (error as Error).message)
    })
    if (inReplyTo) await mailbox.markThreadRead(threadId)
    return { result: { id: draftId, status: 'sent', messageId: sent.messageId }, replayed: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The email could not be sent'
    await mailbox.updateDelivery(draftId, 'failed', message)
    return { result: { id: draftId, status: 'failed', error: message }, replayed: false }
  }
}

export async function sendStoredEmail(
  env: Env,
  userId: string,
  account: EmailAccountRow,
  row: EmailRow,
): Promise<EmailSendResult> {
  if (row.delivery_status !== 'failed') {
    throw new ApiError(409, 'email_not_retryable', 'Only a failed send can be retried')
  }
  const mailbox = emailMailbox(env, account.id)
  const rate = await mailbox.checkSendRateLimit()
  if (rate) throw new ApiError(429, 'email_rate_limited', rate)
  const to = normalizeRecipients(row.recipient, 'to')
  const cc = normalizeRecipients(row.cc ?? undefined, 'cc')
  const bcc = normalizeRecipients(row.bcc ?? undefined, 'bcc')
  const references = (() => {
    try {
      const parsed: unknown = JSON.parse(row.email_references ?? '[]')
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
    } catch {
      return []
    }
  })()
  const headers = row.in_reply_to ? buildThreadingHeaders(row.in_reply_to, references) : undefined
  let attachments: Awaited<ReturnType<typeof loadOutgoingAttachments>> = []
  if (row.has_attachment) {
    const attached = (await loadEmailAttachments(env.DB, userId, [row.id])).get(row.id) ?? []
    attachments = await loadOutgoingAttachments(env, userId, row.id, attached.map((entry) => entry.id), false)
  }
  try {
    const sent = await sendViaBinding(env, {
      to: to.length === 1 ? to[0]! : to,
      cc: cc.length ? (cc.length === 1 ? cc[0]! : cc) : undefined,
      bcc: bcc.length ? (bcc.length === 1 ? bcc[0]! : bcc) : undefined,
      from: sender(account),
      subject: row.subject,
      html: row.body,
      text: validateBody({ to: row.recipient, subject: row.subject, body: row.body_source ?? '', bodyHtml: row.body, operationId: 'retry' }).text,
      ...(attachments.length ? { attachments } : {}),
      ...(headers ? { headers } : {}),
    })
    await mailbox.updateDelivery(row.id, 'sent', null, sent.messageId)
    void rememberRecipientAddresses(env.DB, userId, [...to, ...cc, ...bcc]).catch((error) => {
      console.warn('[inkstone] sent recipients could not be saved as contacts:', (error as Error).message)
    })
    return { id: row.id, status: 'sent', messageId: sent.messageId }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The email could not be sent'
    await mailbox.updateDelivery(row.id, 'failed', message)
    return { id: row.id, status: 'failed', error: message }
  }
}

import { Hono, type Context } from 'hono'
import type { EmailSendInput, EmailSendResult } from '@shared/email/model'
import { EMAIL_BODY_MAX_BYTES, EMAIL_SUBJECT_MAX_CHARS } from '@shared/email/model'
import { ApiError } from '../lib/errors'
import { sha256Hex } from '../lib/encoding'
import { isValidId, newId } from '../lib/id'
import { readJson } from '../lib/request'
import { requireAuth, requireOwner } from '../middleware/auth'
import type { AppBindings } from '../env'
import { getEmailAccount, type EmailAccountRow } from '../email/account-store'
import { emailMailbox } from '../email/mailbox-stub'
import {
  buildThreadingHeaders,
  loadOutgoingAttachments,
  normalizeRecipients,
  outgoingMessageId,
  sendViaBinding,
  validateBody,
} from '../email/outbound'
import { loadEmailAttachments, lockEmailAttachments } from '../email/attachments'

type Ctx = Context<AppBindings>

const SEND_BODY_LIMIT = EMAIL_BODY_MAX_BYTES * 2 + 128 * 1024


async function requireAccount(c: Ctx): Promise<EmailAccountRow> {
  const id = c.req.param('id') ?? ''
  if (!isValidId(id)) throw ApiError.notFound('Mailbox not found')
  const account = await getEmailAccount(c.env.DB, c.get('userId'), id)
  if (!account) throw ApiError.notFound('Mailbox not found')
  return account
}

function sender(account: EmailAccountRow): string | { email: string; name: string } {
  return account.display_name && account.display_name !== account.address
    ? { email: account.address, name: account.display_name }
    : account.address
}

function headerList(account: EmailAccountRow, input: EmailSendInput, outgoingId: string): string {
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

async function requestBody(c: Ctx): Promise<EmailSendInput> {
  const body = await readJson<EmailSendInput>(c, SEND_BODY_LIMIT)
  if (typeof body.operationId !== 'string' || !body.operationId.trim()) {
    throw ApiError.badRequest('An operationId is required')
  }
  if (typeof body.to !== 'string' || !body.to.trim()) throw ApiError.badRequest('A recipient is required')
  if (typeof body.subject !== 'string' || body.subject.length > EMAIL_SUBJECT_MAX_CHARS) {
    throw ApiError.badRequest('The subject is not valid')
  }
  validateBody(body)
  normalizeRecipients(body.to, 'to')
  normalizeRecipients(body.cc, 'cc')
  normalizeRecipients(body.bcc, 'bcc')
  return body
}

async function alreadySent(env: AppBindings['Bindings'], accountId: string, messageId: string): Promise<EmailSendResult> {
  const row = await emailMailbox(env, accountId).getEmail(messageId)
  return { id: messageId, status: (row?.delivery_status as EmailSendResult['status']) ?? 'sent' }
}

async function sendDirect(c: Ctx, account: EmailAccountRow, input: EmailSendInput, originalId?: string, mode: 'send' | 'reply' | 'forward' = 'send'): Promise<Response> {
  if (input.attachmentIds?.length) throw ApiError.badRequest('Attachments must be sent from a draft')
  const to = normalizeRecipients(input.to, 'to')
  const cc = normalizeRecipients(input.cc, 'cc')
  const bcc = normalizeRecipients(input.bcc, 'bcc')
  const body = validateBody(input)
  const mailbox = emailMailbox(c.env, account.id)
  const rate = await mailbox.checkSendRateLimit()
  if (rate) throw new ApiError(429, 'email_rate_limited', rate)
  const messageId = newId()
  const outgoingId = outgoingMessageId(messageId, account.address)
  const requestHash = await sha256Hex(JSON.stringify({ mode, account: account.id, input }))
  const claim = await mailbox.claimOperation(input.operationId.trim(), requestHash, messageId)
  if (claim.status === 'conflict') throw ApiError.conflict('operationId was already used with different arguments')
  if (claim.status === 'duplicate' && claim.messageId) return c.json(await alreadySent(c.env, account.id, claim.messageId), 200)
  let original = originalId ? await mailbox.getEmail(originalId) : null
  if (original?.folder_id === 'draft' && original.in_reply_to) {
    original = await mailbox.getEmail(original.in_reply_to) ?? original
  }
  if (originalId && !original) throw ApiError.notFound('Original email not found')
  let references: string[] = []
  let threadId = messageId
  let inReplyTo: string | null = null
  if (original && mode === 'reply') {
    try {
      const parsed: unknown = JSON.parse(original.email_references ?? '[]')
      references = Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
    } catch {
      references = []
    }
    const originalMsgId = original.message_id || original.id
    references = [...references, originalMsgId]
    threadId = original.thread_id || original.id
    inReplyTo = originalMsgId
  }
  if (original && mode === 'forward') {
    inReplyTo = null
    references = []
    threadId = messageId
  }
  const headers = original && mode === 'reply' && inReplyTo
    ? buildThreadingHeaders(inReplyTo, references)
    : undefined
  const created = await mailbox.createEmail('sent', {
    id: messageId,
    subject: input.subject,
    sender: account.address,
    recipient: to.join(', '),
    cc: cc.length ? cc.join(', ') : null,
    bcc: bcc.length ? bcc.join(', ') : null,
    date: Date.now(),
    body: body.html,
    bodySource: input.body,
    threadId,
    inReplyTo,
    emailReferences: references.length ? JSON.stringify(references) : null,
    messageId: outgoingId,
    rawHeaders: headerList(account, input, outgoingId),
    deliveryStatus: 'pending',
    size: new TextEncoder().encode(body.html).byteLength,
  })
  if (!created) throw new ApiError(500, 'internal', 'The sent message could not be stored')
  try {
    const sent = await sendViaBinding(c.env, {
      to: to.length === 1 ? to[0]! : to,
      cc: cc.length ? (cc.length === 1 ? cc[0]! : cc) : undefined,
      bcc: bcc.length ? (bcc.length === 1 ? bcc[0]! : bcc) : undefined,
      from: sender(account),
      subject: input.subject,
      html: body.html,
      text: body.text,
      ...(headers ? { headers } : {}),
    })
    await mailbox.updateDelivery(messageId, 'sent', null, sent.messageId)
    if (mode === 'reply' && original) await mailbox.markThreadRead(threadId)
    return c.json({ id: messageId, status: 'sent', messageId: sent.messageId } satisfies EmailSendResult, 202)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The email could not be sent'
    await mailbox.updateDelivery(messageId, 'failed', message)
    return c.json({ id: messageId, status: 'failed', error: message } satisfies EmailSendResult, 502)
  }
}

export const emailSendRoutes = new Hono<AppBindings>()

emailSendRoutes.use('*', requireAuth)
emailSendRoutes.use('*', requireOwner)

emailSendRoutes.post('/accounts/:id/emails', async (c) => {
  const account = await requireAccount(c)
  return sendDirect(c, account, await requestBody(c))
})

emailSendRoutes.post('/accounts/:id/emails/:messageId/reply', async (c) => {
  const account = await requireAccount(c)
  return sendDirect(c, account, await requestBody(c), c.req.param('messageId') ?? '', 'reply')
})

emailSendRoutes.post('/accounts/:id/emails/:messageId/forward', async (c) => {
  const account = await requireAccount(c)
  return sendDirect(c, account, await requestBody(c), c.req.param('messageId') ?? '', 'forward')
})

emailSendRoutes.post('/accounts/:id/drafts/:draftId/send', async (c) => {
  const account = await requireAccount(c)
  const draftId = c.req.param('draftId') ?? ''
  if (!isValidId(draftId)) throw ApiError.notFound('Draft not found')
  const input = await requestBody(c)
  const mailbox = emailMailbox(c.env, account.id)
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
  if (claim.status === 'duplicate') return c.json(await alreadySent(c.env, account.id, draftId), 200)
  const attachments = await loadOutgoingAttachments(c.env, c.get('userId'), draftId, [...new Set([
    ...(input.attachmentIds ?? []),
    ...((await loadEmailAttachments(c.env.DB, c.get('userId'), [draftId])).get(draftId) ?? []).map((entry) => entry.id),
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
  await lockEmailAttachments(c.env.DB, c.get('userId'), draftId)
  try {
    const sent = await sendViaBinding(c.env, {
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
    if (inReplyTo) await mailbox.markThreadRead(threadId)
    return c.json({ id: draftId, status: 'sent', messageId: sent.messageId } satisfies EmailSendResult, 202)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The email could not be sent'
    await mailbox.updateDelivery(draftId, 'failed', message)
    return c.json({ id: draftId, status: 'failed', error: message } satisfies EmailSendResult, 502)
  }
})

emailSendRoutes.post('/accounts/:id/emails/:messageId/retry', async (c) => {
  const account = await requireAccount(c)
  const messageId = c.req.param('messageId') ?? ''
  if (!isValidId(messageId)) throw ApiError.notFound('Email not found')
  const mailbox = emailMailbox(c.env, account.id)
  const row = await mailbox.getEmail(messageId)
  if (!row) throw ApiError.notFound('Email not found')
  if (row.delivery_status !== 'failed') throw new ApiError(409, 'email_not_retryable', 'Only a failed send can be retried')
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
    const attached = (await loadEmailAttachments(c.env.DB, c.get('userId'), [messageId])).get(messageId) ?? []
    attachments = await loadOutgoingAttachments(c.env, c.get('userId'), messageId, attached.map((entry) => entry.id), false)
  }
  try {
    const sent = await sendViaBinding(c.env, {
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
    await mailbox.updateDelivery(messageId, 'sent', null, sent.messageId)
    return c.json({ id: messageId, status: 'sent', messageId: sent.messageId } satisfies EmailSendResult, 202)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The email could not be sent'
    await mailbox.updateDelivery(messageId, 'failed', message)
    return c.json({ id: messageId, status: 'failed', error: message } satisfies EmailSendResult, 502)
  }
})


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
  normalizeRecipients,
  outgoingMessageId,
  sendViaBinding,
  validateBody,
} from '../email/outbound'
import { alreadySent, headerList, sendDraftEmail, sendStoredEmail, sender } from '../email/send-service'
import { rememberRecipientAddresses } from '../email/contacts'

type Ctx = Context<AppBindings>

const SEND_BODY_LIMIT = EMAIL_BODY_MAX_BYTES * 2 + 128 * 1024


async function requireAccount(c: Ctx): Promise<EmailAccountRow> {
  const id = c.req.param('id') ?? ''
  if (!isValidId(id)) throw ApiError.notFound('Mailbox not found')
  const account = await getEmailAccount(c.env.DB, c.get('userId'), id)
  if (!account) throw ApiError.notFound('Mailbox not found')
  return account
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
    void rememberRecipientAddresses(c.env.DB, c.get('userId'), [...to, ...cc, ...bcc]).catch((error) => {
      console.warn('[inkstone] sent recipients could not be saved as contacts:', (error as Error).message)
    })
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
  const outcome = await sendDraftEmail(c.env, c.get('userId'), account, draftId, input)
  const status = outcome.replayed ? 200 : outcome.result.status === 'sent' ? 202 : 502
  return c.json(outcome.result, status)
})

emailSendRoutes.post('/accounts/:id/emails/:messageId/retry', async (c) => {
  const account = await requireAccount(c)
  const messageId = c.req.param('messageId') ?? ''
  if (!isValidId(messageId)) throw ApiError.notFound('Email not found')
  const mailbox = emailMailbox(c.env, account.id)
  const row = await mailbox.getEmail(messageId)
  if (!row) throw ApiError.notFound('Email not found')
  const result = await sendStoredEmail(c.env, c.get('userId'), account, row)
  return c.json(result, result.status === 'sent' ? 202 : 502)
})


import PostalMime from 'postal-mime'
import {
  EMAIL_ATTACHMENT_MAX_BYTES,
  EMAIL_INBOUND_MAX_BYTES,
  EMAIL_SUBJECT_MAX_CHARS,
  EMAIL_VACATION_AUTO_SUBJECT_PREFIX,
  normalizeEmailVacation,
} from '@shared/email/model'
import type { EmailVacationSettings } from '@shared/email/model'
import { textToEmailHtml } from '@shared/email/format'
import { normalizeEmailSenderAddress } from '@shared/email/rules'
import { deleteAttachmentObjects, selectAttachmentStorage } from '../attachments/backend'
import { persistEmailAttachment } from '../attachments/storage'
import type { Env } from '../env'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { queueAutoDraftJob, readAccountSettings, type EmailAccountRow } from './account-store'
import { deleteEmailAttachments } from './attachments'
import { rememberRecipientAddresses, findEmailContactByEmail } from './contacts'
import { emailMailbox } from './mailbox-stub'
import { buildThreadingHeaders, sendViaBinding } from './outbound'

export const MAX_MAILBOX_INBOUND_BYTES = EMAIL_INBOUND_MAX_BYTES

const MAX_MESSAGE_ID_CHARS = 512

const FUTURE_DATE_SLACK_MS = 24 * 60 * 60 * 1000

const MESSAGE_ID_RE = /<([^<>\s]+)>/g

type ParsedEmail = Awaited<ReturnType<typeof PostalMime.parse>>

type ParsedAttachment = ParsedEmail['attachments'][number]

export type MailboxInboundResult = 'created' | 'duplicate' | 'dropped'

interface AddressLike {
  name?: string
  address?: string
  group?: readonly AddressLike[]
}

interface PersistedInboundAttachments {
  keys: string[]
  count: number
  skipped: boolean
}

export function normalizeEnvelopeAddress(value: string): string {
  return normalizeEmailSenderAddress(value)
}

export function extractInboundMessageIds(value: string | null | undefined): string[] {
  if (!value) return []
  const ids: string[] = []
  for (const match of value.matchAll(MESSAGE_ID_RE)) {
    if (match[1]) ids.push(match[1])
  }
  return ids
}

export function clampInboundDate(value: string | undefined, receivedAt: number): number {
  const time = Date.parse(value ?? '')
  if (!Number.isFinite(time)) return receivedAt
  if (time < 0 || time > receivedAt + FUTURE_DATE_SLACK_MS) return receivedAt
  return time
}

export async function readRawWithCap(
  stream: ReadableStream<Uint8Array>,
  cap = MAX_MAILBOX_INBOUND_BYTES,
): Promise<Uint8Array | null> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value?.byteLength) continue
    size += value.byteLength
    if (size > cap) {
      try {
        await reader.cancel()
      } catch (error) {
        console.warn('[inkstone] inbound mail stream could not be cancelled after the size ceiling', error)
      }
      return null
    }
    chunks.push(value)
  }
  const raw = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    raw.set(chunk, offset)
    offset += chunk.byteLength
  }
  return raw
}

export async function handleMailboxInbound(
  message: ForwardableEmailMessage,
  account: EmailAccountRow,
  env: Env,
  _ctx: ExecutionContext,
): Promise<MailboxInboundResult> {
  if (message.rawSize > MAX_MAILBOX_INBOUND_BYTES) {
    console.warn(`[inkstone] inbound mail rejected: ${message.rawSize} bytes over the ${MAX_MAILBOX_INBOUND_BYTES}-byte mailbox ceiling`)
    throw new Error('The inbound message exceeds the mailbox size limit')
  }
  const raw = await readRawWithCap(message.raw)
  if (!raw) {
    console.warn(`[inkstone] inbound mail rejected: the stream exceeded ${MAX_MAILBOX_INBOUND_BYTES} bytes`)
    throw new Error('The inbound message exceeds the mailbox size limit')
  }

  let parsed: ParsedEmail
  try {
    parsed = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' })
  } catch (error) {
    console.error('[inkstone] inbound mail could not be parsed', error)
    throw error
  }

  const sender = normalizeEnvelopeAddress(message.from)
  if (sender && sender === account.address_normalized) {
    console.warn('[inkstone] inbound mail dropped: the message is addressed from its own mailbox')
    return 'dropped'
  }

  const receivedAt = Date.now()
  const messageKey = await inboundKey(parsed.messageId, raw)
  const mailbox = emailMailbox(env, account.id)
  if (!(await mailbox.claimInbound(messageKey, receivedAt))) return 'duplicate'

  const emailId = newId()
  let attachmentKeys: string[] = []
  let emailStored = false
  try {
    const attachments = await persistInboundAttachments(env, account, emailId, parsed.attachments, receivedAt)
    attachmentKeys = attachments.keys

    const references = extractInboundMessageIds(parsed.references)
    const inReplyTo = extractInboundMessageIds(parsed.inReplyTo)[0] ?? null
    const headerMessageId = (parsed.messageId ?? '').trim()
    const messageId = headerMessageId && headerMessageId.length <= MAX_MESSAGE_ID_CHARS ? headerMessageId : null
    const subject = parsed.subject ?? ''
    const headerThreadId = references[0] ?? inReplyTo ?? null
    const knownThreadId = headerThreadId ? await mailbox.findThreadIdByMessageId(headerThreadId) : null
    const subjectThreadId = headerThreadId ? null : await mailbox.findThreadBySubject(subject, sender)
    const threadId = knownThreadId ?? headerThreadId ?? subjectThreadId ?? messageId ?? emailId

    const storedSender = formatAddressList(parsed.from ? [parsed.from] : [])
      || formatAddressList(parsed.sender ? [parsed.sender] : [])
      || sender
    const recipient = formatAddressList(parsed.to) || account.address
    const cc = formatAddressList(parsed.cc) || null
    const bcc = formatAddressList(parsed.bcc) || null
    const senderAddress = normalizeEmailSenderAddress(parsed.from?.address ?? '') || sender

    const plan = await mailbox.evaluateInboundRules({
      sender: storedSender,
      senderAddress,
      recipient,
      cc,
      bcc,
      subject,
      hasAttachment: attachments.count > 0,
      size: message.rawSize,
    })

    const focused = await resolveInboundFocus(env, account, mailbox, {
      automated: isAutomatedMessage(parsed.headers),
      senderAddress,
      replyThreadId: headerThreadId ?? subjectThreadId,
    })

    const created = await mailbox.createEmail(plan.folderId, {
      id: emailId,
      subject,
      sender: storedSender,
      recipient,
      cc,
      bcc,
      date: clampInboundDate(parsed.date, receivedAt),
      body: parsed.html || parsed.text || '',
      bodySource: null,
      read: plan.read,
      starred: plan.starred,
      focused,
      inReplyTo,
      emailReferences: JSON.stringify(references),
      threadId,
      messageId,
      rawHeaders: JSON.stringify(parsed.headers.map((header) => ({ key: header.key, value: header.value }))),
      attachmentsSkipped: attachments.skipped,
      hasAttachment: attachments.count > 0,
      size: message.rawSize,
    })
    if (!created) throw new Error('The mailbox did not accept the inbound message')
    emailStored = true
    if (plan.tagPaths.length) await mailbox.attachTagPaths(emailId, plan.tagPaths)
    if (plan.trash) await mailbox.trashEmail(emailId)
    if (!plan.blocked && !plan.trash) {
      void rememberRecipientAddresses(env.DB, account.user_id, [storedSender]).catch((error) => {
        console.warn('[inkstone] inbound sender could not be saved as a contact:', (error as Error).message)
      })
    }

    if (!plan.trash && plan.folderId !== 'spam') {
      await enqueueAutoDraft(env, account, emailId, threadId, parsed.headers)
    }
    await mailbox.completeInbound(messageKey)
    if (!plan.blocked && !plan.trash && plan.folderId !== 'spam') {
      try {
        await sendVacationReply(env, account, sender, parsed, mailbox, receivedAt)
      } catch (error) {
        console.warn('[inkstone] vacation auto-reply could not be prepared', error)
      }
    }
    return 'created'
  } catch (error) {
    console.error('[inkstone] inbound mail could not be stored', error)
    if (emailStored) {
      try {
        await mailbox.deleteEmail(emailId)
      } catch (deleteError) {
        console.warn('[inkstone] inbound message row could not be rolled back', deleteError)
      }
    }
    await discardEmailAttachments(env, account.user_id, emailId, attachmentKeys)
    try {
      await mailbox.releaseInbound(messageKey)
    } catch (releaseError) {
      console.error('[inkstone] inbound mail claim could not be released', releaseError)
    }
    throw error
  }
}

function formatAddressList(addresses: readonly AddressLike[] | undefined): string {
  if (!addresses?.length) return ''
  return addresses
    .flatMap((address) => address.group ?? [address])
    .map((address) => {
      const mailbox = (address.address ?? '').trim()
      const name = (address.name ?? '').trim()
      if (!mailbox) return name
      return name ? `${name} <${mailbox}>` : mailbox
    })
    .filter(Boolean)
    .join(', ')
}

function headerValue(headers: readonly { key: string; value: string }[], name: string): string | null {
  for (const header of headers) {
    if (header.key.toLowerCase() === name) return header.value
  }
  return null
}

function isAutomatedMessage(headers: readonly { key: string; value: string }[]): boolean {
  const autoSubmitted = headerValue(headers, 'auto-submitted')?.trim().toLowerCase()
  if (autoSubmitted && autoSubmitted !== 'no') return true
  const precedence = headerValue(headers, 'precedence')?.trim().toLowerCase()
  return precedence === 'bulk' || precedence === 'list' || precedence === 'junk'
}

async function resolveInboundFocus(
  env: Env,
  account: EmailAccountRow,
  mailbox: ReturnType<typeof emailMailbox>,
  input: { automated: boolean; senderAddress: string; replyThreadId: string | null },
): Promise<boolean> {
  if (readAccountSettings(account.settings).focusedInbox === false) return true
  if (input.automated) return false
  if (input.replyThreadId && await mailbox.hasThread(input.replyThreadId)) return true
  if (!input.senderAddress) return false
  if (await mailbox.hasSenderHistory(input.senderAddress)) return true
  return (await findEmailContactByEmail(env.DB, account.user_id, input.senderAddress)) !== null
}

async function enqueueAutoDraft(
  env: Env,
  account: EmailAccountRow,
  messageId: string,
  threadId: string,
  headers: readonly { key: string; value: string }[],
): Promise<void> {
  if (readAccountSettings(account.settings).autoDraft === false) return
  if (isAutomatedMessage(headers)) return
  try {
    await queueAutoDraftJob(env.DB, {
      userId: account.user_id,
      accountId: account.id,
      messageId,
      threadId,
    })
  } catch (error) {
    console.warn('[inkstone] inbound auto-draft job could not be queued', error)
  }
}

const VACATION_CLAIM_PREFIX = 'vacation'
const VACATION_OPEN_WINDOW = 'always'
const NO_REPLY_LOCAL_PARTS = new Set(['mailer-daemon', 'postmaster'])
const HEADER_UNSAFE_RE = /[\u0000-\u001f\u007f]+/g

function vacationClaimKey(account: EmailAccountRow, sender: string, vacation: EmailVacationSettings): string {
  const window = vacation.start === null ? VACATION_OPEN_WINDOW : String(vacation.start)
  return `${VACATION_CLAIM_PREFIX}:${account.id}:${sender}:${window}`
}

function vacationReplySubject(vacation: EmailVacationSettings, original: string): string {
  const configured = vacation.subject.replace(HEADER_UNSAFE_RE, ' ').replace(/\s+/g, ' ').trim()
  const incoming = original.replace(HEADER_UNSAFE_RE, ' ').replace(/\s+/g, ' ').trim()
  const subject = configured || `${EMAIL_VACATION_AUTO_SUBJECT_PREFIX} ${incoming}`.trim()
  return subject.slice(0, EMAIL_SUBJECT_MAX_CHARS)
}

function vacationHeaders(parsed: ParsedEmail): Record<string, string> {
  const headers: Record<string, string> = { 'Auto-Submitted': 'auto-replied' }
  const original = extractInboundMessageIds(parsed.messageId)[0]
  if (original && original.length <= MAX_MESSAGE_ID_CHARS && !/[\u0000-\u001f\u007f\s<>]/.test(original)) {
    Object.assign(headers, buildThreadingHeaders(original, []))
  }
  return headers
}

function vacationReplyAllowed(
  account: EmailAccountRow,
  sender: string,
  parsed: ParsedEmail,
  vacation: EmailVacationSettings,
  now: number,
): boolean {
  if (!vacation.enabled) return false
  if (!sender || sender === account.address_normalized) return false
  if (NO_REPLY_LOCAL_PARTS.has((sender.split('@')[0] ?? '').toLowerCase())) return false
  if (vacation.start !== null && now < vacation.start) return false
  if (vacation.end !== null && now > vacation.end) return false
  if (!vacation.body.trim()) return false
  if (!(parsed.text ?? '').trim() && !(parsed.html ?? '').trim()) return false
  return !isAutomatedMessage(parsed.headers)
}

async function sendVacationReply(
  env: Env,
  account: EmailAccountRow,
  sender: string,
  parsed: ParsedEmail,
  mailbox: ReturnType<typeof emailMailbox>,
  now: number,
): Promise<void> {
  if (!env.EMAIL) return
  const vacation = normalizeEmailVacation(readAccountSettings(account.settings))
  if (!vacationReplyAllowed(account, sender, parsed, vacation, now)) return
  const claimKey = vacationClaimKey(account, sender, vacation)
  if (!(await mailbox.claimInbound(claimKey, now))) return
  const body = vacation.body.trim()
  try {
    await sendViaBinding(env, {
      to: sender,
      from: account.display_name && account.display_name !== account.address
        ? { email: account.address, name: account.display_name }
        : account.address,
      subject: vacationReplySubject(vacation, parsed.subject ?? ''),
      html: textToEmailHtml(body),
      text: body,
      headers: vacationHeaders(parsed),
    })
  } catch (error) {
    console.warn('[inkstone] vacation auto-reply could not be sent', error)
    try {
      await mailbox.releaseInbound(claimKey)
    } catch (releaseError) {
      console.warn('[inkstone] vacation auto-reply claim could not be released', releaseError)
    }
    return
  }
  try {
    await mailbox.completeInbound(claimKey)
  } catch (error) {
    console.warn('[inkstone] vacation auto-reply claim could not be recorded', error)
  }
}

async function inboundKey(header: string | undefined, raw: Uint8Array): Promise<string> {
  const normalized = (header ?? '').trim().replace(/\s+/g, ' ')
  if (normalized && normalized.length <= MAX_MESSAGE_ID_CHARS) return normalized
  return `sha256:${await sha256Hex(raw)}`
}

function attachmentBytes(content: ParsedAttachment['content']): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content)
  if (content instanceof Uint8Array) return content
  return new Uint8Array(content)
}

async function persistInboundAttachments(
  env: Env,
  account: EmailAccountRow,
  emailId: string,
  attachments: readonly ParsedAttachment[],
  createdAt: number,
): Promise<PersistedInboundAttachments> {
  if (!attachments.length) return { keys: [], count: 0, skipped: false }
  if (selectAttachmentStorage(env) !== 'r2') {
    console.warn('[inkstone] inbound attachments skipped: R2 storage is not configured')
    return { keys: [], count: 0, skipped: true }
  }

  const keys: string[] = []
  let total = 0
  for (const [index, attachment] of attachments.entries()) {
    const bytes = attachmentBytes(attachment.content)
    if (total + bytes.byteLength > EMAIL_ATTACHMENT_MAX_BYTES) {
      await discardEmailAttachments(env, account.user_id, emailId, keys)
      console.warn('[inkstone] inbound attachments skipped: the message carries more than the attachment ceiling')
      return { keys: [], count: 0, skipped: true }
    }
    try {
      const persisted = await persistEmailAttachment(env, {
        id: newId(),
        userId: account.user_id,
        accountId: account.id,
        emailId,
        filename: attachment.filename || `attachment-${index + 1}`,
        reportedMime: attachment.mimeType || 'application/octet-stream',
        bytes,
        contentId: attachment.contentId ?? null,
        disposition: attachment.disposition ?? null,
        locked: true,
        createdAt,
      })
      keys.push(persisted.objectKey)
      total += bytes.byteLength
    } catch (error) {
      const skippable = error instanceof ApiError
        && (error.status === 413 || error.code === 'storage_unavailable')
      await discardEmailAttachments(env, account.user_id, emailId, keys)
      if (!skippable) throw error
      console.warn('[inkstone] inbound attachments skipped: the mailbox quota or storage refused them')
      return { keys: [], count: 0, skipped: true }
    }
  }
  return { keys, count: keys.length, skipped: false }
}

async function discardEmailAttachments(
  env: Env,
  userId: string,
  emailId: string,
  keys: readonly string[],
): Promise<void> {
  try {
    await deleteEmailAttachments(env.DB, userId, [emailId])
  } catch (error) {
    console.warn('[inkstone] inbound attachment rows could not be removed', error)
  }
  if (!keys.length) return
  if (!env.FILES) {
    console.warn('[inkstone] inbound attachment objects could not be removed: R2 is not configured')
    return
  }
  try {
    await deleteAttachmentObjects(env, 'r2', [...keys])
  } catch (error) {
    console.warn('[inkstone] inbound attachment objects could not be removed', error)
  }
}

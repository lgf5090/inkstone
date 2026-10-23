import PostalMime from 'postal-mime'
import { EMAIL_ATTACHMENT_MAX_BYTES, EMAIL_INBOUND_MAX_BYTES } from '@shared/email/model'
import { deleteAttachmentObjects, selectAttachmentStorage } from '../attachments/backend'
import { persistEmailAttachment } from '../attachments/storage'
import type { Env } from '../env'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { queueAutoDraftJob, readAccountSettings, type EmailAccountRow } from './account-store'
import { deleteEmailAttachments } from './attachments'
import { rememberRecipientAddresses } from './contacts'
import { emailMailbox } from './mailbox-stub'

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
  const text = value.trim()
  const open = text.lastIndexOf('<')
  const close = open >= 0 ? text.indexOf('>', open + 1) : -1
  const address = open >= 0 && close > open ? text.slice(open + 1, close).trim() : text
  return address.toLowerCase()
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
    const subjectThreadId = headerThreadId ? null : await mailbox.findThreadBySubject(subject, sender)
    const threadId = headerThreadId ?? subjectThreadId ?? messageId ?? emailId

    const storedSender = formatAddressList(parsed.from ? [parsed.from] : [])
      || formatAddressList(parsed.sender ? [parsed.sender] : [])
      || sender
    const recipient = formatAddressList(parsed.to) || account.address
    const cc = formatAddressList(parsed.cc) || null
    const bcc = formatAddressList(parsed.bcc) || null

    const created = await mailbox.createEmail('inbox', {
      id: emailId,
      subject,
      sender: storedSender,
      recipient,
      cc,
      bcc,
      date: clampInboundDate(parsed.date, receivedAt),
      body: parsed.html || parsed.text || '',
      bodySource: null,
      read: false,
      starred: false,
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
    void rememberRecipientAddresses(env.DB, account.user_id, [storedSender]).catch((error) => {
      console.warn('[inkstone] inbound sender could not be saved as a contact:', (error as Error).message)
    })

    await enqueueAutoDraft(env, account, emailId, threadId, parsed.headers)
    await mailbox.completeInbound(messageKey)
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
  return precedence === 'bulk' || precedence === 'list'
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

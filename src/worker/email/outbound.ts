import type { EmailAccountSettings, EmailSendInput } from '@shared/email/model'
import { EMAIL_BODY_MAX_BYTES, EMAIL_RECIPIENTS_MAX } from '@shared/email/model'
import { stripEmailHtmlToText } from '@shared/email/format'
import { ApiError } from '../lib/errors'
import { decryptEmailSecret } from '../lib/crypto'
import type { Env } from '../env'
import { readEmailDeployment } from './deployment'

export interface OutgoingAttachmentRow {
  id: string
  filename: string
  mime: string
  object_key: string
  disposition: string | null
  content_id: string | null
}

export interface SendBindingParams {
  to: string | string[]
  cc?: string | string[]
  bcc?: string | string[]
  from: string | { email: string; name: string }
  subject: string
  html?: string
  text?: string
  attachments?: {
    content: string
    filename: string
    type: string
    disposition: 'attachment' | 'inline'
    contentId?: string
  }[]
  headers?: Record<string, string>
}

export function normalizeRecipients(value: string | undefined, field: string): string[] {
  if (!value) return []
  const entries = value
    .split(/[,;]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  if (entries.length > EMAIL_RECIPIENTS_MAX) {
    throw ApiError.badRequest(`Too many recipients in ${field}`)
  }
  for (const entry of entries) {
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(entry)) {
      throw ApiError.badRequest(`Invalid recipient in ${field}: ${entry}`)
    }
  }
  return [...new Set(entries)]
}

export function validateFrom(accountAddress: string, from: string): { address: string; name: string | null } {
  const value = from.trim()
  if (!value) throw ApiError.badRequest('A sender address is required')
  const match = /^(.*?)<([^<>]+)>$/.exec(value)
  const address = (match ? match[2]! : value).trim().toLowerCase()
  if (address !== accountAddress.toLowerCase()) {
    throw ApiError.badRequest('The sender must be the mailbox address')
  }
  const name = match?.[1]?.trim().replace(/^"|"$/g, '') || null
  return { address, name }
}

export function buildThreadingHeaders(originalMessageId: string, references: readonly string[]): Record<string, string> {
  return {
    'In-Reply-To': `<${originalMessageId}>`,
    ...(references.length ? { References: references.map((reference) => `<${reference}>`).join(' ') } : {}),
  }
}

export function replyToHeader(settings: EmailAccountSettings): Record<string, string> {
  const replyTo = settings.replyTo?.trim()
  return replyTo ? { 'Reply-To': replyTo } : {}
}

export function outgoingMessageId(id: string, address: string): string {
  const domain = address.split('@')[1]
  if (!domain) throw ApiError.badRequest('The sender domain is missing')
  return `${id}@${domain}`
}

export function validateBody(input: EmailSendInput): { html: string; text: string } {
  const html = input.bodyHtml ?? ''
  const text = stripEmailHtmlToText(html)
  if (!html.trim() && !text.trim()) throw ApiError.badRequest('The message is empty')
  if (new TextEncoder().encode(html).byteLength > EMAIL_BODY_MAX_BYTES) {
    throw ApiError.tooLarge('The message body exceeds the 5 MB limit')
  }
  return { html, text }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

export async function loadOutgoingAttachments(
  env: Env,
  userId: string,
  messageId: string,
  attachmentIds: readonly string[],
  requireUnlocked = true,
): Promise<NonNullable<SendBindingParams['attachments']>> {
  if (!attachmentIds.length) return []
  if (!env.FILES) throw new ApiError(503, 'storage_unavailable', 'Email attachments require R2 storage')
  const placeholders = attachmentIds.map((_, index) => `?${index + 3}`).join(',')
  const { results } = await env.DB.prepare(
    `SELECT id, filename, mime, object_key, disposition, content_id
       FROM email_attachments
      WHERE user_id = ?1 AND email_id = ?2 ${requireUnlocked ? 'AND locked = 0' : ''} AND id IN (${placeholders})`,
  ).bind(userId, messageId, ...attachmentIds).all<OutgoingAttachmentRow>()
  const byId = new Map(results.map((row) => [row.id, row]))
  const attachments: NonNullable<SendBindingParams['attachments']> = []
  for (const id of attachmentIds) {
    const row = byId.get(id)
    if (!row) throw ApiError.badRequest(`Attachment ${id} is not linked to this draft`)
    const object = await env.FILES.get(row.object_key)
    if (!object) throw ApiError.notFound(`Attachment ${row.filename} is missing`)
    attachments.push({
      content: bytesToBase64(new Uint8Array(await object.arrayBuffer())),
      filename: row.filename,
      type: row.mime,
      disposition: row.disposition === 'inline' ? 'inline' : 'attachment',
      ...(row.content_id ? { contentId: row.content_id } : {}),
    })
  }
  return attachments
}

export async function sendViaBinding(env: Env, params: SendBindingParams): Promise<{ messageId: string }> {
  if (!env.EMAIL) {
    throw new ApiError(503, 'email_send_unavailable', 'Outbound email is not configured')
  }
  const message: Record<string, unknown> = {
    to: params.to,
    from: params.from,
    subject: params.subject,
  }
  if (params.html) message.html = params.html
  if (params.text) message.text = params.text
  if (params.cc) message.cc = params.cc
  if (params.bcc) message.bcc = params.bcc
  if (params.attachments?.length) message.attachments = params.attachments
  if (params.headers && Object.keys(params.headers).length) message.headers = params.headers
  const result = await env.EMAIL.send(message as never)
  return { messageId: result.messageId }
}

function resendFrom(value: string | { email: string; name: string }): string {
  return typeof value === 'string' ? value : `${value.name} <${value.email}>`
}

async function sendViaResend(apiKey: string, from: string, params: SendBindingParams): Promise<{ messageId: string }> {
  const replyTo = params.headers?.['Reply-To'] ?? params.headers?.['reply-to']
  const headers = Object.fromEntries(
    Object.entries(params.headers ?? {}).filter(([key]) => key.toLowerCase() !== 'reply-to'),
  )
  const body: Record<string, unknown> = {
    from,
    to: Array.isArray(params.to) ? params.to : [params.to],
    subject: params.subject,
    ...(params.html ? { html: params.html } : {}),
    ...(params.text ? { text: params.text } : {}),
    ...(params.cc ? { cc: Array.isArray(params.cc) ? params.cc : [params.cc] } : {}),
    ...(params.bcc ? { bcc: Array.isArray(params.bcc) ? params.bcc : [params.bcc] } : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(params.attachments?.length
      ? {
          attachments: params.attachments.map((attachment) => ({
            filename: attachment.filename,
            content: attachment.content,
            ...(attachment.type ? { content_type: attachment.type } : {}),
            ...(attachment.contentId ? { content_id: attachment.contentId } : {}),
          })),
        }
      : {}),
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new ApiError(502, 'email_send_failed', `Resend refused the message (${response.status})`)
  }
  const result = await response.json() as { id?: unknown }
  if (typeof result.id !== 'string' || !result.id) {
    throw new ApiError(502, 'email_send_failed', 'Resend did not return a message id')
  }
  return { messageId: result.id }
}

export async function sendViaProvider(env: Env, userId: string, params: SendBindingParams): Promise<{ messageId: string }> {
  const deployment = await readEmailDeployment(env.DB)
  if (deployment?.provider === 'resend') {
    const apiKey = deployment.resendKeyCiphertext
      ? await decryptEmailSecret(env, userId, deployment.resendKeyCiphertext)
      : null
    if (!apiKey) throw new ApiError(503, 'email_send_unavailable', 'Resend is selected but its API key is not configured')
    return sendViaResend(apiKey, deployment.resendFrom.trim() || resendFrom(params.from), params)
  }
  return sendViaBinding(env, params)
}

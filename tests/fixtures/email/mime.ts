const CRLF = '\r\n'

export interface MimeAttachmentInput {
  filename: string
  content: string | Uint8Array
  mime?: string
  contentId?: string
  disposition?: string
}

export interface MimeMessageInput {
  to: string
  from?: string
  subject?: string
  messageId?: string | null
  inReplyTo?: string | null
  references?: string | null
  date?: string | null
  extraHeaders?: Record<string, string>
  text?: string | null
  html?: string | null
  attachments?: readonly MimeAttachmentInput[]
}

export interface ForwardedMailInput {
  to: string
  from?: string
  raw?: string
  rawSize?: number
  messageId?: string | null
}

function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content
}

function textPart(contentType: string, body: string): string {
  return [`Content-Type: ${contentType}; charset=utf-8`, '', body].join(CRLF)
}

function alternativePart(input: MimeMessageInput): string {
  const hasText = input.text !== null && input.text !== undefined
  const hasHtml = input.html !== null && input.html !== undefined
  if (hasText && hasHtml) {
    return [
      'Content-Type: multipart/alternative; boundary="inkstone-alt"',
      '',
      '--inkstone-alt',
      textPart('text/plain', input.text!),
      '--inkstone-alt',
      textPart('text/html', input.html!),
      '--inkstone-alt--',
    ].join(CRLF)
  }
  if (hasHtml) return textPart('text/html', input.html!)
  return textPart('text/plain', input.text ?? '')
}

function attachmentPart(attachment: MimeAttachmentInput): string {
  const mime = attachment.mime ?? 'application/octet-stream'
  const disposition = attachment.disposition ?? 'attachment'
  const lines = [
    `Content-Type: ${mime}; name="${attachment.filename}"`,
    `Content-Disposition: ${disposition}; filename="${attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
  ]
  if (attachment.contentId) lines.push(`Content-ID: <${attachment.contentId}>`)
  lines.push('', Buffer.from(bytesOf(attachment.content)).toString('base64'))
  return lines.join(CRLF)
}

function bodyOf(input: MimeMessageInput): { headers: string[]; body: string } {
  const attachments = input.attachments ?? []
  const content = alternativePart(input)
  if (!attachments.length) {
    const [header] = content.split(`${CRLF}${CRLF}`)
    return { headers: header!.split(CRLF), body: content.slice(header!.length + 4) }
  }
  const parts = [
    '--inkstone-mixed',
    content,
    ...attachments.map((attachment) => `--inkstone-mixed${CRLF}${attachmentPart(attachment)}`),
    '--inkstone-mixed--',
    '',
  ]
  return {
    headers: ['MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="inkstone-mixed"'],
    body: parts.join(CRLF),
  }
}

export function buildMime(input: MimeMessageInput): string {
  const headers = [
    `From: ${input.from ?? 'Sender <sender@example.com>'}`,
    `To: ${input.to}`,
  ]
  if (input.subject !== undefined) headers.push(`Subject: ${input.subject}`)
  if (input.messageId) headers.push(`Message-ID: ${input.messageId}`)
  if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo}`)
  if (input.references) headers.push(`References: ${input.references}`)
  if (input.date) headers.push(`Date: ${input.date}`)
  for (const [name, value] of Object.entries(input.extraHeaders ?? {})) headers.push(`${name}: ${value}`)
  const body = bodyOf(input)
  return [...headers, ...body.headers, '', body.body].join(CRLF)
}

export function forwardedMail(input: ForwardedMailInput): ForwardableEmailMessage {
  const raw = input.raw ?? buildMime({ to: input.to, from: input.from })
  const size = input.rawSize ?? new TextEncoder().encode(raw).byteLength
  const messageId = input.messageId === undefined ? null : input.messageId
  return {
    from: input.from ?? 'sender@example.com',
    to: input.to,
    headers: new Headers(messageId ? { 'message-id': messageId } : {}),
    raw: new Blob([raw]).stream(),
    rawSize: size,
    setReject: () => {},
    forward: async () => ({ messageId: 'forwarded' }),
    reply: async () => ({ messageId: 'replied' }),
  } as unknown as ForwardableEmailMessage
}

export function executionContext(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext
}

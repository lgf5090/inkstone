/**
 * Email-to-task: the inbound half.
 *
 * A Cloudflare Email Worker hands this module one delivered message. The recipient address is the
 * capability — `u+<token>@<MAIL_DOMAIN>` — so the token's entropy is the whole authentication and
 * there is no sender allowlist to keep in step with anything. A recipient that does not name a live
 * token is dropped without a reply: a bounce would tell a scanner which guesses were wrong, and the
 * sender of a mistyped address has no way to fix it through us anyway.
 *
 * Only a plain-text body is read. HTML and attachments are deliberately out of scope this round: a
 * task note is text, and rendering a mail author's markup into a Markdown note would be a second
 * injection surface. The envelope sender is recorded on the note's first line, marked "via email",
 * because the visible `From:` header is forgeable while the envelope is what the receiving server
 * authenticated.
 *
 * Idempotency is the Message-ID: delivery is at least once, so a claim row is written before the task
 * and a repeated delivery finds the claim and stops. A message without a Message-ID falls back to a
 * digest of its raw bytes, which is stable across a retry of the same delivery.
 */
import { MAX_TASK_DESCRIPTION_CHARS } from '@shared/todos/model'
import { AssistantStore } from '../assistant/store'
import { initializeDatabase } from '../db/schema'
import type { Env } from '../env'
import { claimMailMessage, findMailTokenOwner, releaseMailMessage } from '../todos/schema'

/** How much raw MIME one delivery may carry. The note itself is capped far below this. */
export const MAX_INBOUND_MAIL_BYTES = 256 * 1024

/** The to-do app's title ceiling, restated because the route that normally enforces it is not here. */
const MAX_TASK_TITLE_CHARS = 300

/** A Message-ID longer than this is hashed instead of stored; RFC 5322 caps a line at 998 bytes. */
const MAX_MESSAGE_ID_CHARS = 512

/** How much of an envelope sender the note's first line may carry. */
const MAX_SENDER_CHARS = 320

/** How long a processed Message-ID is remembered. Far longer than any delivery retry. */
const MAIL_IDEMPOTENCY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000

/** How many random characters an address token carries. 40 × 5 bits = 200 bits. */
export const MAIL_TOKEN_CHARS = 40

/** The 32-symbol alphabet, the same one `lib/id.ts` uses for ids and slugs. */
const MAIL_TOKEN_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

/**
 * The token shape as a recipient spells it: exactly what `newMailToken` can produce.
 *
 * Reading the shape before the database means a mistyped or guessed recipient never causes a query,
 * and `i`, `l`, `o` and `u` cannot appear in a real token, so a scanner cannot even learn which
 * characters the alphabet uses from the timing of its guesses.
 */
export const MAIL_TOKEN_RE = /^[0-9a-hjkmnp-tv-z]{40}$/

/** The one recipient form an address takes, captured as token and domain. */
const RECIPIENT_RE = /^u\+([0-9a-hjkmnp-tv-z]{40})@([^@\s]+)$/

/** One DNS label: letters, digits and inner hyphens, never a leading or trailing hyphen. */
const DOMAIN_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'

/** A bare hostname made of at least two labels; no scheme, port, path or trailing dot survives. */
const DOMAIN_RE = new RegExp(`^(?:${DOMAIN_LABEL}\\.)+${DOMAIN_LABEL}$`)

/** RFC 2047 encoded words, the form a non-ASCII subject arrives in. */
const ENCODED_WORD_RE = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g

/** A fresh address token. Uniform because 256 is a multiple of the 32-symbol alphabet. */
export function newMailToken(): string {
  const bytes = new Uint8Array(MAIL_TOKEN_CHARS)
  crypto.getRandomValues(bytes)
  let token = ''
  for (let index = 0; index < bytes.length; index++) token += MAIL_TOKEN_ALPHABET[bytes[index]! & 31]
  return token
}

/** The `MAIL_DOMAIN` a deployment configured, normalized, or null when it is missing or unusable. */
export function mailDomain(env: Env): string | null {
  const value = (env.MAIL_DOMAIN ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (!value || value.length > 253 || !DOMAIN_RE.test(value)) return null
  return value
}

/** The address a token is delivered to. The domain is already normalized by `mailDomain`. */
export function mailAddress(domain: string, token: string): string {
  return `u+${token}@${domain}`
}

/**
 * The token a delivered recipient names, or null when the address is not one we issued.
 *
 * The domain has to be ours as well: a token that somehow leaked into an address at another domain
 * is somebody else's mail, and the lookup is not made for it.
 */
export function recipientToken(address: string, domain: string): string | null {
  const match = RECIPIENT_RE.exec(bareAddress(address).toLowerCase())
  if (!match || match[2] !== domain) return null
  return match[1] ?? null
}

/** The bare address inside `Name <address>`, or the trimmed input when it is already bare. */
function bareAddress(value: string): string {
  const text = value.trim()
  const open = text.lastIndexOf('<')
  const close = open >= 0 ? text.indexOf('>', open + 1) : -1
  return open >= 0 && close > open ? text.slice(open + 1, close).trim() : text
}

/** The task title a subject becomes: control characters removed, whitespace collapsed, capped. */
export function mailTaskTitle(subject: string): string {
  const clean = subject.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return (clean || '(no subject)').slice(0, MAX_TASK_TITLE_CHARS)
}

/**
 * The note a message becomes: the authenticated sender on the first line, then the plain text.
 *
 * The first line is the anti-spoofing record. It names the envelope sender rather than the visible
 * `From:` header, and "via email" tells the reader which door the task came in through. The body is
 * cut so the whole note respects the to-do app's 10,000-character ceiling, not the body alone.
 */
export function mailTaskDescription(sender: string, body: string): string {
  const from = sender.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_SENDER_CHARS) || 'unknown sender'
  const origin = `From: ${from} via email`
  const text = body.replace(/\u0000/g, '').trim()
  if (!text) return origin
  const room = MAX_TASK_DESCRIPTION_CHARS - origin.length - 2
  return room > 0 ? `${origin}\n\n${text.slice(0, room)}` : origin
}

/** What a delivered message contributes to a task. */
export interface InboundMailContent {
  subject: string
  text: string
}

/**
 * Read a whole RFC 822 message into the two fields a task keeps.
 *
 * The raw bytes are held as a binary string — one character per byte — rather than decoded as UTF-8
 * first: each part carries its own charset, and decoding the envelope as UTF-8 would corrupt a
 * single-part body in another encoding before its part could be read.
 */
export function parseInboundMail(raw: Uint8Array): InboundMailContent {
  const root = parsePart(binaryString(raw))
  const subject = decodeHeaderWords(root.headers.get('subject') ?? '')
  return { subject, text: plainTextOf(root) ?? '' }
}

/** What the handler did with one delivery; the tests read it, production logs only the failures. */
export type InboundMailResult = 'created' | 'duplicate' | 'ignored' | 'too-large' | 'dropped'

/**
 * Turn one delivered message into a task for the account its recipient names.
 *
 * The order is the security: the recipient is recognized before anything is read, the token is
 * resolved before the body is looked at, the size ceiling is checked before the stream is consumed,
 * and the Message-ID claim is written before the task. A drop is a return, never a reply — the one
 * exception is a database failure, which is thrown so Email Routing's retry can try again. Every
 * drop says why in one `warn` line, so an owner whose mail is vanishing has something to read, and
 * no line repeats the recipient: the token in it is the credential.
 */
export async function handleInboundMail(message: ForwardableEmailMessage, env: Env): Promise<InboundMailResult> {
  const domain = mailDomain(env)
  if (!domain) {
    console.warn('[inkstone] inbound mail dropped: MAIL_DOMAIN is not configured')
    return 'ignored'
  }
  const token = recipientToken(message.to, domain)
  if (!token) {
    console.warn('[inkstone] inbound mail dropped: the recipient is not a u+<token> address at MAIL_DOMAIN')
    return 'ignored'
  }

  await initializeDatabase(env)
  const userId = await findMailTokenOwner(env.DB, token)
  if (!userId) {
    // The token is the credential, so the reason is logged without the recipient: a log line that
    // echoed it would hand out a working address to whoever can read the logs.
    console.warn('[inkstone] inbound mail dropped: the recipient names no live mail token')
    return 'ignored'
  }

  const recipient = bareAddress(message.to).toLowerCase()
  const sender = bareAddress(message.from)
  // Loop guard: our own address as the sender means a forward or an auto-reply is bouncing around,
  // and filing it would only feed the loop.
  if (sender.toLowerCase() === recipient) {
    console.warn('[inkstone] inbound mail dropped: the message is addressed from its own recipient')
    return 'ignored'
  }

  if (message.rawSize > MAX_INBOUND_MAIL_BYTES) {
    console.warn(`[inkstone] inbound mail dropped: ${message.rawSize} bytes over the ${MAX_INBOUND_MAIL_BYTES}-byte ceiling`)
    return 'too-large'
  }
  const raw = await readRaw(message.raw)
  if (!raw) {
    console.warn(`[inkstone] inbound mail dropped: the stream exceeded ${MAX_INBOUND_MAIL_BYTES} bytes`)
    return 'too-large'
  }

  let content: InboundMailContent
  try {
    content = parseInboundMail(raw)
  } catch (error) {
    console.error('[inkstone] inbound mail dropped: the message could not be parsed', error)
    return 'dropped'
  }
  // A message with nothing to read is not a task: the subject alone is not the note somebody wrote.
  // The check runs before the claim so a bodyless message leaves no idempotency row behind.
  if (!content.text) {
    console.warn('[inkstone] inbound mail dropped: the message carries no plain-text body')
    return 'dropped'
  }

  const now = Date.now()
  const messageId = await inboundMessageId(message.headers.get('message-id'), raw)
  if (!(await claimMailMessage(env.DB, userId, messageId, now, now - MAIL_IDEMPOTENCY_WINDOW_MS))) {
    return 'duplicate'
  }

  try {
    await new AssistantStore(env.DB, userId, env).createTask({
      title: mailTaskTitle(content.subject),
      description: mailTaskDescription(sender, content.text),
    })
  } catch (error) {
    try {
      await releaseMailMessage(env.DB, userId, messageId)
    } catch (releaseError) {
      // Best effort: the message is already failing, and a stuck claim only means a retry is
      // treated as a duplicate. Reporting both failures is what lets an operator see the first one.
      console.error('[inkstone] inbound mail claim could not be released', releaseError)
    }
    console.error('[inkstone] inbound mail could not be filed as a task', error)
    throw error
  }
  return 'created'
}

/**
 * The key one delivery is deduplicated by: its Message-ID, or a digest of its bytes when the header
 * is missing or implausibly long. A header is sender-controlled text, so it is normalized and
 * bounded before it is stored; the digest is the fallback that still makes a retry idempotent.
 */
async function inboundMessageId(header: string | null, raw: Uint8Array): Promise<string> {
  const normalized = (header ?? '').trim().replace(/\s+/g, ' ')
  if (normalized && normalized.length <= MAX_MESSAGE_ID_CHARS) return normalized
  const digest = await crypto.subtle.digest('SHA-256', raw)
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `sha256:${hex}`
}

/** Read at most the declared ceiling; null means the stream went past it and was cancelled. */
async function readRaw(stream: ReadableStream<Uint8Array>): Promise<Uint8Array | null> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value?.byteLength) continue
    size += value.byteLength
    if (size > MAX_INBOUND_MAIL_BYTES) {
      try {
        await reader.cancel()
      } catch {
        // The ceiling already decided the outcome; failing to cancel adds nothing to report.
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

// ------------------------------------------------------------------- MIME reading

interface MimePart {
  /** Header names lowercased; the first of a repeated name wins. */
  headers: Map<string, string>
  /** The part's body as a binary string, still transfer-encoded. */
  body: string
}

/** Decode bytes one-to-one into code units, so no encoding is guessed before a part announces one. */
function binaryString(bytes: Uint8Array): string {
  const chunk = 0x8000
  let out = ''
  for (let index = 0; index < bytes.length; index += chunk) {
    out += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return out
}

/** The bytes behind a binary string, for the charset decoder. */
function latin1Bytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index++) bytes[index] = value.charCodeAt(index) & 0xff
  return bytes
}

/** Split a part at its empty line; a raw message is the root part and follows the same rule. */
function splitHeadAndBody(raw: string): [head: string, body: string] {
  const crlf = raw.indexOf('\r\n\r\n')
  if (crlf >= 0) return [raw.slice(0, crlf), raw.slice(crlf + 4)]
  const lf = raw.indexOf('\n\n')
  if (lf >= 0) return [raw.slice(0, lf), raw.slice(lf + 2)]
  return [raw, '']
}

function parsePart(raw: string): MimePart {
  if (raw.startsWith('\r\n')) return { headers: new Map(), body: raw.slice(2) }
  if (raw.startsWith('\n')) return { headers: new Map(), body: raw.slice(1) }
  const [head, body] = splitHeadAndBody(raw)
  return { headers: parseHeaders(head), body }
}

/** Folded header lines are unfolded into one value; an unparsable line is skipped, not fatal. */
function parseHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>()
  let name = ''
  let value = ''
  const flush = (): void => {
    if (!name) return
    if (!headers.has(name)) headers.set(name, value)
    name = ''
    value = ''
  }
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (name) value += ` ${line.trim()}`
      continue
    }
    flush()
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    name = line.slice(0, colon).trim().toLowerCase()
    value = line.slice(colon + 1).trim()
  }
  flush()
  return headers
}

/** A media type and its parameters, with quoted values unescaped and names lowercased. */
function parseContentType(value: string | undefined): { type: string; params: Record<string, string> } {
  const pieces = splitParameters(value ?? '')
  const type = (pieces.shift() ?? '').trim().toLowerCase()
  const params: Record<string, string> = {}
  for (const piece of pieces) {
    const equals = piece.indexOf('=')
    if (equals <= 0) continue
    const key = piece.slice(0, equals).trim().toLowerCase()
    let entry = piece.slice(equals + 1).trim()
    if (entry.startsWith('"') && entry.endsWith('"')) entry = entry.slice(1, -1).replace(/\\(.)/g, '$1')
    if (key) params[key] = entry
  }
  return { type, params }
}

/** Split a header value on `;`, keeping a semicolon inside a quoted parameter. */
function splitParameters(value: string): string[] {
  const pieces: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!
    if (quoted) {
      current += char
      if (char === '\\' && index + 1 < value.length) current += value[++index]!
      else if (char === '"') quoted = false
    } else if (char === '"') {
      quoted = true
      current += char
    } else if (char === ';') {
      pieces.push(current)
      current = ''
    } else {
      current += char
    }
  }
  pieces.push(current)
  return pieces
}

/** Every part of a multipart body, in order; the preamble and epilogue are not parts. */
function splitMultipart(body: string, boundary: string): MimePart[] {
  const marker = `--${boundary}`
  const closing = `${marker}--`
  const parts: string[] = []
  let current: string[] | null = null
  for (const rawLine of body.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const trimmed = line.trimEnd()
    if (trimmed === marker) {
      if (current) parts.push(current.join('\n'))
      current = []
      continue
    }
    if (trimmed === closing) {
      if (current) parts.push(current.join('\n'))
      current = null
      break
    }
    if (current) current.push(line)
  }
  if (current) parts.push(current.join('\n'))
  return parts.map(parsePart)
}

/**
 * The first plain-text body in a part tree.
 *
 * A multipart/alternative is walked in wire order and the first text/plain wins, which is the part
 * a mail client put first for a reason; text/html is skipped rather than stripped. A part marked
 * `Content-Disposition: attachment` is never a body, even when it is text/plain — that is the
 * text file somebody attached, not the message they wrote.
 */
function plainTextOf(part: MimePart): string | null {
  const { type, params } = parseContentType(part.headers.get('content-type'))
  const disposition = (part.headers.get('content-disposition') ?? '').trim().toLowerCase()
  if (disposition.startsWith('attachment')) return null
  if (type.startsWith('multipart/')) {
    const boundary = params.boundary
    if (!boundary) return null
    for (const child of splitMultipart(part.body, boundary)) {
      const text = plainTextOf(child)
      if (text !== null) return text
    }
    return null
  }
  if (type === '' || type === 'text/plain') return decodeTextPart(part)
  return null
}

/** A text part as text: transfer encoding first, then the charset the part declared. */
function decodeTextPart(part: MimePart): string {
  const encoding = (part.headers.get('content-transfer-encoding') ?? '').trim().toLowerCase()
  const bytes = encoding === 'base64'
    ? base64Bytes(part.body)
    : encoding === 'quoted-printable'
      ? quotedPrintableBytes(part.body)
      : latin1Bytes(part.body)
  const charset = parseContentType(part.headers.get('content-type')).params.charset
  return decodeBytes(bytes, charset)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
}

/** Decode with the declared charset, falling back to UTF-8 for a label the runtime cannot read. */
function decodeBytes(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase() || 'utf-8'
  try {
    return new TextDecoder(label).decode(bytes)
  } catch {
    return new TextDecoder().decode(bytes)
  }
}

/** RFC 2047 encoded words; whitespace between two adjacent words is not content. */
function decodeHeaderWords(value: string): string {
  let out = ''
  let last = 0
  let previousEnd = -1
  for (const match of value.matchAll(ENCODED_WORD_RE)) {
    const start = match.index ?? 0
    const between = value.slice(last, start)
    if (previousEnd !== last || !/^\s*$/.test(between)) out += between
    out += decodeEncodedWord(match[1] ?? '', match[2] ?? '', match[3] ?? '')
    last = start + match[0].length
    previousEnd = last
  }
  return out + value.slice(last)
}

function decodeEncodedWord(charset: string, encoding: string, text: string): string {
  const bytes = encoding.toUpperCase() === 'B'
    ? base64Bytes(text)
    : quotedPrintableBytes(text.replace(/_/g, ' '))
  return decodeBytes(bytes, charset.split('*')[0])
}

/** Base64 to bytes; malformed input yields nothing rather than the decoder's exception. */
function base64Bytes(value: string): Uint8Array {
  try {
    const binary = atob(value.replace(/\s+/g, ''))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return new Uint8Array()
  }
}

/** Quoted-printable to bytes, with soft line breaks removed before the `=XX` escapes are read. */
function quotedPrintableBytes(value: string): Uint8Array {
  const text = value.replace(/=\r?\n/g, '')
  const out: number[] = []
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    const hex = text.slice(index + 1, index + 3)
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(Number.parseInt(hex, 16))
      index += 2
    } else {
      out.push(text.charCodeAt(index) & 0xff)
    }
  }
  return Uint8Array.from(out)
}

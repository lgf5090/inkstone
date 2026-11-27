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
import PostalMime from 'postal-mime'
import { MAX_TASK_DESCRIPTION_CHARS } from '@shared/todos/model'
import { AssistantStore } from '../assistant/store'
import { initializeDatabase } from '../db/schema'
import type { Env } from '../env'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { assertAttemptBudget, consumeAttemptBudget, type AttemptBudgetTarget } from '../lib/throttle'
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

/** Hourly ceilings for one token, one sender on that token, and one IP on that token. */
export const INBOUND_MAIL_HOURLY_BUDGET = { token: 30, sender: 10, ip: 20 } as const

/** The fixed window shared by every inbound-mail budget. */
const INBOUND_MAIL_BUDGET_WINDOW_MS = 60 * 60 * 1000

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

export async function parseInboundMail(raw: Uint8Array): Promise<InboundMailContent> {
  const parsed = await PostalMime.parse(raw)
  return { subject: parsed.subject ?? '', text: parsed.text ?? '' }
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
    content = await parseInboundMail(raw)
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
  const budgetTargets = await inboundMailBudgetTargets(token, sender, message.headers)
  if (!(await claimMailMessage(env.DB, userId, messageId, now, now - MAIL_IDEMPOTENCY_WINDOW_MS))) {
    return 'duplicate'
  }

  try {
    await assertAttemptBudget(
      () => consumeAttemptBudget(env.DB, budgetTargets),
      'Too many inbound emails',
    )
  } catch (error) {
    const rateLimited = error instanceof ApiError && error.status === 429
    await releaseInboundMailClaim(env.DB, userId, messageId, rateLimited ? 'rate limiting' : 'budget check failure')
    if (!rateLimited) throw error
    console.warn('[inkstone] inbound mail dropped: the hourly attempt budget was exceeded')
    return 'ignored'
  }

  try {
    await new AssistantStore(env.DB, userId, env).createTask({
      title: mailTaskTitle(content.subject),
      description: mailTaskDescription(sender, content.text),
    })
  } catch (error) {
    await releaseInboundMailClaim(env.DB, userId, messageId, 'task creation failure')
    console.error('[inkstone] inbound mail could not be filed as a task', error)
    throw error
  }
  return 'created'
}

/** Hashed budget keys keep the capability token and sender metadata out of the shared throttle table. */
async function inboundMailBudgetTargets(
  token: string,
  sender: string,
  headers: Headers,
): Promise<AttemptBudgetTarget[]> {
  const ip = inboundMailIp(headers)
  const [tokenKey, senderKey, ipKey] = await Promise.all([
    inboundMailBudgetKey('token', token),
    inboundMailBudgetKey('sender', token, sender.toLowerCase()),
    ip ? inboundMailBudgetKey('ip', token, ip) : Promise.resolve(null),
  ])
  const target = (key: string, maxAttempts: number): AttemptBudgetTarget => ({
    key,
    maxAttempts,
    windowMs: INBOUND_MAIL_BUDGET_WINDOW_MS,
  })
  const targets = [target(tokenKey, INBOUND_MAIL_HOURLY_BUDGET.token), target(senderKey, INBOUND_MAIL_HOURLY_BUDGET.sender)]
  if (ipKey) targets.push(target(ipKey, INBOUND_MAIL_HOURLY_BUDGET.ip))
  return targets
}

async function inboundMailBudgetKey(scope: 'token' | 'sender' | 'ip', ...parts: string[]): Promise<string> {
  return `mail-todo-${scope}:${await sha256Hex(JSON.stringify(parts))}`
}

/** Only the optional edge address is eligible; sender-supplied forwarding and Received headers are not. */
function inboundMailIp(headers: Headers): string | null {
  const value = (headers.get('cf-connecting-ip') ?? '').trim().toLowerCase()
  if (!value || value.length > 64 || !/^[0-9a-f:.]+$/.test(value)) return null
  return value
}

/** Release a claim after a failed attempt so Email Routing can retry the same Message-ID. */
async function releaseInboundMailClaim(
  db: D1Database,
  userId: string,
  messageId: string,
  reason: string,
): Promise<void> {
  try {
    await releaseMailMessage(db, userId, messageId)
  } catch (error) {
    // Best effort: the message is already failing, and a stuck claim only means a retry is
    // treated as a duplicate. Reporting both failures is what lets an operator see the first one.
    console.error(`[inkstone] inbound mail claim could not be released after ${reason}`, error)
  }
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

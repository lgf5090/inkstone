import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { assertAttemptBudget, consumeAttemptBudget } from '../lib/throttle'

/**
 * Password gate for a published, protected article.
 *
 * The blog never sees the stored hash: it asks this API with the reader's password, and receives a
 * short-lived token signed with a deployment secret. The token is bound to one post, so unlocking one
 * article cannot be replayed to read another, and it carries an expiry so a copied cookie dies on its
 * own. The secret is optional; with it unset the gate answers 503 instead of issuing unsigned tokens.
 */
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_TOKEN_LENGTH = 512
const MIN_SECRET_LENGTH = 16

function encoder(): TextEncoder {
  return new TextEncoder()
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
    const binary = atob(padded)
    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

export function unlockSecret(env: Env): string | null {
  const value = env.BLOG_UNLOCK_SECRET
  return typeof value === 'string' && value.length >= MIN_SECRET_LENGTH ? value : null
}

async function sign(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder().encode(payload)))
}

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return diff === 0
}

export async function issueUnlockToken(env: Env, postId: string, now = Date.now()): Promise<string | null> {
  const secret = unlockSecret(env)
  if (!secret) return null
  const payload = base64Url(encoder().encode(JSON.stringify({ p: postId, e: now + TOKEN_TTL_MS })))
  const signature = base64Url(await sign(secret, payload))
  return `${payload}.${signature}`
}

export async function verifyUnlockToken(
  env: Env,
  postId: string,
  token: string | null | undefined,
  now = Date.now(),
): Promise<boolean> {
  const secret = unlockSecret(env)
  if (!secret || !token || token.length > MAX_TOKEN_LENGTH) return false
  const [payload, signature, extra] = token.split('.')
  if (!payload || !signature || extra) return false
  const expected = base64Url(await sign(secret, payload))
  if (!equal(signature, expected)) return false
  const bytes = fromBase64Url(payload)
  if (!bytes) return false
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { p?: unknown; e?: unknown }
    return parsed.p === postId && typeof parsed.e === 'number' && Number.isFinite(parsed.e) && parsed.e > now
  } catch {
    return false
  }
}

export function unlockExpiry(now = Date.now()): number {
  return now + TOKEN_TTL_MS
}

function attemptKey(postId: string, ip: string): string {
  return `blog-unlock:${postId}:${ip}`
}

export async function guardUnlockAttempt(db: D1Database, postId: string, ip: string): Promise<void> {
  await assertAttemptBudget(
    () => consumeAttemptBudget(db, [
      { key: attemptKey(postId, ip), maxAttempts: 10, windowMs: 10 * 60 * 1000, lockMs: 15 * 60 * 1000 },
    ]),
    'Too many unlock attempts',
  )
}

export async function clearUnlockAttempts(db: D1Database, postId: string, ip: string): Promise<void> {
  await db.prepare('DELETE FROM login_attempts WHERE key = ?1').bind(attemptKey(postId, ip)).run()
}

export function unlockNotConfigured(): ApiError {
  return new ApiError(503, 'server_misconfigured', 'Password unlock is not configured for this deployment')
}

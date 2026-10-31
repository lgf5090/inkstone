/**
 * The stored hash signs the cookie instead of travelling in it, so changing the password retires
 * every cookie issued under the old one. Legacy unsalted digests are recognised here and upgraded.
 */

import { sha256Hex, timingSafeEqual } from '../../lib/encoding'

export const AUTH_COOKIE_PREFIX = 'sl_auth_'
export const AUTH_TOKEN_TTL_SECONDS = 24 * 60 * 60

export const PASSWORD_ATTEMPT_LIMIT = 10
export const PASSWORD_ATTEMPT_WINDOW_SECONDS = 10 * 60

const LEGACY_DIGEST = /^[0-9a-f]{64}$/

export function authCookieName(slug: string): string {
  return `${AUTH_COOKIE_PREFIX}${slug}`
}

export function isLegacyDigest(stored: string): boolean {
  return LEGACY_DIGEST.test(stored)
}

export async function legacyDigest(password: string): Promise<string> {
  return sha256Hex(password)
}

async function sign(keyMaterial: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function mintAuthToken(
  keyMaterial: string,
  slug: string,
  expiresAt: number,
): Promise<string> {
  const expiry = Math.floor(expiresAt)
  return `${expiry}.${await sign(keyMaterial, `${slug}:${expiry}`)}`
}

export async function verifyAuthToken(
  token: string,
  keyMaterial: string,
  slug: string,
  nowSeconds: number,
): Promise<boolean> {
  const dot = token.indexOf('.')
  if (dot <= 0) return false
  const expiry = Number(token.slice(0, dot))
  if (!Number.isInteger(expiry) || expiry <= nowSeconds) return false
  const expected = await sign(keyMaterial, `${slug}:${expiry}`)
  return timingSafeEqual(expected, token.slice(dot + 1))
}

/** The row stores only this digest, never the visitor address. */
export async function attemptBucket(slug: string, ip: string): Promise<string> {
  return (await sha256Hex(`${slug}|${ip}`)).slice(0, 40)
}

import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { getCookie, setCookie } from 'hono/cookie'
import {
  CLIENT_HEADER,
  LEGACY_SESSION_COOKIE,
  SESSION_COOKIE,
  SESSION_RENEW_BEFORE_MS,
  SESSION_TTL_MS,
} from '@shared/constants'
import { MEMOS_API_PREFIX } from '@shared/memos/constants'
import { destroySession, hashToken, isSessionToken, renewSession } from '../lib/session-store'
import { ApiError } from '../lib/errors'
import { memoPatFromAuthorization } from '../memos/tokens'
import { isXgetProxyPath } from '../development/xget/paths'
import type { AppBindings, Variables } from '../env'

interface UserRow {
  id: string
  username: string
  login: string
  name: string
  avatar_url: string
  role: 'owner' | 'member'
  settings: string
  created_at: number
}

export const USER_COLUMNS = `id, username, login, name, avatar_url, role, settings, created_at`

const USER_COLUMNS_ALIASED = USER_COLUMNS.split(', ').map((column) => `u.${column}`).join(', ')

/**
 * How stale `users.last_seen_at` may get before a request writes a fresh one.
 *
 * A reader's every request would otherwise take a write to the `users` row, so the bump is rate-limited
 * to one per interval; the same number is the guard in the `UPDATE` so two concurrent requests cannot
 * both decide they were the one that crossed the interval.
 */
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000

export function rowToUser(row: UserRow): Variables['user'] {
  return {
    id: row.id,
    username: row.username,
    login: row.login,
    name: row.name,
    avatarUrl: row.avatar_url,

    role: row.role === 'owner' ? 'owner' : 'member',
    createdAt: row.created_at,
    settingsRaw: row.settings,
  }
}


interface SessionUserRow extends UserRow {
  session_id: string
  expires_at: number
  last_seen_at: number
}

export const loadSession = createMiddleware<AppBindings>(async (c, next) => {
  const cookieNames = sessionCookieNames(c.req.url)
  const candidates = cookieNames
    .map((name) => ({ name, token: getCookie(c, name) }))
    .filter((candidate): candidate is { name: string; token: string } => Boolean(candidate.token))
  const seenTokens = new Set<string>()
  let authenticated = false

  for (const { name, token } of candidates) {
    if (!isSessionToken(token) || seenTokens.has(token)) continue
    seenTokens.add(token)
    const row = await c.env.DB.prepare(
      `SELECT ${USER_COLUMNS_ALIASED}, u.last_seen_at, s.id AS session_id, s.expires_at
         FROM sessions s LEFT JOIN users u ON u.id = s.user_id
        WHERE s.id = ?1 AND s.expires_at > ?2`,
    )
      .bind(await hashToken(token), Date.now())
      .first<SessionUserRow>()

    if (row?.session_id) {
      if (!row.id) {
        await destroySession(c.env.DB, token)
        continue
      } else {
        c.set('user', rowToUser(row))
        c.set('userId', row.id)
        c.set('sessionId', row.session_id)

        const shouldRenew = row.expires_at - Date.now() < SESSION_RENEW_BEFORE_MS
        if (shouldRenew) {
          await renewSession(c.env.DB, row.session_id)
        }
        if (shouldRenew || name === LEGACY_SESSION_COOKIE) {
          writeSessionCookie(c, token)
        }
        if (new URL(c.req.url).protocol === 'https:' && getCookie(c, LEGACY_SESSION_COOKIE)) {
          clearLegacySessionCookie(c)
        }
        const now = Date.now()
        const lastSeenFloor = now - LAST_SEEN_WRITE_INTERVAL_MS
        if (row.last_seen_at < lastSeenFloor) c.executionCtx?.waitUntil(
          c.env.DB.prepare(`UPDATE users SET last_seen_at = ?1 WHERE id = ?2 AND last_seen_at < ?3`)
            .bind(now, row.id, lastSeenFloor)
            .run()
            .catch(() => {}),
        )
        authenticated = true
        break
      }
    }
  }
  if (candidates.length && !authenticated) clearSessionCookie(c)

  await next()
})

export const requireAuth = createMiddleware<AppBindings>(async (c, next) => {
  if (!c.get('userId')) throw ApiError.unauthenticated()
  await next()
})

export const requireOwner = createMiddleware<AppBindings>(async (c, next) => {
  if (c.get('user')?.role !== 'owner') throw ApiError.forbidden('Owner access required')
  await next()
})

function isMemoPatRequest(c: Context<AppBindings>): boolean {
  const path = c.req.path
  if (path !== MEMOS_API_PREFIX && !path.startsWith(`${MEMOS_API_PREFIX}/`)) return false
  return memoPatFromAuthorization(c.req.header('Authorization')) !== null
}

function isImgbedTokenRequest(c: Context<AppBindings>): boolean {
  if (!c.req.path.startsWith('/api/imgbed/')) return false
  return /^Bearer\s+img_[A-Za-z0-9_-]{43}$/i.test(c.req.header('Authorization') ?? '')
}

export const requireClientHeader = createMiddleware<AppBindings>(async (c, next) => {
  const method = c.req.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    if (!isXgetProxyPath(c.req.path) && !isMemoPatRequest(c) && !isImgbedTokenRequest(c) && c.req.header(CLIENT_HEADER) !== '1') {
      throw new ApiError(403, 'forbidden', 'Missing client identification header. Refresh and try again')
    }
  }
  await next()
})

export function sessionCookieString(requestUrl: string, token: string): string {
  const secure = new URL(requestUrl).protocol === 'https:'
  const parts = [
    `${secure ? SESSION_COOKIE : LEGACY_SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function writeSessionCookie(c: Context<AppBindings>, token: string): void {
  c.header('Set-Cookie', sessionCookieString(c.req.url, token), { append: true })
}

export function clearSessionCookie(c: Context<AppBindings>): void {
  const secure = new URL(c.req.url).protocol === 'https:'
  const names = secure ? [SESSION_COOKIE, LEGACY_SESSION_COOKIE] : [LEGACY_SESSION_COOKIE]
  for (const name of names) {
    setCookie(c, name, '', {
      path: '/',
      httpOnly: true,
      maxAge: 0,
      sameSite: 'Lax',
      secure,
    })
  }
}

function clearLegacySessionCookie(c: Context<AppBindings>): void {
  setCookie(c, LEGACY_SESSION_COOKIE, '', {
    path: '/',
    httpOnly: true,
    maxAge: 0,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
  })
}

export function sessionCookieNames(requestUrl: string): string[] {
  return new URL(requestUrl).protocol === 'https:'
    ? [SESSION_COOKIE, LEGACY_SESSION_COOKIE]
    : [LEGACY_SESSION_COOKIE, SESSION_COOKIE]
}

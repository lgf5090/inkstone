/**
 * The optional Netease content account.
 *
 * Inkstone's own session is the application login; this is a second, optional account that only
 * unlocks personalised content. The cookie is the credential: it is validated before it is stored,
 * sealed through the credential vault, and never returned by any route. The QR image is drawn by the
 * browser from the URL the provider returns; polling only ever answers with a status and, once the
 * scan is confirmed, the profile.
 */
import { Hono } from 'hono'
import type { MusicAccount } from '@shared/music/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { encryptMusicCookie } from '../lib/crypto'
import { readJson } from '../lib/request'
import { MusicStore } from '../music/store'
import { MusicProviderError } from '../music/providers/types'
import type { MusicRouteDeps } from './music'

const COOKIE_MAX = 8 * 1024
const QR_KEY_MAX = 256
const COOKIE_BODY_LIMIT = 16 * 1024

function cookieOf(body: Record<string, unknown>): string {
  const value = body.cookie
  if (typeof value !== 'string') throw ApiError.badRequest('A cookie is required')
  const cookie = value.trim()
  if (!cookie) throw ApiError.badRequest('A cookie is required')
  if (cookie.length > COOKIE_MAX) throw ApiError.badRequest('The cookie is too long')
  // A cookie becomes a request header upstream; a line break in it would be a header injection.
  if (/[\r\n\0]/.test(cookie)) throw ApiError.badRequest('The cookie contains invalid characters')
  return cookie
}

async function markExpired(store: MusicStore): Promise<MusicAccount | null> {
  await store.markAccountStatus('expired', 'netease')
  return store.getAccount('netease')
}

export function createMusicAccountRoutes(deps: MusicRouteDeps): Hono<AppBindings> {
  const routes = new Hono<AppBindings>()

  // Static segments first: a QR key route must never be read as an action on the account row.
  routes.post('/netease/qr', async (c) => {
    try {
      const provider = await deps.provider(c, { anonymous: true })
      const challenge = await provider.loginQrKey()
      return c.json({ key: challenge.key, url: challenge.url, expiresAt: challenge.expiresAt })
    } catch (error) {
      throw deps.translate(error)
    }
  })

  routes.get('/netease/qr/:key', async (c) => {
    const key = (c.req.param('key') ?? '').trim()
    if (!key) throw ApiError.badRequest('A QR key is required')
    if (key.length > QR_KEY_MAX) throw ApiError.badRequest('That QR key is too long')
    try {
      const provider = await deps.provider(c, { anonymous: true })
      const result = await provider.loginQrPoll(key)
      if (result.status !== 'confirmed') {
        return c.json({ status: result.status, message: result.message, account: null })
      }
      if (!result.account) {
        throw new ApiError(502, 'music_provider_unavailable', 'The scan was confirmed without an account profile')
      }
      if (!result.cookie) {
        // The provider held no cookie after a confirmed scan: storing nothing is the only honest
        // answer, because pretending the account is connected would fail on the first private read.
        throw new ApiError(502, 'music_provider_unavailable', 'The scan was confirmed without a session cookie')
      }
      const store = new MusicStore(c.env.DB, c.get('userId'))
      const ciphertext = await encryptMusicCookie(c.env, c.get('userId'), result.cookie)
      const account = await store.saveAccount({
        provider: 'netease',
        accountId: result.account.accountId,
        nickname: result.account.nickname,
        avatarUrl: result.account.avatarUrl,
        cookieCiphertext: ciphertext,
        status: 'connected',
      })
      return c.json({ status: 'confirmed', message: result.message, account })
    } catch (error) {
      throw deps.translate(error)
    }
  })

  routes.put('/netease/cookie', async (c) => {
    const body = await readJson<Record<string, unknown>>(c, COOKIE_BODY_LIMIT)
    const cookie = cookieOf(body)
    try {
      const provider = await deps.provider(c, { anonymous: true })
      const session = await provider.loginCookie(cookie)
      const store = new MusicStore(c.env.DB, c.get('userId'))
      const ciphertext = await encryptMusicCookie(c.env, c.get('userId'), session.cookie)
      const account = await store.saveAccount({
        provider: 'netease',
        accountId: session.account.accountId,
        nickname: session.account.nickname,
        avatarUrl: session.account.avatarUrl,
        cookieCiphertext: ciphertext,
        status: 'connected',
      })
      // The profile is the whole answer: the cookie the caller sent is already known to them, and
      // the cookie the provider normalised must not travel back.
      return c.json(account)
    } catch (error) {
      throw deps.translate(error)
    }
  })

  routes.get('/netease', async (c) => {
    const store = new MusicStore(c.env.DB, c.get('userId'))
    const stored = await store.getAccount('netease')
    if (!stored) return c.json({ account: null })

    try {
      const provider = await deps.provider(c)
      const status = await provider.accountStatus()
      if (!status.account) return c.json({ account: await markExpired(store) })
      const account = await store.saveAccount({
        provider: 'netease',
        accountId: status.account.accountId,
        nickname: status.account.nickname,
        avatarUrl: status.account.avatarUrl,
        status: 'connected',
      })
      return c.json({ account })
    } catch (error) {
      // An expired login is a state, not a server failure: mark the row and answer normally so the
      // client can offer "connect again". Other failures stay failures.
      if (error instanceof MusicProviderError && error.code === 'auth_required') {
        return c.json({ account: await markExpired(store) })
      }
      throw deps.translate(error)
    }
  })

  routes.delete('/netease', async (c) => {
    const store = new MusicStore(c.env.DB, c.get('userId'))
    // Disconnecting forgets the ciphertext row. There is no upstream logout call: a network failure
    // must not leave the reader still connected to an account they asked to remove.
    await store.deleteAccount('netease')
    return c.json({ ok: true })
  })

  return routes
}

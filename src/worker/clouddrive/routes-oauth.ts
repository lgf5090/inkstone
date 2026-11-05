/**
 * The single OAuth callback every authorization-code driver shares.
 *
 * Workers cannot bind a localhost redirect, so the address registered with each provider is this
 * deployment's own `/api/clouddrive/oauth/<driver>/callback`. A random state in `OAUTH_KV` binds the
 * callback to the storage that started the flow, and the code exchange writes tokens through the
 * credential vault exactly like a manual token edit would.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { encryptCloudDriveCredentials, decryptCloudDriveCredentials } from '../lib/crypto'
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  oauthCallbackPath,
  oauthCallbackUrl,
  oauthProvider,
  randomState,
} from './drivers/oauth'
import { DriverError } from './drivers/contract'
import { driverApiError } from './drivers/errors'

export const clouddriveOAuthRoutes = new Hono<AppBindings>()

interface OAuthStateRecord {
  driver: string
  userId: string
  storageId: string
  redirectUri: string
  clientId: string
  clientSecret: string
  createdAt: number
}

const STATE_TTL_SECONDS = 600

function stateKey(state: string): string {
  return `clouddrive-oauth:${state}`
}

async function storageCredentials(
  c: Context<AppBindings>,
  userId: string,
  storageId: string,
): Promise<{ credentials: Record<string, string>; exists: boolean }> {
  const row = await c.env.DB.prepare(
    `SELECT credentials FROM CloudDrive_storages WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, storageId).first<{ credentials: string }>()
  if (!row) return { credentials: {}, exists: false }
  const stored = await decryptCloudDriveCredentials(c.env, storageId, row.credentials).catch(() => null)
  const credentials = Object.fromEntries(
    Object.entries(stored ?? {}).map(([key, value]) => [key, String(value)]),
  )
  return { credentials, exists: true }
}

clouddriveOAuthRoutes.get('/oauth/:driver/start', async (c) => {
  const userId = c.get('userId')
  const driverId = c.req.param('driver')
  const provider = oauthProvider(driverId)
  const definition = findCloudDriveDriver(driverId)
  if (!provider || !definition?.implemented) {
    throw ApiError.badRequest('This storage type does not use an OAuth authorization flow')
  }
  const storageId = c.req.query('storageId') ?? ''
  if (!storageId) throw ApiError.badRequest('A storageId is required to start authorization')
  const { credentials, exists } = await storageCredentials(c, userId, storageId)
  if (!exists) throw ApiError.notFound('Storage not found')
  const clientId = credentials.clientId || provider.defaultClientId || ''
  const clientSecret = credentials.clientSecret || provider.defaultClientSecret || ''
  if (!clientId) {
    throw ApiError.badRequest(
      'This provider needs an OAuth client id and secret. Save them on the storage first, then authorize.',
    )
  }
  const origin = new URL(c.req.url).origin
  const redirectUri = oauthCallbackUrl(origin, driverId)
  const state = randomState()
  const record: OAuthStateRecord = {
    driver: driverId, userId, storageId, redirectUri, clientId, clientSecret, createdAt: Date.now(),
  }
  await c.env.OAUTH_KV.put(stateKey(state), JSON.stringify(record), { expirationTtl: STATE_TTL_SECONDS })
  const url = buildAuthorizeUrl(provider, { clientId, redirectUri, state })
  return c.json({ url, redirectUri, callbackPath: oauthCallbackPath(driverId) })
})

clouddriveOAuthRoutes.get('/oauth/:driver/callback', async (c) => {
  const driverId = c.req.param('driver')
  const provider = oauthProvider(driverId)
  const state = c.req.query('state') ?? ''
  const error = c.req.query('error')
  const origin = new URL(c.req.url).origin
  const target = (status: string): string => `/clouddrive/storage?oauth=${status}&driver=${encodeURIComponent(driverId)}`
  if (!provider || !state) return c.redirect(target('error'), 302)
  const raw = await c.env.OAUTH_KV.get(stateKey(state))
  await c.env.OAUTH_KV.delete(stateKey(state))
  if (!raw) return c.redirect(target('error'), 302)
  const record = JSON.parse(raw) as OAuthStateRecord
  if (
    record.driver !== driverId ||
    record.userId !== c.get('userId') ||
    Date.now() - record.createdAt > STATE_TTL_SECONDS * 1000
  ) {
    return c.redirect(target('error'), 302)
  }
  if (error) return c.redirect(target('error'), 302)
  const code = c.req.query('code') ?? ''
  if (!code) return c.redirect(target('error'), 302)
  let tokens
  try {
    tokens = await exchangeAuthorizationCode(provider, {
      code,
      redirectUri: record.redirectUri,
      clientId: record.clientId,
      clientSecret: record.clientSecret || undefined,
    })
  } catch (exchangeError) {
    if (exchangeError instanceof DriverError) throw driverApiError(exchangeError)
    throw exchangeError
  }
  const { credentials } = await storageCredentials(c, record.userId, record.storageId)
  const merged: Record<string, string> = {
    ...credentials,
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresIn > 0 ? String(Date.now() + tokens.expiresIn * 1000) : '0',
  }
  if (tokens.refreshToken) merged.refreshToken = tokens.refreshToken
  if (!merged.clientId) merged.clientId = record.clientId
  if (record.clientSecret && !merged.clientSecret) merged.clientSecret = record.clientSecret
  const ciphertext = await encryptCloudDriveCredentials(c.env, record.storageId, merged)
  await c.env.DB.prepare(
    `UPDATE CloudDrive_storages
        SET credentials = ?, last_test_at = ?, last_test_status = 'ok', updated_at = ?
      WHERE user_id = ? AND id = ?`,
  ).bind(ciphertext, Date.now(), Date.now(), record.userId, record.storageId).run()
  console.info('[clouddrive] OAuth authorization completed for', record.storageId, driverId, origin)
  return c.redirect(target('ok'), 302)
})

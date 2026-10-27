import type { Env } from '../env'
import { ApiError } from './errors'
import { isValidId } from './id'


const VAULT_NAME = 'primary'
const VAULT_ORIGIN = 'https://credential-vault.internal'

export class CryptoUnavailableError extends ApiError {
  /**
   * The default sentence is about the one thing only the operator can fix: no binding at all. A caller
   * that got an answer and did not like it passes its own sentence instead — a refusal and an absent
   * binding are different failures, and reporting a refusal as "the binding is missing" sends whoever
   * reads it looking in the wrong place. Neither message carries the value that was being stored.
   */
  constructor(reason?: string) {
    super(
      503,
      'server_misconfigured',
      reason ?? 'The server is missing the CREDENTIAL_VAULT Durable Object binding and cannot store sensitive credentials safely',
    )
    this.name = 'CryptoUnavailableError'
  }
}

export async function encryptSecret(env: Env, info: string, value: unknown): Promise<string> {
  if (!isValidId(info)) throw new Error('invalid_credential_scope')
  return encryptCredential(env, `backup:${info}`, value)
}

export async function decryptSecret<T>(env: Env, info: string, stored: string): Promise<T | null> {
  if (!isValidId(info) || stored.length > 24 * 1024) return null
  const value = await decryptCredential(env, `backup:${info}`, stored)
  return isBackupCredentialRecord(value) ? (value as T) : null
}

export async function encryptTotpSecret(env: Env, userId: string, secret: string): Promise<string> {
  if (!isValidId(userId) || !/^[A-Z2-7]{32}$/.test(secret)) {
    throw new Error('invalid_totp_credential')
  }
  return encryptCredential(env, `totp:${userId}`, { secret })
}

export async function decryptTotpSecret(
  env: Env,
  userId: string,
  stored: string,
): Promise<string | null> {
  if (!isValidId(userId) || stored.length > 24 * 1024) return null
  const value = await decryptCredential(env, `totp:${userId}`, stored)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const secret = (value as Record<string, unknown>).secret
  return typeof secret === 'string' && /^[A-Z2-7]{32}$/.test(secret) ? secret : null
}

/**
 * The chat assistant's provider key.
 *
 * A key is stored only as vault ciphertext, and the plaintext exists solely inside the worker call
 * that signs one upstream request — no assistant route returns it, and a backup never carries it. When
 * the vault binding is missing the write fails loudly rather than falling back to storing the key in
 * the clear: a reader who configured a key deserves to know it was not saved.
 */
export async function encryptAssistantKey(env: Env, userId: string, apiKey: string): Promise<string> {
  if (!isValidId(userId)) throw new Error('invalid_ai_credential')
  const trimmed = apiKey.trim()
  if (!trimmed || trimmed.length > 4096) throw new Error('invalid_ai_credential')
  return encryptCredential(env, `ai:${userId}`, { apiKey: trimmed })
}

export async function decryptAssistantKey(env: Env, userId: string, stored: string): Promise<string | null> {
  if (!isValidId(userId) || stored.length > 24 * 1024) return null
  const value = await decryptCredential(env, `ai:${userId}`, stored)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const apiKey = (value as Record<string, unknown>).apiKey
  return typeof apiKey === 'string' && apiKey.length > 0 && apiKey.length <= 4096 ? apiKey : null
}

export async function encryptEmailSecret(env: Env, ownerId: string, secret: string): Promise<string> {
  if (!isValidId(ownerId)) throw new Error('invalid_email_credential')
  const trimmed = secret.trim()
  if (!trimmed || trimmed.length > 4096) throw new Error('invalid_email_credential')
  return encryptCredential(env, `email:${ownerId}`, { secret: trimmed })
}

export async function decryptEmailSecret(env: Env, ownerId: string, stored: string): Promise<string | null> {
  if (!isValidId(ownerId) || stored.length > 24 * 1024) return null
  const value = await decryptCredential(env, `email:${ownerId}`, stored)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const secret = (value as Record<string, unknown>).secret
  return typeof secret === 'string' && secret.length > 0 && secret.length <= 4096 ? secret : null
}

/**
 * The access token of one Alist mount.
 *
 * Scoped to the mount's own id, not to the account: two mounts on two servers are two credentials,
 * and deleting one must not disturb the other. The value is never read back by a route; only the
 * drive resolver asks for it, inside the request that talks to that server.
 */
export async function encryptMusicMountToken(env: Env, mountId: string, token: string): Promise<string> {
  if (!isValidId(mountId)) throw new Error('invalid_music_credential')
  const trimmed = token.trim()
  if (!trimmed || trimmed.length > 4 * 1024) throw new Error('invalid_music_credential')
  return encryptCredential(env, `music-mount:${mountId}`, { token: trimmed })
}

export async function decryptMusicMountToken(env: Env, mountId: string, stored: string): Promise<string | null> {
  if (!isValidId(mountId) || stored.length > 24 * 1024) return null
  const value = await decryptCredential(env, `music-mount:${mountId}`, stored)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const token = (value as Record<string, unknown>).token
  return typeof token === 'string' && token.length > 0 && token.length <= 4 * 1024 ? token : null
}

/**
 * The optional Netease content account's cookie.
 *
 * It is scoped to the Inkstone account rather than to a music row, because one reader links one
 * content account. The plaintext exists only inside the worker call that signs one upstream request;
 * no route returns it, and a backup never carries it.
 */
export async function encryptMusicCookie(env: Env, userId: string, cookie: string): Promise<string> {
  if (!isValidId(userId)) throw new Error('invalid_music_credential')
  const trimmed = cookie.trim()
  if (!trimmed || trimmed.length > 8 * 1024) throw new Error('invalid_music_credential')
  return encryptCredential(env, `music:${userId}`, { cookie: trimmed })
}

export async function decryptMusicCookie(env: Env, userId: string, stored: string): Promise<string | null> {
  if (!isValidId(userId) || stored.length > 24 * 1024) return null
  const value = await decryptCredential(env, `music:${userId}`, stored)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const cookie = (value as Record<string, unknown>).cookie
  return typeof cookie === 'string' && cookie.length > 0 && cookie.length <= 8 * 1024 ? cookie : null
}

export async function encryptDatabaseSecret(env: Env, connectionId: string, token: string): Promise<string> {
  if (!isValidId(connectionId)) throw new Error('invalid_database_credential')
  const trimmed = token.trim()
  if (!trimmed || trimmed.length > 4 * 1024) throw new Error('invalid_database_credential')
  return encryptCredential(env, `database:${connectionId}`, { token: trimmed })
}

export async function decryptDatabaseSecret(env: Env, connectionId: string, stored: string): Promise<string | null> {
  if (!isValidId(connectionId) || stored.length > 24 * 1024) return null
  const value = await decryptCredential(env, `database:${connectionId}`, stored)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const token = (value as Record<string, unknown>).token
  return typeof token === 'string' && token.length > 0 && token.length <= 4 * 1024 ? token : null
}

/**
 * One MCP server's outbound OAuth material.
 *
 * Scoped to the server's own id rather than to the account, because the thing being kept is not this
 * reader's credential in general but a token one third party minted for one resource: a ciphertext written
 * into another server's row then fails to decrypt instead of leaking a bearer across two issuers.
 *
 * The payload is opaque to the vault — one field, whatever the authorization server handed back — so a
 * large JWT from a large identity provider does not have to be truncated to fit.
 */
export async function encryptMcpOAuth(env: Env, serverId: string, payload: unknown): Promise<string> {
  if (!isValidId(serverId)) throw new Error('invalid_mcp_credential')
  return encryptCredential(env, `mcp:${serverId}`, { blob: JSON.stringify(payload ?? {}) })
}

export async function decryptMcpOAuth<T>(env: Env, serverId: string, stored: string): Promise<T | null> {
  if (!isValidId(serverId) || stored.length > 24 * 1024) return null
  const value = await decryptCredential(env, `mcp:${serverId}`, stored)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const blob = (value as Record<string, unknown>).blob
  if (typeof blob !== 'string') return null
  try {
    return JSON.parse(blob) as T
  } catch {
    return null
  }
}

/**
 * One subscription channel's configuration.
 *
 * A channel's settings are a bundle — a bot token beside a chat id, a webhook beside a parse mode — and
 * none of them is ever queried, so the whole object is sealed as one ciphertext rather than spread over
 * columns where a backup or a log line could pick a secret up. The scope is the row's own id, which is
 * what keeps one channel's ciphertext from decrypting under another's.
 */
export async function encryptChannelConfig(env: Env, id: string, config: Record<string, unknown>): Promise<string> {
  if (!isValidId(id)) throw new Error('invalid_channel_credential')
  return encryptCredential(env, `channel:${id}`, config)
}

export async function decryptChannelConfig(
  env: Env,
  id: string,
  stored: string,
): Promise<Record<string, unknown> | null> {
  if (!isValidId(id) || stored.length > 24 * 1024) return null
  const value = await decryptCredential(env, `channel:${id}`, stored)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * One memo webhook's signing secret.
 *
 * The scope is the webhook's own row id so a ciphertext moved into another row cannot be read back out,
 * and the prefix is checked on both directions because the string doubles as the HMAC key material:
 * a value that is not a webhook secret would sign deliveries with the wrong bytes.
 */
export async function encryptMemoWebhookSecret(env: Env, webhookId: string, secret: string): Promise<string> {
  if (!isValidId(webhookId) || !isMemoWebhookSecret(secret)) throw new Error('invalid_memo_webhook_credential')
  return encryptCredential(env, `memo-webhook:${webhookId}`, { secret })
}

export async function decryptMemoWebhookSecret(env: Env, webhookId: string, stored: string): Promise<string | null> {
  if (!isValidId(webhookId) || stored.length > 24 * 1024) return null
  const value = await decryptCredential(env, `memo-webhook:${webhookId}`, stored)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const secret = (value as Record<string, unknown>).secret
  return isMemoWebhookSecret(secret) ? secret : null
}

function isMemoWebhookSecret(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith('whsec_')
    && value.length > 'whsec_'.length
    && value.length <= 512
}

async function encryptCredential(env: Env, scope: string, value: unknown): Promise<string> {
  const response = await vaultRequest(env, '/encrypt', { scope, value })
  if (!response.ok) {
    throw new CryptoUnavailableError(
      `The credential vault refused to store this configuration (${response.status}). The ${scope.split(':')[0]} scope's fields are not what it accepts.`,
    )
  }
  const body: unknown = await response.json().catch(() => null)
  const ciphertext = readStringField(body, 'ciphertext')
  if (!ciphertext || ciphertext.length > 24 * 1024) throw new CryptoUnavailableError('The credential vault answered without a ciphertext.')
  return ciphertext
}

async function decryptCredential(env: Env, scope: string, stored: string): Promise<unknown> {
  try {
    const response = await vaultRequest(env, '/decrypt', { scope, ciphertext: stored })
    if (response.status === 422) return null
    if (!response.ok) throw new CryptoUnavailableError()
    const body: unknown = await response.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('value' in body)) return null
    return (body as { value: unknown }).value
  } catch (error) {
    if (error instanceof CryptoUnavailableError) throw error
    throw new CryptoUnavailableError()
  }
}

async function vaultRequest(env: Env, path: '/encrypt' | '/decrypt', body: unknown): Promise<Response> {
  if (!env.CREDENTIAL_VAULT) throw new CryptoUnavailableError()
  try {
    const id = env.CREDENTIAL_VAULT.idFromName(VAULT_NAME)
    return await env.CREDENTIAL_VAULT.get(id).fetch(`${VAULT_ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.DO_AUTH_KEY ? { 'X-Inkstone-Internal': env.DO_AUTH_KEY } : {}),
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    if (error instanceof CryptoUnavailableError) throw error
    throw new CryptoUnavailableError()
  }
}

function readStringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : null
}

function isBackupCredentialRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const allowed = new Set(['password', 'accessKeyId', 'secretAccessKey'])
  const entries = Object.entries(value)
  return entries.length > 0 &&
    entries.length <= allowed.size &&
    entries.every(
      ([key, field]) =>
        allowed.has(key) && typeof field === 'string' && field.length > 0 && field.length <= 4096,
    )
}

/** A CalDAV password or an OAuth token bundle, sealed under the connection's own id. */
export type CalendarCredentialPayload =
  | { kind: 'basic'; username: string; password: string }
  | {
    kind: 'oauth'
    accessToken: string
    refreshToken: string
    expiresAt: number
    scope: string
    tokenType?: string
  }

/**
 * The vault's scope pattern predates the calendar app: it has no `calendar` prefix, and its record
 * policy decides which fields a scope may hold. `mcp` is the one existing scope that accepts a single
 * opaque OAuth-sized bundle (`blob`, up to 16 KiB), which is exactly this payload's shape. The scope
 * still ends in a 26-character id from the vault's own alphabet, so one connection's ciphertext is
 * sealed under a key no other connection's id derives. A calendar scope in the vault would replace
 * this constant and nothing else.
 */
const CALENDAR_VAULT_SCOPE_PREFIX = 'mcp:'
const CALENDAR_VAULT_BLOB_MAX = 16 * 1024

/**
 * The credential of one calendar connection.
 *
 * The payload is one JSON blob inside the vault's opaque-bundle field. The scope is the connection id
 * so a ciphertext cannot be moved to another connection and read back out there. The plaintext exists
 * only inside the worker call that talks to the provider; no route returns it, and a log line never
 * receives it.
 */
export async function encryptCalendarCredential(
  env: Env,
  connectionId: string,
  payload: CalendarCredentialPayload,
): Promise<string> {
  if (!isValidId(connectionId) || !isCalendarCredentialPayload(payload)) {
    throw new Error('invalid_calendar_credential')
  }
  return encryptCalendarBlob(env, connectionId, payload)
}

export async function decryptCalendarCredential(
  env: Env,
  connectionId: string,
  stored: string,
): Promise<CalendarCredentialPayload | null> {
  if (!isValidId(connectionId) || stored.length > 24 * 1024) return null
  const value = await decryptCalendarBlob(env, connectionId, stored)
  return isCalendarCredentialPayload(value) ? value : null
}

/**
 * The PKCE verifier of one pending OAuth state.
 *
 * The state hash is already the row's public identifier and never leaves the server, so sealing under
 * its first 26 hex characters needs no extra column: those are valid vault-id characters, and the
 * callback hashes the state it received and can reopen exactly that one verifier. A raw verifier in
 * the table would let anyone who can read D1 mint the code exchange.
 */
export async function encryptCalendarOAuthVerifier(
  env: Env,
  stateHash: string,
  verifier: string,
): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(stateHash) || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) {
    throw new Error('invalid_calendar_oauth_verifier')
  }
  return encryptCalendarBlob(env, stateHash.slice(0, 26), { verifier })
}

export async function decryptCalendarOAuthVerifier(
  env: Env,
  stateHash: string,
  stored: string,
): Promise<string | null> {
  if (!/^[a-f0-9]{64}$/.test(stateHash) || stored.length > 24 * 1024) return null
  const value = await decryptCalendarBlob(env, stateHash.slice(0, 26), stored)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const verifier = (value as Record<string, unknown>).verifier
  return typeof verifier === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(verifier) ? verifier : null
}

async function encryptCalendarBlob(env: Env, scopeId: string, payload: unknown): Promise<string> {
  const blob = JSON.stringify(payload)
  if (blob.length > CALENDAR_VAULT_BLOB_MAX) throw new Error('invalid_calendar_credential')
  return encryptCredential(env, `${CALENDAR_VAULT_SCOPE_PREFIX}${scopeId}`, { blob })
}

async function decryptCalendarBlob(env: Env, scopeId: string, stored: string): Promise<unknown> {
  const value = await decryptCredential(env, `${CALENDAR_VAULT_SCOPE_PREFIX}${scopeId}`, stored)
  const blob = readStringField(value, 'blob')
  if (blob === null || blob.length > CALENDAR_VAULT_BLOB_MAX) return null
  try {
    return JSON.parse(blob) as unknown
  } catch {
    return null
  }
}

function isCalendarCredentialPayload(value: unknown): value is CalendarCredentialPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.kind === 'basic') {
    return typeof record.username === 'string'
      && record.username.length > 0
      && record.username.length <= 256
      && typeof record.password === 'string'
      && record.password.length > 0
      && record.password.length <= 4096
  }
  if (record.kind !== 'oauth') return false
  return typeof record.accessToken === 'string'
    && record.accessToken.length > 0
    && record.accessToken.length <= 7000
    && typeof record.refreshToken === 'string'
    && record.refreshToken.length <= 7000
    && typeof record.expiresAt === 'number'
    && Number.isSafeInteger(record.expiresAt)
    && record.expiresAt >= 0
    && typeof record.scope === 'string'
    && record.scope.length <= 1024
    && (record.tokenType === undefined
      || (typeof record.tokenType === 'string' && record.tokenType.length > 0 && record.tokenType.length <= 64))
}

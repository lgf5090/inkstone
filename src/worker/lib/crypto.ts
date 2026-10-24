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

/**
 * Gateway keys are issued by Inkstone, not by Cloudflare.
 *
 * Only the SHA-256 hash and a short prefix are stored; the plaintext is returned once at creation and
 * never written to a log or audit row. The per-key daily request counter lives in its own row so the
 * hot path does not update the key metadata.
 */
import { sha256Hex, toBase64Url } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import type { Env } from '../env'

const KEY_PREFIX = 'gw_'
const KEY_RE = /^gw_[A-Za-z0-9_-]{43}$/
const ACTIVE_KEYS_MAX = 50

export interface GatewayKeyRecord {
  id: string
  name: string
  prefix: string
  allowedModels: string[]
  dailyRequestLimit: number
  createdAt: number
  lastUsedAt: number | null
  revokedAt: number | null
  todayRequests: number
  todayNeurons: number
  todayTokens: number
}

export interface GatewayKeyAuth {
  id: string
  userId: string
  name: string
  allowedModels: string[]
  dailyRequestLimit: number
  lastUsedAt: number | null
}

interface KeyRow {
  id: string
  user_id: string
  name: string
  prefix: string
  allowed_models: string
  daily_request_limit: number
  created_at: number
  last_used_at: number | null
  revoked_at: number | null
}

function generateKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return KEY_PREFIX + toBase64Url(bytes)
}

function normalizeModels(models: readonly string[] | undefined): string[] {
  const values = (models ?? []).map((model) => model.trim()).filter(Boolean)
  if (values.length === 0) return ['*']
  return [...new Set(values)].slice(0, 32)
}

export async function createGatewayKey(
  env: Env,
  userId: string,
  input: { name: string; allowedModels?: string[]; dailyRequestLimit?: number },
): Promise<{ record: GatewayKeyRecord; token: string }> {
  const name = input.name.trim().slice(0, 64)
  if (!name) throw ApiError.badRequest('A key name is required')
  const dailyLimit = Number(input.dailyRequestLimit ?? 0)
  if (!Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 1_000_000) {
    throw ApiError.badRequest('The daily request limit must be a whole number between 0 and 1,000,000')
  }
  const token = generateKey()
  const hash = await sha256Hex(token)
  const id = newId()
  const now = Date.now()
  const allowed = normalizeModels(input.allowedModels).join(' ')
  const inserted = await env.DB.prepare(
    `INSERT INTO ai_gateway_keys
       (id, user_id, name, key_hash, prefix, allowed_models, daily_request_limit, revoked_at, created_at, last_used_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, NULL
      WHERE (SELECT COUNT(*) FROM ai_gateway_keys
              WHERE user_id = ?2 AND revoked_at IS NULL) < ?9`,
  ).bind(id, userId, name, hash, token.slice(0, 10), allowed, dailyLimit, now, ACTIVE_KEYS_MAX).run()
  if ((inserted.meta.changes ?? 0) === 0) {
    throw ApiError.conflict(`An account can have at most ${ACTIVE_KEYS_MAX} active gateway keys`)
  }
  return {
    record: {
      id,
      name,
      prefix: token.slice(0, 10),
      allowedModels: allowed.split(' ').filter(Boolean),
      dailyRequestLimit: dailyLimit,
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
      todayRequests: 0,
      todayNeurons: 0,
      todayTokens: 0,
    },
    token,
  }
}

export async function listGatewayKeys(env: Env, userId: string, day: string): Promise<GatewayKeyRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT k.id, k.name, k.prefix, k.allowed_models, k.daily_request_limit, k.created_at, k.last_used_at,
            k.revoked_at, COALESCE(u.requests, 0) AS today_requests,
            COALESCE(u.neurons, 0) AS today_neurons, COALESCE(u.tokens, 0) AS today_tokens
       FROM ai_gateway_keys k
       LEFT JOIN ai_gateway_key_usage u ON u.key_id = k.id AND u.day = ?2
      WHERE k.user_id = ?1 AND k.revoked_at IS NULL
      ORDER BY k.created_at DESC`,
  ).bind(userId, day).all<KeyRow & {
    today_requests: number
    today_neurons: number
    today_tokens: number
  }>()
  return (results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    allowedModels: row.allowed_models.split(' ').filter(Boolean),
    dailyRequestLimit: row.daily_request_limit,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    todayRequests: row.today_requests,
    todayNeurons: row.today_neurons,
    todayTokens: row.today_tokens,
  }))
}

export async function revokeGatewayKey(env: Env, userId: string, id: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE ai_gateway_keys SET revoked_at = ?1
      WHERE id = ?2 AND user_id = ?3 AND revoked_at IS NULL`,
  ).bind(Date.now(), id, userId).run()
  return (result.meta.changes ?? 0) > 0
}

export function parseGatewayKey(token: string): string | null {
  if (token.length > 128 || !KEY_RE.test(token)) return null
  return token
}

export async function verifyGatewayKey(
  env: Env,
  token: string,
  now = Date.now(),
): Promise<GatewayKeyAuth | null> {
  const parsed = parseGatewayKey(token)
  if (!parsed) return null
  const hash = await sha256Hex(parsed)
  const row = await env.DB.prepare(
    `SELECT id, user_id, name, allowed_models, daily_request_limit, last_used_at
       FROM ai_gateway_keys
      WHERE key_hash = ?1 AND revoked_at IS NULL`,
  ).bind(hash).first<{
    id: string
    user_id: string
    name: string
    allowed_models: string
    daily_request_limit: number
    last_used_at: number | null
  }>()
  if (!row) return null
  if (!row.last_used_at || now - row.last_used_at > 10 * 60_000) {
    await env.DB.prepare(
      `UPDATE ai_gateway_keys SET last_used_at = ?1
        WHERE key_hash = ?2 AND (last_used_at IS NULL OR last_used_at < ?3)`,
    ).bind(now, hash, now - 10 * 60_000).run()
  }
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    allowedModels: row.allowed_models.split(' ').filter(Boolean),
    dailyRequestLimit: row.daily_request_limit,
    lastUsedAt: row.last_used_at,
  }
}

export function keyAllowsModel(key: GatewayKeyAuth, model: string): boolean {
  return key.allowedModels.length === 0 || key.allowedModels.includes('*') || key.allowedModels.includes(model)
}

export async function consumeKeyRequest(
  env: Env,
  key: GatewayKeyAuth,
  day: string,
): Promise<boolean> {
  await env.DB.prepare(
    `INSERT INTO ai_gateway_key_usage (key_id, day, user_id, requests, neurons, tokens)
     VALUES (?1, ?2, ?3, 0, 0, 0)
     ON CONFLICT(key_id, day) DO NOTHING`,
  ).bind(key.id, day, key.userId).run()
  const result = await env.DB.prepare(
    `UPDATE ai_gateway_key_usage
        SET requests = requests + 1
      WHERE key_id = ?1 AND day = ?2
        AND (?3 = 0 OR requests < ?3)`,
  ).bind(key.id, day, key.dailyRequestLimit).run()
  return (result.meta.changes ?? 0) > 0
}

export async function addKeyUsage(
  env: Env,
  keyId: string,
  userId: string,
  day: string,
  neurons: number,
  tokens: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE ai_gateway_key_usage
        SET neurons = neurons + ?4, tokens = tokens + ?5
      WHERE key_id = ?1 AND day = ?2 AND user_id = ?3`,
  ).bind(keyId, day, userId, Math.max(0, neurons), Math.max(0, tokens)).run()
}

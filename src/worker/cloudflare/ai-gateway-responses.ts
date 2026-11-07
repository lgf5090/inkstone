/**
 * Stored Responses objects and the `previous_response_id` chain.
 *
 * OpenAI's Responses API keeps the conversation on the server; this gateway is stateless at the
 * transport layer but not at the semantic one. The row holds the canonical messages that were sent
 * upstream and the output items that came back, so the next turn can rebuild exactly the same
 * conversation and reserve quota against the full prompt rather than only the new input.
 */
import type { Env } from '../env'
import type { CanonicalMessage } from './ai-gateway-models'

export const DEFAULT_RESPONSE_TTL_HOURS = 168
export const DEFAULT_RESPONSE_MAX_BYTES = 512 * 1024

export interface StoredGatewayResponse {
  id: string
  userId: string
  keyId: string
  model: string
  previousResponseId: string | null
  instructions: string | null
  canonicalMessages: CanonicalMessage[]
  outputItems: Record<string, unknown>[]
  outputText: string
  usage: Record<string, unknown>
  metadata: Record<string, string> | null
  createdAt: number
  expiresAt: number
  sizeBytes: number
}

export interface StoreGatewayResponseInput {
  id: string
  userId: string
  keyId: string
  model: string
  previousResponseId?: string | null
  instructions?: string | null
  canonicalMessages: CanonicalMessage[]
  outputItems: Record<string, unknown>[]
  outputText: string
  usage: Record<string, unknown>
  metadata?: Record<string, string> | null
  now?: number
}

export type StoreGatewayResponseResult = { stored: true } | { stored: false; reason: 'too_large' }

function envInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback
  return parsed
}

export function responseTtlMs(env: Env): number {
  const hours = envInt(env.AI_GATEWAY_RESPONSE_TTL_HOURS, DEFAULT_RESPONSE_TTL_HOURS, 0, 24 * 365)
  return hours * 3_600_000
}

export function responseMaxBytes(env: Env): number {
  return envInt(env.AI_GATEWAY_RESPONSE_MAX_BYTES, DEFAULT_RESPONSE_MAX_BYTES, 1024, 8 * 1024 * 1024)
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

/** Text and tool calls from one response become the assistant turn the next request continues from. */
export function outputToMessages(items: readonly Record<string, unknown>[]): CanonicalMessage[] {
  const text = items
    .filter((item) => item.type === 'message')
    .map((item) => {
      const content = Array.isArray(item.content) ? item.content : []
      return content
        .map((part) => (part && typeof part === 'object' && (part as Record<string, unknown>).type === 'output_text'
          ? String((part as Record<string, unknown>).text ?? '')
          : ''))
        .join('')
    })
    .join('')
  const calls = items
    .filter((item) => item.type === 'function_call' && typeof item.name === 'string')
    .map((item) => {
      const id = typeof item.call_id === 'string' ? item.call_id : String(item.id ?? '')
      const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})
      return { id: id || `call_${Math.random().toString(36).slice(2, 10)}`, type: 'function' as const, function: { name: String(item.name), arguments: args } }
    })
  if (!text && calls.length === 0) return []
  return [{ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }]
}

/**
 * Prior messages + prior output + the new input. A new `instructions` replaces the previous system
 * message rather than stacking a second one; without new instructions the previous one stays.
 */
export function chainMessages(
  prior: StoredGatewayResponse,
  incoming: CanonicalMessage[],
  instructions?: string,
): CanonicalMessage[] {
  const priorOutput = outputToMessages(prior.outputItems)
  if (instructions !== undefined) {
    return [
      { role: 'system', content: instructions },
      ...prior.canonicalMessages.filter((message) => message.role !== 'system'),
      ...priorOutput,
      ...incoming.filter((message) => message.role !== 'system'),
    ]
  }
  return [...prior.canonicalMessages, ...priorOutput, ...incoming]
}

export async function storeGatewayResponse(
  env: Env,
  input: StoreGatewayResponseInput,
): Promise<StoreGatewayResponseResult> {
  const now = input.now ?? Date.now()
  const ttl = responseTtlMs(env)
  const messages = JSON.stringify(input.canonicalMessages)
  const outputs = JSON.stringify(input.outputItems)
  const usage = JSON.stringify(input.usage)
  const metadata = input.metadata ? JSON.stringify(input.metadata) : null
  const sizeBytes = byteLength(messages) + byteLength(outputs) + byteLength(usage) + byteLength(metadata ?? '') + byteLength(input.outputText)
  const maxBytes = responseMaxBytes(env)
  if (maxBytes > 0 && sizeBytes > maxBytes) return { stored: false, reason: 'too_large' }
  await env.DB.prepare(
    `INSERT INTO ai_gateway_responses
       (id, user_id, key_id, model, previous_response_id, instructions, canonical_messages, output_items,
        output_text, usage, metadata, created_at, expires_at, size_bytes)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
     ON CONFLICT(id) DO UPDATE SET
       model = excluded.model,
       previous_response_id = excluded.previous_response_id,
       instructions = excluded.instructions,
       canonical_messages = excluded.canonical_messages,
       output_items = excluded.output_items,
       output_text = excluded.output_text,
       usage = excluded.usage,
       metadata = excluded.metadata,
       expires_at = excluded.expires_at,
       size_bytes = excluded.size_bytes`,
  ).bind(
    input.id,
    input.userId,
    input.keyId,
    input.model,
    input.previousResponseId ?? null,
    input.instructions ?? null,
    messages,
    outputs,
    input.outputText,
    usage,
    metadata,
    now,
    ttl > 0 ? now + ttl : 0,
    sizeBytes,
  ).run()
  return { stored: true }
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export async function readGatewayResponse(
  env: Env,
  userId: string,
  id: string,
  now = Date.now(),
): Promise<StoredGatewayResponse | null> {
  const row = await env.DB.prepare(
    `SELECT id, user_id, key_id, model, previous_response_id, instructions, canonical_messages, output_items,
            output_text, usage, metadata, created_at, expires_at, size_bytes
       FROM ai_gateway_responses
      WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<{
    id: string
    user_id: string
    key_id: string
    model: string
    previous_response_id: string | null
    instructions: string | null
    canonical_messages: string
    output_items: string
    output_text: string
    usage: string
    metadata: string | null
    created_at: number
    expires_at: number
    size_bytes: number
  }>()
  if (!row) return null
  if (row.expires_at > 0 && row.expires_at <= now) {
    await env.DB.prepare('DELETE FROM ai_gateway_responses WHERE user_id = ?1 AND id = ?2').bind(userId, id).run()
    return null
  }
  return {
    id: row.id,
    userId: row.user_id,
    keyId: row.key_id,
    model: row.model,
    previousResponseId: row.previous_response_id,
    instructions: row.instructions,
    canonicalMessages: parseJson<CanonicalMessage[]>(row.canonical_messages, []),
    outputItems: parseJson<Record<string, unknown>[]>(row.output_items, []),
    outputText: row.output_text,
    usage: parseJson<Record<string, unknown>>(row.usage, {}),
    metadata: parseJson<Record<string, string> | null>(row.metadata, null),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    sizeBytes: row.size_bytes,
  }
}

export async function deleteGatewayResponse(env: Env, userId: string, id: string): Promise<boolean> {
  const result = await env.DB.prepare(
    'DELETE FROM ai_gateway_responses WHERE user_id = ?1 AND id = ?2',
  ).bind(userId, id).run()
  return (result.meta.changes ?? 0) > 0
}

/** Called by the minute cron; expired rows are also removed lazily when someone reads them. */
export async function cleanupExpiredResponses(env: Env, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM ai_gateway_responses
      WHERE expires_at > 0 AND expires_at <= ?1
      LIMIT 500`,
  ).bind(now).all<{ id: string }>()
  const ids = (results ?? []).map((row) => row.id)
  if (ids.length === 0) return 0
  await env.DB.batch(ids.map((id) => env.DB.prepare('DELETE FROM ai_gateway_responses WHERE id = ?1').bind(id)))
  return ids.length
}

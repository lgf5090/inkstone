/**
 * Request evidence for the gateway. Bodies are deliberately absent: this table answers "who called,
 * which account served it, what did it cost and why did it fail" without becoming a second copy of
 * user prompts.
 */
import type { Env } from '../env'

export interface GatewayRequestInput {
  id: string
  userId: string
  keyId: string
  accountId: string
  day: string
  format: 'chat' | 'responses'
  stream: boolean
  model: string
  status: 'success' | 'error' | 'quota' | 'auth' | 'upstream' | 'client_abort'
  httpStatus: number
  upstreamStatus?: number | null
  reservedNeurons: number
  actualNeurons: number
  promptTokens: number
  completionTokens: number
  durationMs: number
  errorCode?: string | null
  now?: number
}

export interface GatewayRequestRecord extends GatewayRequestInput {
  createdAt: number
  keyName: string
}

export async function insertGatewayRequest(env: Env, input: GatewayRequestInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ai_gateway_requests
       (id, user_id, key_id, account_id, day, format, stream, model, status, http_status, upstream_status,
        reserved_neurons, actual_neurons, prompt_tokens, completion_tokens, duration_ms, error_code, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
  ).bind(
    input.id,
    input.userId,
    input.keyId,
    input.accountId,
    input.day,
    input.format,
    input.stream ? 1 : 0,
    input.model,
    input.status,
    input.httpStatus,
    input.upstreamStatus ?? null,
    input.reservedNeurons,
    input.actualNeurons,
    input.promptTokens,
    input.completionTokens,
    input.durationMs,
    input.errorCode ?? null,
    input.now ?? Date.now(),
  ).run()
}

export interface GatewayLogFilter {
  page: number
  pageSize: number
  status?: string
  format?: string
  keyId?: string
  accountId?: string
  model?: string
  since?: number
  until?: number
}

export async function listGatewayRequests(
  env: Env,
  userId: string,
  filter: GatewayLogFilter,
): Promise<{ items: GatewayRequestRecord[]; total: number }> {
  const where = ['r.user_id = ?']
  const values: unknown[] = [userId]
  if (filter.status) { where.push('r.status = ?'); values.push(filter.status) }
  if (filter.format) { where.push('r.format = ?'); values.push(filter.format) }
  if (filter.keyId) { where.push('r.key_id = ?'); values.push(filter.keyId) }
  if (filter.accountId) { where.push('r.account_id = ?'); values.push(filter.accountId) }
  if (filter.model) { where.push('r.model = ?'); values.push(filter.model) }
  if (filter.since) { where.push('r.created_at >= ?'); values.push(filter.since) }
  if (filter.until) { where.push('r.created_at <= ?'); values.push(filter.until) }
  const page = Math.max(1, Math.trunc(filter.page))
  const pageSize = Math.max(1, Math.min(100, Math.trunc(filter.pageSize)))
  const sql = `SELECT r.*, COALESCE(k.name, '(revoked)') AS key_name
                 FROM ai_gateway_requests r
                 LEFT JOIN ai_gateway_keys k ON k.id = r.key_id
                WHERE ${where.join(' AND ')}
                ORDER BY r.created_at DESC
                LIMIT ? OFFSET ?`
  const countSql = `SELECT COUNT(*) AS total FROM ai_gateway_requests r WHERE ${where.join(' AND ')}`
  const [count, rows] = await Promise.all([
    env.DB.prepare(countSql).bind(...values).first<{ total: number }>(),
    env.DB.prepare(sql).bind(...values, pageSize, (page - 1) * pageSize).all<{
      id: string
      user_id: string
      key_id: string
      account_id: string
      day: string
      format: 'chat' | 'responses'
      stream: number
      model: string
      status: GatewayRequestInput['status']
      http_status: number
      upstream_status: number | null
      reserved_neurons: number
      actual_neurons: number
      prompt_tokens: number
      completion_tokens: number
      duration_ms: number
      error_code: string | null
      created_at: number
      key_name: string
    }>(),
  ])
  return {
    total: count?.total ?? 0,
    items: (rows.results ?? []).map((row) => ({
      id: row.id,
      userId: row.user_id,
      keyId: row.key_id,
      accountId: row.account_id,
      day: row.day,
      format: row.format,
      stream: row.stream === 1,
      model: row.model,
      status: row.status,
      httpStatus: row.http_status,
      upstreamStatus: row.upstream_status,
      reservedNeurons: row.reserved_neurons,
      actualNeurons: row.actual_neurons,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      durationMs: row.duration_ms,
      errorCode: row.error_code,
      createdAt: row.created_at,
      keyName: row.key_name,
    })),
  }
}

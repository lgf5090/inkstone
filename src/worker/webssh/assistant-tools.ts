/**
 * The read-only WebSSH data the global assistant may see.
 *
 * These queries never touch `webssh_credentials` or `webssh_keys`: the assistant can answer "which
 * hosts do I have" and "what happened in my last session" without the model ever receiving a
 * password, a private key or a ciphertext. Host addresses and usernames are included because they
 * are what the reader named, and they are not secrets.
 */

import type { Env } from '../env'

export interface WebsshAssistantHost {
  id: string
  name: string
  address: string
  username: string
  authMethod: string
  groupId: string
  tags: string[]
  notes: string
  lastConnectedAt: number | null
}

export interface WebsshAssistantSession {
  id: string
  hostId: string
  hostName: string
  status: string
  startedAt: number
  connectedAt: number | null
  endedAt: number | null
  lastActivityAt: number
  closeReason: string
  errorCode: string
}

function parseTags(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 20) : []
  } catch {
    return []
  }
}

export async function listWebsshToolHosts(
  env: Env,
  userId: string,
  input: { query?: string, limit?: number, favorite?: boolean },
): Promise<WebsshAssistantHost[]> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 50)
  const rows = await env.DB.prepare(
    `SELECT id, name, host, port, username, auth_method, group_id, tags, notes, last_connected_at
       FROM webssh_hosts
      WHERE user_id = ?1 AND deleted_at IS NULL
        AND (?2 = '' OR name_folded LIKE '%' || lower(?2) || '%' OR lower(host) LIKE '%' || lower(?2) || '%')
        AND (?3 = 0 OR favorite = 1)
      ORDER BY favorite DESC, last_connected_at DESC, name_folded ASC
      LIMIT ?4`,
  )
    .bind(userId, input.query?.trim().toLowerCase() ?? '', input.favorite ? 1 : 0, limit)
    .all<{
      id: string, name: string, host: string, port: number, username: string,
      auth_method: string, group_id: string, tags: string, notes: string, last_connected_at: number | null,
    }>()
  return rows.results.map((row) => ({
    id: row.id,
    name: row.name,
    address: `${row.host}:${row.port}`,
    username: row.username,
    authMethod: row.auth_method,
    groupId: row.group_id,
    tags: parseTags(row.tags),
    notes: row.notes.slice(0, 600),
    lastConnectedAt: row.last_connected_at === null ? null : Number(row.last_connected_at),
  }))
}

export async function listWebsshToolSessions(
  env: Env,
  userId: string,
  input: { hostId?: string, status?: string, limit?: number },
): Promise<WebsshAssistantSession[]> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 15), 1), 40)
  const status = input.status && ['pending', 'connecting', 'active', 'closed', 'error'].includes(input.status)
    ? input.status
    : ''
  const rows = await env.DB.prepare(
    `SELECT s.id, s.host_id, COALESCE(h.name, '') AS host_name, s.status, s.started_at,
            s.connected_at, s.ended_at, s.last_activity_at, s.close_reason, s.error_code
       FROM webssh_sessions s
       LEFT JOIN webssh_hosts h ON h.user_id = s.user_id AND h.id = s.host_id
      WHERE s.user_id = ?1
        AND (?2 = '' OR s.host_id = ?2)
        AND (?3 = '' OR s.status = ?3)
      ORDER BY s.started_at DESC
      LIMIT ?4`,
  )
    .bind(userId, input.hostId ?? '', status, limit)
    .all<{
      id: string, host_id: string, host_name: string, status: string, started_at: number,
      connected_at: number | null, ended_at: number | null, last_activity_at: number,
      close_reason: string, error_code: string,
    }>()
  return rows.results.map((row) => ({
    id: row.id,
    hostId: row.host_id,
    hostName: row.host_name,
    status: row.status,
    startedAt: Number(row.started_at),
    connectedAt: row.connected_at === null ? null : Number(row.connected_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    lastActivityAt: Number(row.last_activity_at),
    closeReason: row.close_reason,
    errorCode: row.error_code,
  }))
}

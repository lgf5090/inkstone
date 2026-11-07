/**
 * Per-account routing switches for the self-hosted relay.
 *
 * Off is the default and a missing row means off, so the relay keeps calling Cloudflare directly
 * until a reader turns a switch on. Turning it on only adds the AI Gateway header to `/ai/v1`
 * requests; it never enables caching. Payload collection is a second switch and is never implied by
 * the first one, because it sends prompt bodies to Cloudflare's log store.
 */
import type { Env } from '../env'
import { ApiError } from '../lib/errors'

export interface GatewayRouting {
  enabled: boolean
  gatewayId: string
  collectLogPayload: boolean
}

/** What a row that does not exist means: both switches off, no gateway remembered. */
export const DEFAULT_GATEWAY_ROUTING: GatewayRouting = {
  enabled: false,
  gatewayId: '',
  collectLogPayload: false,
}

/** Gateway ids are slugs; a value that cannot be one is rejected rather than silently ignored. */
const GATEWAY_ID_RE = /^[A-Za-z0-9._-]{1,64}$/

interface RoutingRow {
  enabled: number
  gateway_id: string | null
  collect_log_payload: number
}

function fromRow(row: RoutingRow | null | undefined): GatewayRouting {
  if (!row) return DEFAULT_GATEWAY_ROUTING
  const enabled = row.enabled === 1
  return {
    enabled,
    gatewayId: row.gateway_id ?? '',
    collectLogPayload: enabled && row.collect_log_payload === 1,
  }
}

/**
 * Validate what the settings form sent. Payload collection is forced off while routing is off, so the
 * stored value cannot describe a header that would never be sent.
 */
export function normalizeGatewayRouting(input: Partial<GatewayRouting>): GatewayRouting {
  const gatewayId = typeof input.gatewayId === 'string' ? input.gatewayId.trim() : ''
  if (gatewayId && !GATEWAY_ID_RE.test(gatewayId)) {
    throw ApiError.badRequest('A gateway id can contain letters, digits, dots, underscores and dashes (max 64)')
  }
  const enabled = input.enabled === true
  if (enabled && !gatewayId) throw ApiError.badRequest('A gateway id is required when routing is enabled')
  return {
    enabled,
    gatewayId,
    collectLogPayload: enabled && input.collectLogPayload === true,
  }
}

export async function readGatewayRouting(
  env: Env,
  userId: string,
  accountId: string,
): Promise<GatewayRouting> {
  const row = await env.DB.prepare(
    `SELECT enabled, gateway_id, collect_log_payload
       FROM ai_gateway_routing
      WHERE user_id = ?1 AND account_id = ?2`,
  ).bind(userId, accountId).first<RoutingRow>()
  return fromRow(row)
}

/** One query for the settings panel rather than one per account. */
export async function readAllGatewayRouting(
  env: Env,
  userId: string,
): Promise<Map<string, GatewayRouting>> {
  const rows = await env.DB.prepare(
    `SELECT account_id, enabled, gateway_id, collect_log_payload
       FROM ai_gateway_routing
      WHERE user_id = ?1`,
  ).bind(userId).all<RoutingRow & { account_id: string }>()
  const map = new Map<string, GatewayRouting>()
  for (const row of rows.results ?? []) map.set(row.account_id, fromRow(row))
  return map
}

export async function saveGatewayRouting(
  env: Env,
  userId: string,
  accountId: string,
  input: Partial<GatewayRouting>,
): Promise<GatewayRouting> {
  const routing = normalizeGatewayRouting(input)
  await env.DB.prepare(
    `INSERT INTO ai_gateway_routing
       (user_id, account_id, enabled, gateway_id, collect_log_payload, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(user_id, account_id) DO UPDATE SET
       enabled = excluded.enabled,
       gateway_id = excluded.gateway_id,
       collect_log_payload = excluded.collect_log_payload,
       updated_at = excluded.updated_at`,
  ).bind(
    userId,
    accountId,
    routing.enabled ? 1 : 0,
    routing.gatewayId,
    routing.collectLogPayload ? 1 : 0,
    Date.now(),
  ).run()
  return routing
}

/** The headers a `/ai/v1` call adds when routing is on. Empty means byte-for-byte the old request. */
export function gatewayRoutingHeaders(routing: GatewayRouting): Record<string, string> {
  if (!routing.enabled || !routing.gatewayId) return {}
  return {
    'cf-aig-gateway-id': routing.gatewayId,
    ...(routing.collectLogPayload ? { 'cf-aig-collect-log-payload': 'true' } : {}),
  }
}

export async function gatewayHeadersForAccount(
  env: Env,
  userId: string,
  accountId: string,
): Promise<Record<string, string>> {
  return gatewayRoutingHeaders(await readGatewayRouting(env, userId, accountId))
}

import { fromBase64Url, toBase64Url, utf8 } from '../../lib/encoding'
import { ApiError } from '../../lib/errors'
import { isValidId, newId } from '../../lib/id'
import type {
  CerthubAccountView,
  CerthubCa,
  CerthubChallengeMode,
  CerthubConfigView,
  CerthubDnsProviderView,
  CerthubDomainStatus,
  CerthubDomainView,
  CerthubEventLevel,
  CerthubEventView,
  CerthubKeyAlgorithm,
  CerthubOrderStatus,
  CerthubOrderSummary,
  CerthubOrderView,
  CerthubSettingsView,
  CerthubSubject,
  CerthubTokenScope,
  CerthubTokenView,
} from '@shared/development/certhub/types'
import { CERTHUB_LIMITS } from '@shared/development/certhub/limits'

export interface AccountRow {
  user_id: string
  id: string
  ca: CerthubCa
  environment: 'production' | 'staging'
  directory_url: string
  account_url: string
  key_ciphertext: string
  key_fingerprint: string
  contact_email: string
  status: 'active' | 'deactivated' | 'error'
  last_error_code: string | null
  last_error_message: string | null
  last_used_at: number | null
  created_at: number
  updated_at: number
}

export interface OrderRow {
  user_id: string
  id: string
  account_id: string
  ca: CerthubCa
  environment: 'production' | 'staging'
  key_algorithm: CerthubKeyAlgorithm
  status: CerthubOrderStatus
  subject_json: string
  auto_renew: number
  renew_at: number | null
  order_expires_at: number | null
  acme_order_url: string
  finalize_url: string
  csr_object_key: string
  cert_object_key: string
  chain_object_key: string
  key_object_key: string
  key_fingerprint: string
  serial_number: string
  issuer: string
  cert_not_before: number | null
  cert_not_after: number | null
  issued_at: number | null
  revoked_at: number | null
  revoke_reason: number | null
  key_purged_at: number | null
  failure_code: string | null
  failure_message: string | null
  attempts: number
  last_attempt_at: number | null
  lock_owner: string | null
  locked_until: number | null
  renew_from_order_id: string | null
  idempotency_key: string
  deleted_at: number | null
  version: number
  created_at: number
  updated_at: number
}

export interface DomainRow {
  user_id: string
  id: string
  order_id: string
  name: string
  wildcard: number
  is_primary: number
  challenge_mode: CerthubChallengeMode
  status: CerthubDomainStatus
  authz_url: string
  challenge_url: string
  challenge_token: string
  key_authorization: string
  dns_record_name: string
  dns_record_type: string
  dns_record_value: string
  dns_provider_id: string
  dns_record_id: string
  validated_at: number | null
  error_code: string | null
  error_message: string | null
  created_at: number
  updated_at: number
}

export interface EventRow {
  user_id: string
  id: string
  order_id: string
  domain_id: string
  actor: 'user' | 'api' | 'system' | 'owner'
  kind: string
  level: CerthubEventLevel
  message_code: string
  detail_json: string
  created_at: number
}

export interface JobRow {
  user_id: string
  id: string
  order_id: string
  kind: 'advance' | 'renew' | 'cleanup' | 'notify'
  status: 'queued' | 'running' | 'done' | 'failed' | 'dead' | 'canceled'
  priority: number
  run_after: number
  attempts: number
  max_attempts: number
  lock_owner: string | null
  locked_until: number | null
  last_error_code: string | null
  last_error_message: string | null
  created_at: number
  updated_at: number
}

const ORDER_SELECT = `o.user_id, o.id, o.account_id, o.ca, o.environment, o.key_algorithm, o.status,
  o.subject_json, o.auto_renew, o.renew_at, o.order_expires_at, o.acme_order_url, o.finalize_url,
  o.csr_object_key, o.cert_object_key, o.chain_object_key, o.key_object_key, o.key_fingerprint,
  o.serial_number, o.issuer, o.cert_not_before, o.cert_not_after, o.issued_at, o.revoked_at,
  o.revoke_reason, o.key_purged_at, o.failure_code, o.failure_message, o.attempts, o.last_attempt_at,
  o.lock_owner, o.locked_until, o.renew_from_order_id, o.idempotency_key, o.deleted_at, o.version,
  o.created_at, o.updated_at`

const DOMAIN_SELECT = `d.user_id, d.id, d.order_id, d.name, d.wildcard, d.is_primary, d.challenge_mode,
  d.status, d.authz_url, d.challenge_url, d.challenge_token, d.key_authorization, d.dns_record_name,
  d.dns_record_type, d.dns_record_value, d.dns_provider_id, d.dns_record_id, d.validated_at,
  d.error_code, d.error_message, d.created_at, d.updated_at`

const ACCOUNT_SELECT = `user_id, id, ca, environment, directory_url, account_url, key_ciphertext,
  key_fingerprint, contact_email, status, last_error_code, last_error_message, last_used_at,
  created_at, updated_at`

const EVENT_SELECT = `user_id, id, order_id, domain_id, actor, kind, level, message_code, detail_json, created_at`

const JOB_SELECT = `user_id, id, order_id, kind, status, priority, run_after, attempts, max_attempts,
  lock_owner, locked_until, last_error_code, last_error_message, created_at, updated_at`

function assertId(id: string): string {
  if (!isValidId(id)) throw ApiError.badRequest('The id is not valid')
  return id
}

export function orderFromRow(row: OrderRow): CerthubOrderView {
  const domains = domainsForSubject(row)
  return {
    id: row.id,
    status: row.status,
    ca: row.ca,
    environment: row.environment,
    keyAlgorithm: row.key_algorithm,
    autoRenew: row.auto_renew === 1,
    subject: domains.subject,
    primaryDomain: domains.primary,
    domains: [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    issuedAt: row.issued_at,
    certNotBefore: row.cert_not_before,
    certNotAfter: row.cert_not_after,
    renewAt: row.renew_at,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    hasCertificate: Boolean(row.cert_object_key),
    hasPrivateKey: Boolean(row.key_object_key) && row.key_purged_at === null,
    keyFingerprint: row.key_fingerprint,
    serialNumber: row.serial_number,
    issuer: row.issuer,
    daysLeft: row.cert_not_after ? Math.ceil((row.cert_not_after - Date.now()) / 86_400_000) : null,
  }
}

export function domainView(row: DomainRow): CerthubDomainView {
  const fqdn = row.wildcard === 1 ? `*.${row.name}` : row.name
  return {
    id: row.id,
    name: row.name,
    fqdn,
    wildcard: row.wildcard === 1,
    primary: row.is_primary === 1,
    challengeMode: row.challenge_mode,
    status: row.status,
    recordName: row.dns_record_name || (row.challenge_mode === 'dns-01' ? `_acme-challenge.${row.name}` : ''),
    recordType: row.challenge_mode === 'http-01' ? 'HTTP' : (row.dns_record_type as 'TXT' | 'CNAME') || 'TXT',
    recordValue: row.dns_record_value || row.key_authorization,
    dnsProviderId: row.dns_provider_id,
    validatedAt: row.validated_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  }
}

export function orderWithDomains(row: OrderRow, domains: DomainRow[]): CerthubOrderView {
  const base = orderFromRow(row)
  const primary = domains.find((domain) => domain.is_primary === 1) ?? domains[0]
  return {
    ...base,
    primaryDomain: primary ? (primary.wildcard === 1 ? `*.${primary.name}` : primary.name) : '',
    domains: domains.map(domainView),
  }
}

function domainsForSubject(row: OrderRow): { subject: CerthubSubject; primary: string } {
  try {
    const subject = JSON.parse(row.subject_json) as CerthubSubject
    return { subject, primary: '' }
  } catch {
    return { subject: {}, primary: '' }
  }
}

export function summaryFromRow(
  row: OrderRow & { primary_name?: string | null; primary_wildcard?: number | null; domain_count?: number },
): CerthubOrderSummary {
  const primary = row.primary_name ?? ''
  return {
    id: row.id,
    status: row.status,
    ca: row.ca,
    keyAlgorithm: row.key_algorithm,
    autoRenew: row.auto_renew === 1,
    primaryDomain: primary ? (row.primary_wildcard === 1 ? `*.${primary}` : primary) : '',
    domainCount: Number(row.domain_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    certNotAfter: row.cert_not_after,
    renewAt: row.renew_at,
    failureCode: row.failure_code,
    hasCertificate: Boolean(row.cert_object_key),
    hasPrivateKey: Boolean(row.key_object_key) && row.key_purged_at === null,
    daysLeft: row.cert_not_after ? Math.ceil((row.cert_not_after - Date.now()) / 86_400_000) : null,
  }
}

export function encodeCursor(updatedAt: number, id: string): string {
  return toBase64Url(utf8(JSON.stringify({ updatedAt, id })))
}

export function decodeCursor(raw: string | undefined): { updatedAt: number; id: string } | null {
  if (!raw) return null
  try {
    const value = JSON.parse(new TextDecoder().decode(fromBase64Url(raw))) as { updatedAt?: unknown; id?: unknown }
    if (typeof value.updatedAt !== 'number' || typeof value.id !== 'string') return null
    return { updatedAt: value.updatedAt, id: value.id }
  } catch {
    throw ApiError.badRequest('The cursor is not valid')
  }
}

export async function findAccount(db: D1Database, userId: string, accountId: string): Promise<AccountRow | null> {
  return db.prepare(`SELECT ${ACCOUNT_SELECT} FROM development_certhub_accounts WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, assertId(accountId)).first<AccountRow>()
}

export async function findAccountForCa(
  db: D1Database,
  userId: string,
  ca: CerthubCa,
  environment: 'production' | 'staging',
): Promise<AccountRow | null> {
  return db.prepare(`SELECT ${ACCOUNT_SELECT} FROM development_certhub_accounts
    WHERE user_id = ?1 AND ca = ?2 AND environment = ?3 AND status = 'active'
    ORDER BY created_at DESC LIMIT 1`)
    .bind(userId, ca, environment).first<AccountRow>()
}

export async function listAccounts(db: D1Database, userId: string): Promise<AccountRow[]> {
  const { results } = await db.prepare(`SELECT ${ACCOUNT_SELECT} FROM development_certhub_accounts
    WHERE user_id = ?1 ORDER BY created_at DESC`).bind(userId).all<AccountRow>()
  return results
}

export async function insertAccount(db: D1Database, row: AccountRow): Promise<void> {
  await db.prepare(`INSERT INTO development_certhub_accounts (
    user_id, id, ca, environment, directory_url, account_url, key_ciphertext, key_fingerprint,
    contact_email, status, last_error_code, last_error_message, last_used_at, created_at, updated_at
  ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`)
    .bind(
      row.user_id, row.id, row.ca, row.environment, row.directory_url, row.account_url,
      row.key_ciphertext, row.key_fingerprint, row.contact_email, row.status, row.last_error_code,
      row.last_error_message, row.last_used_at, row.created_at, row.updated_at,
    ).run()
}

export async function updateAccount(
  db: D1Database,
  userId: string,
  accountId: string,
  patch: Partial<Pick<AccountRow, 'account_url' | 'key_ciphertext' | 'key_fingerprint' | 'status' | 'last_error_code' | 'last_error_message' | 'last_used_at' | 'updated_at'>>,
): Promise<void> {
  const fields: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    fields.push(`${key} = ?`)
    values.push(value)
  }
  if (fields.length === 0) return
  await db.prepare(`UPDATE development_certhub_accounts SET ${fields.join(', ')} WHERE user_id = ? AND id = ?`)
    .bind(...values, userId, accountId).run()
}

export async function findOrder(db: D1Database, userId: string, orderId: string): Promise<OrderRow | null> {
  return db.prepare(`SELECT ${ORDER_SELECT} FROM development_certhub_orders o
    WHERE o.user_id = ?1 AND o.id = ?2 AND o.deleted_at IS NULL`)
    .bind(userId, assertId(orderId)).first<OrderRow>()
}

export async function findOrderByIdempotency(
  db: D1Database,
  userId: string,
  idempotencyKey: string,
): Promise<OrderRow | null> {
  if (!idempotencyKey) return null
  return db.prepare(`SELECT ${ORDER_SELECT} FROM development_certhub_orders o
    WHERE o.user_id = ?1 AND o.idempotency_key = ?2 AND o.deleted_at IS NULL`)
    .bind(userId, idempotencyKey).first<OrderRow>()
}

export async function findOrderByAccountUrl(db: D1Database, userId: string, orderUrl: string): Promise<OrderRow | null> {
  return db.prepare(`SELECT ${ORDER_SELECT} FROM development_certhub_orders o
    WHERE o.user_id = ?1 AND o.acme_order_url = ?2 AND o.deleted_at IS NULL`)
    .bind(userId, orderUrl).first<OrderRow>()
}

export async function listDomains(db: D1Database, userId: string, orderId: string): Promise<DomainRow[]> {
  const { results } = await db.prepare(`SELECT ${DOMAIN_SELECT} FROM development_certhub_order_domains d
    WHERE d.user_id = ?1 AND d.order_id = ?2 ORDER BY d.is_primary DESC, d.name`)
    .bind(userId, orderId).all<DomainRow>()
  return results
}

export async function findDomain(
  db: D1Database,
  userId: string,
  orderId: string,
  domainId: string,
): Promise<DomainRow | null> {
  return db.prepare(`SELECT ${DOMAIN_SELECT} FROM development_certhub_order_domains d
    WHERE d.user_id = ?1 AND d.order_id = ?2 AND d.id = ?3`)
    .bind(userId, orderId, domainId).first<DomainRow>()
}

export interface CreateOrderRow {
  order: OrderRow
  domains: DomainRow[]
}

export async function insertOrder(db: D1Database, created: CreateOrderRow): Promise<void> {
  const o = created.order
  const statements = [
    db.prepare(`INSERT INTO development_certhub_orders (
      user_id, id, account_id, ca, environment, key_algorithm, status, subject_json, auto_renew,
      renew_at, order_expires_at, acme_order_url, finalize_url, csr_object_key, cert_object_key,
      chain_object_key, key_object_key, key_fingerprint, serial_number, issuer, cert_not_before,
      cert_not_after, issued_at, revoked_at, revoke_reason, key_purged_at, failure_code, failure_message,
      attempts, last_attempt_at, lock_owner, locked_until, renew_from_order_id, idempotency_key,
      deleted_at, version, created_at, updated_at
    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,
      ?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37,?38)`)
      .bind(
        o.user_id, o.id, o.account_id, o.ca, o.environment, o.key_algorithm, o.status, o.subject_json,
        o.auto_renew, o.renew_at, o.order_expires_at, o.acme_order_url, o.finalize_url,
        o.csr_object_key, o.cert_object_key, o.chain_object_key, o.key_object_key, o.key_fingerprint,
        o.serial_number, o.issuer, o.cert_not_before, o.cert_not_after, o.issued_at, o.revoked_at,
        o.revoke_reason, o.key_purged_at, o.failure_code, o.failure_message, o.attempts,
        o.last_attempt_at, o.lock_owner, o.locked_until, o.renew_from_order_id, o.idempotency_key,
        o.deleted_at, o.version, o.created_at, o.updated_at,
      ),
    ...created.domains.map((d) => db.prepare(`INSERT INTO development_certhub_order_domains (
      user_id, id, order_id, name, wildcard, is_primary, challenge_mode, status, authz_url, challenge_url,
      challenge_token, key_authorization, dns_record_name, dns_record_type, dns_record_value,
      dns_provider_id, dns_record_id, validated_at, error_code, error_message, created_at, updated_at
    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)`)
      .bind(
        d.user_id, d.id, d.order_id, d.name, d.wildcard, d.is_primary, d.challenge_mode, d.status,
        d.authz_url, d.challenge_url, d.challenge_token, d.key_authorization, d.dns_record_name,
        d.dns_record_type, d.dns_record_value, d.dns_provider_id, d.dns_record_id, d.validated_at,
        d.error_code, d.error_message, d.created_at, d.updated_at,
      )),
  ]
  await db.batch(statements)
}

const ORDER_PATCH_COLUMNS = new Set([
  'account_id', 'status', 'renew_at', 'order_expires_at', 'acme_order_url', 'finalize_url',
  'csr_object_key', 'cert_object_key', 'chain_object_key', 'key_object_key', 'key_fingerprint',
  'serial_number', 'issuer', 'cert_not_before', 'cert_not_after', 'issued_at', 'revoked_at',
  'revoke_reason', 'key_purged_at', 'failure_code', 'failure_message', 'attempts', 'last_attempt_at',
  'lock_owner', 'locked_until', 'deleted_at', 'version', 'updated_at',
])

export async function updateOrder(
  db: D1Database,
  userId: string,
  orderId: string,
  patch: Record<string, unknown>,
  expectedVersion?: number,
): Promise<boolean> {
  const fields: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (!ORDER_PATCH_COLUMNS.has(key) || value === undefined) continue
    fields.push(`${key} = ?`)
    values.push(value)
  }
  if (fields.length === 0) return false
  const guard = expectedVersion === undefined ? '' : ' AND version = ?'
  const result = await db.prepare(`UPDATE development_certhub_orders SET ${fields.join(', ')}
    WHERE user_id = ? AND id = ?${guard}`)
    .bind(...values, userId, orderId, ...(expectedVersion === undefined ? [] : [expectedVersion]))
    .run()
  return (result.meta?.changes ?? 0) > 0
}

const DOMAIN_PATCH_COLUMNS = new Set([
  'status', 'authz_url', 'challenge_url', 'challenge_token', 'key_authorization', 'dns_record_name',
  'dns_record_type', 'dns_record_value', 'dns_provider_id', 'dns_record_id', 'validated_at',
  'error_code', 'error_message', 'updated_at',
])

export async function updateDomain(
  db: D1Database,
  userId: string,
  orderId: string,
  domainId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const fields: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (!DOMAIN_PATCH_COLUMNS.has(key) || value === undefined) continue
    fields.push(`${key} = ?`)
    values.push(value)
  }
  if (fields.length === 0) return
  await db.prepare(`UPDATE development_certhub_order_domains SET ${fields.join(', ')}
    WHERE user_id = ? AND order_id = ? AND id = ?`)
    .bind(...values, userId, orderId, domainId).run()
}

export async function listOrders(
  db: D1Database,
  userId: string,
  options: {
    status?: CerthubOrderStatus
    ca?: CerthubCa
    q?: string
    expiringWithinDays?: number
    cursor?: { updatedAt: number; id: string } | null
    limit: number
  },
): Promise<{ items: CerthubOrderSummary[]; nextCursor: string | null }> {
  const where: string[] = ['o.user_id = ?1', 'o.deleted_at IS NULL']
  const params: unknown[] = [userId]
  let index = 2
  if (options.status) {
    where.push(`o.status = ?${index}`)
    params.push(options.status)
    index += 1
  }
  if (options.ca) {
    where.push(`o.ca = ?${index}`)
    params.push(options.ca)
    index += 1
  }
  if (options.q?.trim()) {
    const like = `%${options.q.trim().toLowerCase()}%`
    where.push(`(o.id LIKE ?${index} OR EXISTS (
      SELECT 1 FROM development_certhub_order_domains d
      WHERE d.user_id = o.user_id AND d.order_id = o.id AND d.name LIKE ?${index}
    ))`)
    params.push(like)
    index += 1
  }
  if (options.expiringWithinDays && options.expiringWithinDays > 0) {
    where.push(`o.cert_not_after IS NOT NULL AND o.cert_not_after <= ?${index}`)
    params.push(Date.now() + options.expiringWithinDays * 86_400_000)
    index += 1
  }
  if (options.cursor) {
    where.push(`(o.updated_at < ?${index} OR (o.updated_at = ?${index} AND o.id < ?${index + 1}))`)
    params.push(options.cursor.updatedAt, options.cursor.id)
    index += 2
  }
  const limit = Math.min(CERTHUB_LIMITS.listPageMax, Math.max(1, options.limit))
  const { results } = await db.prepare(`SELECT ${ORDER_SELECT},
      (SELECT d.name FROM development_certhub_order_domains d
       WHERE d.user_id = o.user_id AND d.order_id = o.id AND d.is_primary = 1 LIMIT 1) AS primary_name,
      (SELECT d.wildcard FROM development_certhub_order_domains d
       WHERE d.user_id = o.user_id AND d.order_id = o.id AND d.is_primary = 1 LIMIT 1) AS primary_wildcard,
      (SELECT COUNT(*) FROM development_certhub_order_domains d
       WHERE d.user_id = o.user_id AND d.order_id = o.id) AS domain_count
    FROM development_certhub_orders o
    WHERE ${where.join(' AND ')}
    ORDER BY o.updated_at DESC, o.id DESC
    LIMIT ?${index}`)
    .bind(...params, limit + 1)
    .all<OrderRow & { primary_name: string | null; primary_wildcard: number | null; domain_count: number }>()
  const rows = results.slice(0, limit)
  const last = rows[rows.length - 1]
  return {
    items: rows.map(summaryFromRow),
    nextCursor: results.length > limit && last ? encodeCursor(last.updated_at, last.id) : null,
  }
}

export async function listEvents(
  db: D1Database,
  userId: string,
  orderId: string,
  cursor: { createdAt: number; id: string } | null,
  limit: number,
  level?: CerthubEventLevel,
): Promise<{ items: CerthubEventView[]; nextCursor: string | null }> {
  const bounded = Math.min(CERTHUB_LIMITS.eventsPageMax, Math.max(1, limit))
  const parts = ['user_id = ?1', 'order_id = ?2']
  const params: unknown[] = [userId, orderId]
  let index = 3
  if (level) {
    parts.push(`level = ?${index}`)
    params.push(level)
    index += 1
  }
  if (cursor) {
    parts.push(`(created_at < ?${index} OR (created_at = ?${index} AND id < ?${index + 1}))`)
    params.push(cursor.createdAt, cursor.id)
    index += 2
  }
  const { results } = await db.prepare(`SELECT ${EVENT_SELECT} FROM development_certhub_events
    WHERE ${parts.join(' AND ')}
    ORDER BY created_at DESC, id DESC LIMIT ?${index}`)
    .bind(...params, bounded + 1).all<EventRow>()
  const rows = results.slice(0, bounded)
  const last = rows[rows.length - 1]
  return {
    items: rows.map(eventView),
    nextCursor: results.length > bounded && last ? encodeEventCursor(last) : null,
  }
}

export async function listRecentEvents(db: D1Database, userId: string, limit: number): Promise<CerthubEventView[]> {
  const { results } = await db.prepare(`SELECT ${EVENT_SELECT} FROM development_certhub_events
    WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2`)
    .bind(userId, Math.min(50, Math.max(1, limit))).all<EventRow>()
  return results.map(eventView)
}

export function eventView(row: EventRow): CerthubEventView {
  let detail: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(row.detail_json) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) detail = parsed as Record<string, unknown>
  } catch {
    detail = {}
  }
  return {
    id: row.id,
    orderId: row.order_id,
    domainId: row.domain_id,
    actor: row.actor,
    kind: row.kind,
    level: row.level,
    messageCode: row.message_code,
    detail,
    createdAt: row.created_at,
  }
}

function encodeEventCursor(row: EventRow): string {
  return toBase64Url(utf8(JSON.stringify({ createdAt: row.created_at, id: row.id })))
}

export function decodeEventCursor(raw: string | undefined): { createdAt: number; id: string } | null {
  if (!raw) return null
  try {
    const value = JSON.parse(new TextDecoder().decode(fromBase64Url(raw))) as { createdAt?: unknown; id?: unknown }
    if (typeof value.createdAt !== 'number' || typeof value.id !== 'string') return null
    return { createdAt: value.createdAt, id: value.id }
  } catch {
    throw ApiError.badRequest('The cursor is not valid')
  }
}

export async function appendEvent(
  db: D1Database,
  event: {
    userId: string
    orderId?: string
    domainId?: string
    actor: 'user' | 'api' | 'system' | 'owner'
    kind: string
    level?: CerthubEventLevel
    messageCode: string
    detail?: Record<string, unknown>
  },
): Promise<void> {
  await db.prepare(`INSERT INTO development_certhub_events (
    user_id, id, order_id, domain_id, actor, kind, level, message_code, detail_json, created_at
  ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`)
    .bind(
      event.userId, newId(), event.orderId ?? '', event.domainId ?? '', event.actor, event.kind,
      event.level ?? 'info', event.messageCode, JSON.stringify(event.detail ?? {}), Date.now(),
    ).run()
}

export async function ensureSettings(db: D1Database, userId: string): Promise<void> {
  const now = Date.now()
  await db.prepare(`INSERT OR IGNORE INTO development_certhub_settings (
    user_id, default_ca, default_key_algorithm, default_challenge_mode, default_auto_renew,
    renew_days_before, notify_on_issued, notify_on_failed, notify_on_expiring, notify_on_expired,
    max_active_certs, require_reauth_for_keys, created_at, updated_at
  ) VALUES (?1, 'lets-encrypt', 'eccp256', 'dns-01', 1, 30, 1, 1, 1, 1, ?2, 1, ?3, ?3)`)
    .bind(userId, CERTHUB_LIMITS.maxActiveCertsDefault, now).run()
}

export async function readSettings(db: D1Database, userId: string): Promise<CerthubSettingsView> {
  await ensureSettings(db, userId)
  const row = await db.prepare(`SELECT default_ca, default_key_algorithm, default_challenge_mode,
    default_auto_renew, renew_days_before, notify_on_issued, notify_on_failed, notify_on_expiring,
    notify_on_expired, max_active_certs, require_reauth_for_keys
    FROM development_certhub_settings WHERE user_id = ?1`)
    .bind(userId).first<{
      default_ca: CerthubCa
      default_key_algorithm: CerthubKeyAlgorithm
      default_challenge_mode: CerthubChallengeMode
      default_auto_renew: number
      renew_days_before: number
      notify_on_issued: number
      notify_on_failed: number
      notify_on_expiring: number
      notify_on_expired: number
      max_active_certs: number
      require_reauth_for_keys: number
    }>()
  if (!row) throw new ApiError(500, 'internal', 'The certificate settings row is missing')
  return {
    defaultCa: row.default_ca,
    defaultKeyAlgorithm: row.default_key_algorithm,
    defaultChallengeMode: row.default_challenge_mode,
    defaultAutoRenew: row.default_auto_renew === 1,
    renewDaysBefore: row.renew_days_before,
    notifyOnIssued: row.notify_on_issued === 1,
    notifyOnFailed: row.notify_on_failed === 1,
    notifyOnExpiring: row.notify_on_expiring === 1,
    notifyOnExpired: row.notify_on_expired === 1,
    maxActiveCerts: row.max_active_certs,
    requireReauthForKeys: row.require_reauth_for_keys === 1,
  }
}

export async function updateSettings(
  db: D1Database,
  userId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const allowed = new Set([
    'default_ca', 'default_key_algorithm', 'default_challenge_mode', 'default_auto_renew',
    'renew_days_before', 'notify_on_issued', 'notify_on_failed', 'notify_on_expiring',
    'notify_on_expired', 'max_active_certs', 'require_reauth_for_keys', 'updated_at',
  ])
  const fields: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.has(key) || value === undefined) continue
    fields.push(`${key} = ?`)
    values.push(value)
  }
  if (fields.length === 0) return
  await db.prepare(`UPDATE development_certhub_settings SET ${fields.join(', ')} WHERE user_id = ?`)
    .bind(...values, userId).run()
}

export async function readConfig(db: D1Database): Promise<CerthubConfigView> {
  const row = await db.prepare(`SELECT enabled_cas, max_orders_per_day, max_orders_per_month,
    max_pending_orders, max_active_certs_default, max_domains_per_order, acme_timeout_ms,
    job_batch_size FROM development_certhub_config WHERE id = 1`).first<{
      enabled_cas: string
      max_orders_per_day: number
      max_orders_per_month: number
      max_pending_orders: number
      max_active_certs_default: number
      max_domains_per_order: number
      acme_timeout_ms: number
      job_batch_size: number
    }>()
  if (!row) throw new ApiError(500, 'internal', 'The certificate configuration row is missing')
  return {
    enabledCas: row.enabled_cas.split(',').filter(Boolean) as CerthubCa[],
    maxOrdersPerDay: row.max_orders_per_day,
    maxOrdersPerMonth: row.max_orders_per_month,
    maxPendingOrders: row.max_pending_orders,
    maxActiveCertsDefault: row.max_active_certs_default,
    maxDomainsPerOrder: row.max_domains_per_order,
    acmeTimeoutMs: row.acme_timeout_ms,
    jobBatchSize: row.job_batch_size,
  }
}

export async function updateConfig(db: D1Database, patch: Record<string, unknown>): Promise<void> {
  const mapping: Record<string, string> = {
    enabledCas: 'enabled_cas',
    maxOrdersPerDay: 'max_orders_per_day',
    maxOrdersPerMonth: 'max_orders_per_month',
    maxPendingOrders: 'max_pending_orders',
    maxActiveCertsDefault: 'max_active_certs_default',
    maxDomainsPerOrder: 'max_domains_per_order',
    acmeTimeoutMs: 'acme_timeout_ms',
    jobBatchSize: 'job_batch_size',
  }
  const fields: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(patch)) {
    const column = mapping[key]
    if (!column || value === undefined) continue
    fields.push(`${column} = ?`)
    values.push(Array.isArray(value) ? value.join(',') : value)
  }
  if (fields.length === 0) return
  fields.push('updated_at = ?')
  values.push(Date.now())
  await db.prepare(`UPDATE development_certhub_config SET ${fields.join(', ')} WHERE id = 1`)
    .bind(...values).run()
}

export async function countActiveOrders(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS c FROM development_certhub_orders
    WHERE user_id = ?1 AND deleted_at IS NULL AND status IN
    ('queued','creating_order','awaiting_dns','awaiting_http','validating','ready','finalizing')`)
    .bind(userId).first<{ c: number }>()
  return Number(row?.c ?? 0)
}

export async function countLiveCertificates(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS c FROM development_certhub_orders
    WHERE user_id = ?1 AND deleted_at IS NULL AND status IN ('issued','expired')`).bind(userId)
    .first<{ c: number }>()
  return Number(row?.c ?? 0)
}

export async function incrementUsage(
  db: D1Database,
  userId: string,
  metric: 'orders_created' | 'attempts' | 'downloads' | 'api_calls',
  period: string,
  amount = 1,
): Promise<number> {
  await db.prepare(`INSERT INTO development_certhub_usage (user_id, metric, period, value, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(user_id, metric, period) DO UPDATE SET value = value + ?4, updated_at = ?5`)
    .bind(userId, metric, period, amount, Date.now()).run()
  const row = await db.prepare(`SELECT value FROM development_certhub_usage
    WHERE user_id = ?1 AND metric = ?2 AND period = ?3`).bind(userId, metric, period).first<{ value: number }>()
  return Number(row?.value ?? amount)
}

export async function readUsage(
  db: D1Database,
  userId: string,
  metric: 'orders_created' | 'attempts' | 'downloads' | 'api_calls',
  period: string,
): Promise<number> {
  const row = await db.prepare(`SELECT value FROM development_certhub_usage
    WHERE user_id = ?1 AND metric = ?2 AND period = ?3`).bind(userId, metric, period).first<{ value: number }>()
  return Number(row?.value ?? 0)
}

export async function enqueueJob(
  db: D1Database,
  input: {
    userId: string
    orderId: string
    kind: JobRow['kind']
    runAfter?: number
    priority?: number
  },
): Promise<JobRow> {
  const now = Date.now()
  const job: JobRow = {
    user_id: input.userId,
    id: newId(),
    order_id: input.orderId,
    kind: input.kind,
    status: 'queued',
    priority: input.priority ?? 0,
    run_after: input.runAfter ?? now,
    attempts: 0,
    max_attempts: CERTHUB_LIMITS.jobMaxAttempts,
    lock_owner: null,
    locked_until: null,
    last_error_code: null,
    last_error_message: null,
    created_at: now,
    updated_at: now,
  }
  const row = await db.prepare(`INSERT INTO development_certhub_jobs (
    user_id, id, order_id, kind, status, priority, run_after, attempts, max_attempts, lock_owner,
    locked_until, last_error_code, last_error_message, created_at, updated_at
  ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
  ON CONFLICT(user_id, order_id, kind) WHERE status IN ('queued','running')
  DO UPDATE SET
    run_after = MIN(development_certhub_jobs.run_after, excluded.run_after),
    priority = MAX(development_certhub_jobs.priority, excluded.priority),
    updated_at = excluded.updated_at
  RETURNING id`)
    .bind(
      job.user_id, job.id, job.order_id, job.kind, job.status, job.priority, job.run_after,
      job.attempts, job.max_attempts, job.lock_owner, job.locked_until, job.last_error_code,
      job.last_error_message, job.created_at, job.updated_at,
    ).first<{ id: string }>()
  return row ? { ...job, id: row.id } : job
}

export async function claimJobs(db: D1Database, owner: string, limit: number): Promise<JobRow[]> {
  const now = Date.now()
  const { results } = await db.prepare(`UPDATE development_certhub_jobs
    SET status = 'running', lock_owner = ?1, locked_until = ?2, attempts = attempts + 1, updated_at = ?3
    WHERE rowid IN (
      SELECT rowid FROM development_certhub_jobs
      WHERE status = 'queued' AND run_after <= ?3
      ORDER BY priority DESC, created_at ASC LIMIT ?4
    ) AND status = 'queued'
    RETURNING ${JOB_SELECT}`)
    .bind(owner, now + CERTHUB_LIMITS.jobLeaseMs, now, limit)
    .all<JobRow>()
  return results
}

export async function claimJobForOrder(
  db: D1Database,
  owner: string,
  userId: string,
  orderId: string,
): Promise<JobRow | null> {
  const now = Date.now()
  return db.prepare(`UPDATE development_certhub_jobs
    SET status = 'running', lock_owner = ?1, locked_until = ?2, attempts = attempts + 1, updated_at = ?3
    WHERE user_id = ?4 AND order_id = ?5 AND kind = 'advance' AND status = 'queued'
    RETURNING ${JOB_SELECT}`)
    .bind(owner, now + CERTHUB_LIMITS.jobLeaseMs, now, userId, orderId)
    .first<JobRow>()
}

export async function finishJob(
  db: D1Database,
  job: JobRow,
  outcome: { ok: boolean; errorCode?: string; errorMessage?: string; retryAfterMs?: number },
): Promise<void> {
  const now = Date.now()
  if (outcome.ok) {
    await db.prepare(`UPDATE development_certhub_jobs SET status = 'done', lock_owner = NULL,
      locked_until = NULL, last_error_code = NULL, last_error_message = NULL, updated_at = ?1
      WHERE user_id = ?2 AND id = ?3`).bind(now, job.user_id, job.id).run()
    return
  }
  const exhausted = job.attempts >= job.max_attempts
  if (exhausted) {
    await db.prepare(`UPDATE development_certhub_jobs SET status = 'dead', lock_owner = NULL,
      locked_until = NULL, last_error_code = ?1, last_error_message = ?2, updated_at = ?3
      WHERE user_id = ?4 AND id = ?5`)
      .bind(outcome.errorCode ?? 'job_failed', outcome.errorMessage ?? '', now, job.user_id, job.id).run()
    return
  }
  const backoff = outcome.retryAfterMs ?? Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, job.attempts - 1))
  await db.prepare(`UPDATE development_certhub_jobs SET status = 'queued', lock_owner = NULL,
    locked_until = NULL, run_after = ?1, last_error_code = ?2, last_error_message = ?3, updated_at = ?4
    WHERE user_id = ?5 AND id = ?6`)
    .bind(now + backoff, outcome.errorCode ?? 'job_failed', outcome.errorMessage ?? '', now, job.user_id, job.id).run()
}

export async function cancelJobsForOrder(db: D1Database, userId: string, orderId: string): Promise<void> {
  await db.prepare(`UPDATE development_certhub_jobs SET status = 'canceled', lock_owner = NULL,
    locked_until = NULL, updated_at = ?1 WHERE user_id = ?2 AND order_id = ?3 AND status IN ('queued','running')`)
    .bind(Date.now(), userId, orderId).run()
}

export async function listExpiring(db: D1Database, limit: number): Promise<OrderRow[]> {
  const { results } = await db.prepare(`SELECT ${ORDER_SELECT} FROM development_certhub_orders o
    WHERE o.deleted_at IS NULL AND o.status IN ('issued','expired')
      AND o.renew_at IS NOT NULL AND o.renew_at <= ?1
      AND NOT EXISTS (
        SELECT 1 FROM development_certhub_events e
        WHERE e.user_id = o.user_id AND e.order_id = o.id AND e.kind = 'notify.expiring'
      )
    ORDER BY o.renew_at ASC LIMIT ?2`)
    .bind(Date.now(), limit).all<OrderRow>()
  return results
}

export async function listDueRenewals(db: D1Database, limit: number): Promise<OrderRow[]> {
  const { results } = await db.prepare(`SELECT ${ORDER_SELECT} FROM development_certhub_orders o
    WHERE o.deleted_at IS NULL AND o.status IN ('issued','expired') AND o.auto_renew = 1
      AND o.renew_at IS NOT NULL AND o.renew_at <= ?1
      AND NOT EXISTS (
        SELECT 1 FROM development_certhub_orders n
        WHERE n.user_id = o.user_id AND n.renew_from_order_id = o.id AND n.deleted_at IS NULL
          AND n.status NOT IN ('failed','canceled')
      )
    ORDER BY o.renew_at ASC LIMIT ?2`)
    .bind(Date.now(), limit).all<OrderRow>()
  return results
}

export async function listAccountsForUser(db: D1Database, userId: string): Promise<CerthubAccountView[]> {
  const rows = await listAccounts(db, userId)
  return rows.map((row) => ({
    id: row.id,
    ca: row.ca,
    environment: row.environment,
    directoryUrl: row.directory_url,
    accountUrl: row.account_url,
    keyFingerprint: row.key_fingerprint,
    status: row.status,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  }))
}

export async function listProviders(db: D1Database, userId: string): Promise<CerthubDnsProviderView[]> {
  const { results } = await db.prepare(`SELECT user_id, id, kind, label, zone_id, zone_name,
    account_email, credential_ciphertext, status, last_checked_at, last_error_code, created_at, updated_at
    FROM development_certhub_dns_providers WHERE user_id = ?1 ORDER BY created_at DESC`)
    .bind(userId).all<{
      user_id: string
      id: string
      kind: 'cloudflare' | 'dcv-delegate'
      label: string
      zone_id: string
      zone_name: string
      account_email: string
      credential_ciphertext: string
      status: 'active' | 'error' | 'disabled'
      last_checked_at: number | null
      last_error_code: string | null
      created_at: number
      updated_at: number
    }>()
  return results.map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.label,
    zoneId: row.zone_id,
    zoneName: row.zone_name,
    accountEmail: row.account_email,
    configured: row.kind === 'dcv-delegate' ? true : Boolean(row.credential_ciphertext),
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

export interface ProviderRow {
  user_id: string
  id: string
  kind: 'cloudflare' | 'dcv-delegate'
  label: string
  zone_id: string
  zone_name: string
  account_email: string
  credential_ciphertext: string
  status: 'active' | 'error' | 'disabled'
  last_checked_at: number | null
  last_error_code: string | null
  last_error_message: string | null
  created_at: number
  updated_at: number
}

export async function findProvider(db: D1Database, userId: string, providerId: string): Promise<ProviderRow | null> {
  return db.prepare(`SELECT user_id, id, kind, label, zone_id, zone_name, account_email,
    credential_ciphertext, status, last_checked_at, last_error_code, last_error_message,
    created_at, updated_at FROM development_certhub_dns_providers
    WHERE user_id = ?1 AND id = ?2`).bind(userId, assertId(providerId)).first<ProviderRow>()
}

export async function insertProvider(db: D1Database, row: ProviderRow): Promise<void> {
  await db.prepare(`INSERT INTO development_certhub_dns_providers (
    user_id, id, kind, label, zone_id, zone_name, account_email, credential_ciphertext, status,
    last_checked_at, last_error_code, last_error_message, created_at, updated_at
  ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`)
    .bind(
      row.user_id, row.id, row.kind, row.label, row.zone_id, row.zone_name, row.account_email,
      row.credential_ciphertext, row.status, row.last_checked_at, row.last_error_code,
      row.last_error_message, row.created_at, row.updated_at,
    ).run()
}

export async function updateProvider(
  db: D1Database,
  userId: string,
  providerId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const allowed = new Set([
    'label', 'zone_id', 'zone_name', 'account_email', 'credential_ciphertext', 'status',
    'last_checked_at', 'last_error_code', 'last_error_message', 'updated_at',
  ])
  const fields: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.has(key) || value === undefined) continue
    fields.push(`${key} = ?`)
    values.push(value)
  }
  if (fields.length === 0) return
  await db.prepare(`UPDATE development_certhub_dns_providers SET ${fields.join(', ')}
    WHERE user_id = ? AND id = ?`).bind(...values, userId, providerId).run()
}

export async function deleteProvider(db: D1Database, userId: string, providerId: string): Promise<void> {
  await db.prepare(`DELETE FROM development_certhub_dns_providers WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, providerId).run()
}

export async function providerReferenced(db: D1Database, userId: string, providerId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT COUNT(*) AS c FROM development_certhub_order_domains
    WHERE user_id = ?1 AND dns_provider_id = ?2 AND status IN ('pending','prepared','validating')`)
    .bind(userId, providerId).first<{ c: number }>()
  return Number(row?.c ?? 0) > 0
}

export async function insertToken(
  db: D1Database,
  row: {
    userId: string
    id: string
    name: string
    tokenHash: string
    tokenPrefix: string
    scopes: CerthubTokenScope[]
    expiresAt: number | null
  },
): Promise<void> {
  await db.prepare(`INSERT INTO development_certhub_api_tokens (
    user_id, id, name, token_hash, token_prefix, scopes, expires_at, last_used_at, revoked_at, created_at
  ) VALUES (?1,?2,?3,?4,?5,?6,?7,NULL,NULL,?8)`)
    .bind(row.userId, row.id, row.name, row.tokenHash, row.tokenPrefix, row.scopes.join(','), row.expiresAt, Date.now())
    .run()
}

export async function listTokens(db: D1Database, userId: string): Promise<CerthubTokenView[]> {
  const { results } = await db.prepare(`SELECT id, name, token_prefix, scopes, expires_at,
    last_used_at, revoked_at, created_at FROM development_certhub_api_tokens
    WHERE user_id = ?1 ORDER BY created_at DESC`).bind(userId).all<{
      id: string
      name: string
      token_prefix: string
      scopes: string
      expires_at: number | null
      last_used_at: number | null
      revoked_at: number | null
      created_at: number
    }>()
  return results.map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.token_prefix,
    scopes: row.scopes.split(',').filter(Boolean) as CerthubTokenScope[],
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  }))
}

export async function findTokenByHash(db: D1Database, tokenHash: string): Promise<{
  user_id: string
  id: string
  scopes: string
  expires_at: number | null
  revoked_at: number | null
  last_used_at: number | null
} | null> {
  return db.prepare(`SELECT user_id, id, scopes, expires_at, revoked_at, last_used_at
    FROM development_certhub_api_tokens WHERE token_hash = ?1`).bind(tokenHash).first<{
      user_id: string
      id: string
      scopes: string
      expires_at: number | null
      revoked_at: number | null
      last_used_at: number | null
    }>()
}

export async function revokeToken(db: D1Database, userId: string, tokenId: string): Promise<void> {
  await db.prepare(`UPDATE development_certhub_api_tokens SET revoked_at = ?1 WHERE user_id = ?2 AND id = ?3`)
    .bind(Date.now(), userId, tokenId).run()
}

export async function touchToken(db: D1Database, userId: string, tokenId: string, lastUsedAt: number | null): Promise<void> {
  if (lastUsedAt && Date.now() - lastUsedAt < 60_000) return
  await db.prepare(`UPDATE development_certhub_api_tokens SET last_used_at = ?1 WHERE user_id = ?2 AND id = ?3`)
    .bind(Date.now(), userId, tokenId).run()
}

export async function deleteOrderRows(db: D1Database, userId: string, orderId: string): Promise<string[]> {
  const keys = await orderObjectKeys(db, userId, orderId)
  await db.batch([
    db.prepare(`DELETE FROM development_certhub_order_domains WHERE user_id = ?1 AND order_id = ?2`)
      .bind(userId, orderId),
    db.prepare(`DELETE FROM development_certhub_orders WHERE user_id = ?1 AND id = ?2`)
      .bind(userId, orderId),
  ])
  return keys
}

export async function orderObjectKeys(db: D1Database, userId: string, orderId: string): Promise<string[]> {
  const row = await db.prepare(`SELECT cert_object_key, chain_object_key, csr_object_key, key_object_key
    FROM development_certhub_orders WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, orderId).first<{
      cert_object_key: string
      chain_object_key: string
      csr_object_key: string
      key_object_key: string
    }>()
  if (!row) return []
  return [row.cert_object_key, row.chain_object_key, row.csr_object_key, row.key_object_key].filter(Boolean)
}

export async function keyReferencedElsewhere(db: D1Database, userId: string, orderId: string, key: string): Promise<boolean> {
  if (!key) return false
  const row = await db.prepare(`SELECT COUNT(*) AS c FROM development_certhub_orders
    WHERE user_id = ?1 AND id <> ?2 AND (cert_object_key = ?3 OR chain_object_key = ?3 OR csr_object_key = ?3 OR key_object_key = ?3)`)
    .bind(userId, orderId, key).first<{ c: number }>()
  return Number(row?.c ?? 0) > 0
}

export async function pruneEvents(db: D1Database, before: number, limit: number): Promise<number> {
  const result = await db.prepare(`DELETE FROM development_certhub_events WHERE rowid IN (
    SELECT rowid FROM development_certhub_events WHERE created_at < ?1 LIMIT ?2
  )`).bind(before, limit).run()
  return Number(result.meta?.changes ?? 0)
}

export function usageDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

export function usageMonth(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7)
}

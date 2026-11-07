/**
 * The self-hosted gateway's quota gate.
 *
 * Cloudflare's GraphQL total is authoritative but late; this ledger is what stops a request before it
 * is sent. Every reservation is one conditional UPDATE so two isolates racing on the same account see
 * each other's increment, and a reservation never shrinks: settling only raises `actual`/`reserved`
 * and reconciliation only raises them further. The hard limit is 10,000 neurons per account/day.
 */
import type { Env } from '../env'
import { newId } from '../lib/id'
import {
  accountHasFeature,
  loadActiveAccounts,
  type CloudflareAccountRow,
  type LoadedAccount,
} from './accounts'
import { getAiUsageToday } from './usage'

export const AI_GATEWAY_HARD_LIMIT = 10_000
export const AI_GATEWAY_DEFAULT_LIMIT = 9_500

export type GatewayAccountStatus = 'active' | 'cooling' | 'exhausted_today' | 'disabled' | 'auth_error'

export interface GatewayAccountState {
  accountId: string
  status: GatewayAccountStatus
  cooldownUntil: number
  errorCode: string | null
  failureCount: number
  selectionDay: string | null
  selectionCount: number
}

export interface GatewayLedgerRow {
  accountId: string
  reservedNeurons: number
  actualNeurons: number
  effectiveNeurons: number
  requests: number
  exhausted: boolean
}

export interface ReservationResult {
  ok: boolean
  reason?: 'exhausted' | 'insufficient' | 'missing'
  effective: number
}

export function gatewayDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

export function gatewayLimit(env: Env): number {
  const configured = Number(env.AI_GATEWAY_NEURON_LIMIT)
  if (!Number.isInteger(configured) || configured < 1) return AI_GATEWAY_DEFAULT_LIMIT
  return Math.min(AI_GATEWAY_HARD_LIMIT, configured)
}

function maxOf(reserved: number, actual: number): number {
  return Math.max(reserved, actual)
}

export async function reserveNeurons(
  env: Env,
  userId: string,
  accountId: string,
  model: string,
  reserve: number,
  limit: number,
  now = Date.now(),
): Promise<ReservationResult> {
  const day = gatewayDay(now)
  const amount = Math.max(1, Math.round(reserve))
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ai_gateway_account_ledger
        (user_id, account_id, day, model, reserved_neurons, actual_neurons, requests, exhausted, updated_at)
       VALUES (?1, ?2, ?3, '*', 0, 0, 0, 0, ?4)
       ON CONFLICT(user_id, account_id, day, model) DO NOTHING`,
    ).bind(userId, accountId, day, now),
    env.DB.prepare(
      `INSERT INTO ai_gateway_account_ledger
        (user_id, account_id, day, model, reserved_neurons, actual_neurons, requests, exhausted, updated_at)
       VALUES (?1, ?2, ?3, ?4, 0, 0, 0, 0, ?5)
       ON CONFLICT(user_id, account_id, day, model) DO NOTHING`,
    ).bind(userId, accountId, day, model, now),
  ])

  const update = await env.DB.prepare(
    `UPDATE ai_gateway_account_ledger
        SET reserved_neurons = reserved_neurons + ?5,
            requests = requests + 1,
            exhausted = CASE
              WHEN MAX(reserved_neurons, actual_neurons) + ?5 >= ?6 THEN 1
              ELSE exhausted END,
            updated_at = ?4
      WHERE user_id = ?1 AND account_id = ?2 AND day = ?3 AND model = '*'
        AND exhausted = 0
        AND MAX(reserved_neurons, actual_neurons) + ?5 <= ?6`,
  ).bind(userId, accountId, day, now, amount, limit).run()

  if ((update.meta.changes ?? 0) === 0) {
    const row = await env.DB.prepare(
      `SELECT reserved_neurons, actual_neurons, exhausted
         FROM ai_gateway_account_ledger
        WHERE user_id = ?1 AND account_id = ?2 AND day = ?3 AND model = '*'`,
    ).bind(userId, accountId, day).first<{
      reserved_neurons: number
      actual_neurons: number
      exhausted: number
    }>()
    if (!row) return { ok: false, reason: 'missing', effective: 0 }
    const effective = maxOf(row.reserved_neurons, row.actual_neurons)
    return {
      ok: false,
      reason: row.exhausted || effective >= limit ? 'exhausted' : 'insufficient',
      effective,
    }
  }

  await env.DB.prepare(
    `UPDATE ai_gateway_account_ledger
        SET reserved_neurons = reserved_neurons + ?4, updated_at = ?5
      WHERE user_id = ?1 AND account_id = ?2 AND day = ?3 AND model = ?6`,
  ).bind(userId, accountId, day, amount, now, model).run()

  return { ok: true, effective: 0 }
}

export async function settleNeurons(
  env: Env,
  userId: string,
  accountId: string,
  model: string,
  actual: number,
  limit: number,
  now = Date.now(),
): Promise<{ effective: number; exhausted: boolean }> {
  const day = gatewayDay(now)
  const amount = Math.max(0, Math.round(actual))
  await env.DB.prepare(
    `UPDATE ai_gateway_account_ledger
        SET actual_neurons = actual_neurons + ?5,
            reserved_neurons = MAX(reserved_neurons, actual_neurons + ?5),
            exhausted = CASE
              WHEN MAX(reserved_neurons, actual_neurons + ?5) >= ?6 THEN 1
              ELSE exhausted END,
            updated_at = ?4
      WHERE user_id = ?1 AND account_id = ?2 AND day = ?3 AND model = '*'`,
  ).bind(userId, accountId, day, now, amount, limit).run()
  await env.DB.prepare(
    `UPDATE ai_gateway_account_ledger
        SET actual_neurons = actual_neurons + ?4, updated_at = ?5
      WHERE user_id = ?1 AND account_id = ?2 AND day = ?3 AND model = ?6`,
  ).bind(userId, accountId, day, amount, now, model).run()

  const row = await env.DB.prepare(
    `SELECT MAX(reserved_neurons, actual_neurons) AS effective, exhausted
       FROM ai_gateway_account_ledger
      WHERE user_id = ?1 AND account_id = ?2 AND day = ?3 AND model = '*'`,
  ).bind(userId, accountId, day).first<{ effective: number; exhausted: number }>()
  const effective = row?.effective ?? 0
  const exhausted = (row?.exhausted ?? 0) === 1 || effective >= limit
  if (exhausted) await setAccountStatus(env, userId, accountId, 'exhausted_today', now, 0, null)
  return { effective, exhausted }
}

export async function readLedgers(env: Env, userId: string, now = Date.now()): Promise<Map<string, GatewayLedgerRow>> {
  const day = gatewayDay(now)
  const { results } = await env.DB.prepare(
    `SELECT account_id, reserved_neurons, actual_neurons, requests, exhausted
       FROM ai_gateway_account_ledger
      WHERE user_id = ?1 AND day = ?2 AND model = '*'
      ORDER BY account_id`,
  ).bind(userId, day).all<{
    account_id: string
    reserved_neurons: number
    actual_neurons: number
    requests: number
    exhausted: number
  }>()
  const map = new Map<string, GatewayLedgerRow>()
  for (const row of results ?? []) {
    map.set(row.account_id, {
      accountId: row.account_id,
      reservedNeurons: row.reserved_neurons,
      actualNeurons: row.actual_neurons,
      effectiveNeurons: maxOf(row.reserved_neurons, row.actual_neurons),
      requests: row.requests,
      exhausted: row.exhausted === 1,
    })
  }
  return map
}

export async function readAccountStates(env: Env, userId: string): Promise<Map<string, GatewayAccountState>> {
  const { results } = await env.DB.prepare(
    `SELECT account_id, status, cooldown_until, error_code, failure_count, selection_day, selection_count
       FROM ai_gateway_account_state
      WHERE user_id = ?1`,
  ).bind(userId).all<{
    account_id: string
    status: string
    cooldown_until: number
    error_code: string | null
    failure_count: number
    selection_day: string | null
    selection_count: number
  }>()
  const map = new Map<string, GatewayAccountState>()
  for (const row of results ?? []) {
    map.set(row.account_id, {
      accountId: row.account_id,
      status: row.status as GatewayAccountStatus,
      cooldownUntil: row.cooldown_until,
      errorCode: row.error_code,
      failureCount: row.failure_count,
      selectionDay: row.selection_day,
      selectionCount: row.selection_count,
    })
  }
  return map
}

export async function setAccountStatus(
  env: Env,
  userId: string,
  accountId: string,
  status: GatewayAccountStatus,
  now = Date.now(),
  cooldownUntil = 0,
  errorCode: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ai_gateway_account_state
       (user_id, account_id, status, cooldown_until, error_code, last_error_at, failure_count, selection_day, selection_count, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, 0, ?8)
     ON CONFLICT(user_id, account_id) DO UPDATE SET
       status = excluded.status,
       cooldown_until = excluded.cooldown_until,
       error_code = excluded.error_code,
       last_error_at = excluded.last_error_at,
       selection_day = excluded.selection_day,
       updated_at = excluded.updated_at`,
  ).bind(
    userId,
    accountId,
    status,
    cooldownUntil,
    errorCode,
    now,
    status === 'exhausted_today' ? gatewayDay(now) : null,
    now,
  ).run()
}

export async function markAccountSelected(
  env: Env,
  userId: string,
  accountId: string,
  now = Date.now(),
): Promise<void> {
  const day = gatewayDay(now)
  // One UPSERT, not "UPDATE then INSERT": several requests can be reserving at the same instant and
  // the fallback INSERT would then collide on the primary key.
  await env.DB.prepare(
    `INSERT INTO ai_gateway_account_state
       (user_id, account_id, status, cooldown_until, error_code, last_error_at, failure_count, selection_day, selection_count, updated_at)
     VALUES (?1, ?2, 'active', 0, NULL, NULL, 0, ?3, 1, ?4)
     ON CONFLICT(user_id, account_id) DO UPDATE SET
       selection_count = CASE
         WHEN ai_gateway_account_state.selection_day = excluded.selection_day
           THEN ai_gateway_account_state.selection_count + 1
         ELSE 1 END,
       selection_day = excluded.selection_day,
       status = CASE
         WHEN ai_gateway_account_state.status IN ('cooling', 'exhausted_today') THEN 'active'
         ELSE ai_gateway_account_state.status END,
       cooldown_until = 0,
       updated_at = excluded.updated_at`,
  ).bind(userId, accountId, day, now).run()
}

export async function markAccountFailure(
  env: Env,
  userId: string,
  accountId: string,
  status: 'cooling' | 'auth_error',
  errorCode: string,
  now = Date.now(),
): Promise<void> {
  const state = (await readAccountStates(env, userId)).get(accountId)
  const failures = (state?.failureCount ?? 0) + 1
  const cooldown = status === 'auth_error'
    ? 0
    : now + Math.min(10 * 60_000, 30_000 * 2 ** Math.max(0, failures - 1))
  await env.DB.prepare(
    `INSERT INTO ai_gateway_account_state
       (user_id, account_id, status, cooldown_until, error_code, last_error_at, failure_count, selection_day, selection_count, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, 0, ?6)
     ON CONFLICT(user_id, account_id) DO UPDATE SET
       status = excluded.status,
       cooldown_until = excluded.cooldown_until,
       error_code = excluded.error_code,
       last_error_at = excluded.last_error_at,
       failure_count = excluded.failure_count,
       updated_at = excluded.updated_at`,
  ).bind(userId, accountId, status, cooldown, errorCode, now, failures).run()
}

export async function markAccountSuccess(env: Env, userId: string, accountId: string, now = Date.now()): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ai_gateway_account_state
       (user_id, account_id, status, cooldown_until, error_code, last_error_at, failure_count, selection_day, selection_count, updated_at)
     VALUES (?1, ?2, 'active', 0, NULL, NULL, 0, NULL, 0, ?3)
     ON CONFLICT(user_id, account_id) DO UPDATE SET
       status = CASE WHEN status = 'exhausted_today' THEN status ELSE 'active' END,
       cooldown_until = 0,
       error_code = NULL,
       failure_count = 0,
       updated_at = excluded.updated_at`,
  ).bind(userId, accountId, now).run()
}

export interface GatewayCandidate {
  account: LoadedAccount
  effective: number
  remaining: number
  score: number
}

export async function selectGatewayAccount(
  env: Env,
  userId: string,
  skip: ReadonlySet<string>,
  reserve: number,
  limit: number,
  now = Date.now(),
): Promise<GatewayCandidate | null> {
  const day = gatewayDay(now)
  const accounts = (await loadActiveAccounts(env, userId)).filter(({ row }) => (
    Boolean(row.cf_account_id) && accountHasFeature(row, 'ai')
  ))
  if (accounts.length === 0) return null
  const [ledgers, states] = await Promise.all([readLedgers(env, userId, now), readAccountStates(env, userId)])
  let best: GatewayCandidate | null = null
  for (const account of accounts) {
    const id = account.row.id
    if (skip.has(id)) continue
    const state = states.get(id)
    if (state) {
      if (state.status === 'disabled' || state.status === 'auth_error') continue
      if (state.status === 'cooling' && state.cooldownUntil > now) continue
      if (state.status === 'exhausted_today' && state.selectionDay === day) continue
    }
    const ledger = ledgers.get(id)
    const effective = ledger?.effectiveNeurons ?? 0
    if (ledger?.exhausted) continue
    if (!ledger && reserve > limit) continue
    const remaining = Math.max(0, limit - effective)
    if (remaining < reserve) continue
    const selections = state?.selectionDay === day ? state.selectionCount : 0
    const score = remaining / (1 + selections)
    if (!best || score > best.score) best = { account, effective, remaining, score }
  }
  return best
}

export interface ReconcileResult {
  accountId: string
  accountName: string
  authoritative: number
  localEffective: number
  outcome: 'ok' | 'raised' | 'over' | 'error'
  note?: string
}

export async function reconcileAccount(
  env: Env,
  userId: string,
  row: CloudflareAccountRow,
  auth: LoadedAccount['auth'],
  limit: number,
  now = Date.now(),
): Promise<ReconcileResult> {
  const day = gatewayDay(now)
  if (!row.cf_account_id) {
    return { accountId: row.id, accountName: row.name, authoritative: 0, localEffective: 0, outcome: 'error', note: 'missing cf account id' }
  }
  const local = (await readLedgers(env, userId, now)).get(row.id)
  const localEffective = local?.effectiveNeurons ?? 0
  let authoritative = 0
  try {
    authoritative = (await getAiUsageToday(auth, row.cf_account_id)).totalNeurons
  } catch (error) {
    const note = (error as Error)?.message ?? 'GraphQL failed'
    await insertSnapshot(env, userId, row.id, day, 0, localEffective, 0, 'error', note, now)
    return { accountId: row.id, accountName: row.name, authoritative: 0, localEffective, outcome: 'error', note }
  }
  let outcome: ReconcileResult['outcome'] = 'ok'
  if (authoritative > localEffective) {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO ai_gateway_account_ledger
          (user_id, account_id, day, model, reserved_neurons, actual_neurons, requests, exhausted, updated_at)
         VALUES (?1, ?2, ?3, '*', ?4, ?4, 0, ?5, ?6)
         ON CONFLICT(user_id, account_id, day, model) DO UPDATE SET
           actual_neurons = MAX(actual_neurons, excluded.actual_neurons),
           reserved_neurons = MAX(reserved_neurons, actual_neurons, excluded.actual_neurons),
           exhausted = CASE
             WHEN MAX(actual_neurons, reserved_neurons, excluded.actual_neurons) >= ?7 THEN 1
             ELSE exhausted END,
           updated_at = excluded.updated_at`,
      ).bind(userId, row.id, day, authoritative, authoritative >= limit ? 1 : 0, now, limit),
      env.DB.prepare(
        `UPDATE ai_gateway_account_state
            SET status = CASE WHEN ?3 = 1 THEN 'exhausted_today' ELSE status END,
                updated_at = ?4
          WHERE user_id = ?1 AND account_id = ?2`,
      ).bind(userId, row.id, authoritative >= limit ? 1 : 0, now),
    ])
    outcome = authoritative >= limit ? 'over' : 'raised'
  }
  await insertSnapshot(env, userId, row.id, day, authoritative, localEffective, authoritative - localEffective, outcome, null, now)
  return { accountId: row.id, accountName: row.name, authoritative, localEffective, outcome }
}

async function insertSnapshot(
  env: Env,
  userId: string,
  accountId: string,
  day: string,
  authoritative: number,
  localEffective: number,
  delta: number,
  outcome: string,
  note: string | null,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ai_gateway_reconcile_snapshots
       (id, user_id, account_id, day, authoritative_neurons, local_effective, delta, outcome, checked_at, note)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  ).bind(newId(), userId, accountId, day, authoritative, localEffective, delta, outcome, now, note).run()
}

export async function reconcileAll(env: Env, userId: string): Promise<ReconcileResult[]> {
  const limit = gatewayLimit(env)
  const accounts = (await loadActiveAccounts(env, userId)).filter(({ row }) => (
    Boolean(row.cf_account_id) && accountHasFeature(row, 'ai')
  ))
  return await Promise.all(accounts.map(({ row, auth }) => reconcileAccount(env, userId, row, auth, limit)))
}



import { ApiError } from './errors'

const DEFAULT_FREE_FAILS = 5
const WINDOW_MS = 60 * 60 * 1000

/**
 * The lock each failure past the free budget buys, doubling while it still means something.
 *
 * Entry n is the lock for the (n + 1)-th failure beyond `freeFails`; `LOCKOUT_MAX_MS` holds for every
 * failure after the ladder runs out, so the attempt rate stays bounded instead of doubling forever.
 * `recordLoginFailure` builds its SQL from these, so the numbers live in one place.
 */
const LOCKOUT_LADDER_MS = [60_000, 120_000, 240_000, 480_000] as const
/** The lock every failure after the ladder is served. */
const LOCKOUT_MAX_MS = 900_000

export interface ThrottleTarget {
  key: string
  freeFails?: number
}

export interface AttemptBudgetTarget {
  key: string
  maxAttempts: number
  windowMs: number
  lockMs?: number
}

type ThrottleInput = string | ThrottleTarget

export class ThrottleError extends Error {
  readonly retryAfterSec: number
  constructor(retryAfterMs: number) {
    super('too_many_attempts')
    this.name = 'ThrottleError'
    this.retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000))
  }
}

/**
 * Runs a throttled step — spending an attempt budget, checking a lock, or both — and answers the
 * `429` the API promises once the throttle rejects it.
 *
 * Every throttled route funnels through here so the status, error code, `Retry-After` hint and
 * response shape cannot drift apart. `message` is the human prefix a route shows; the retry count is
 * appended here. The step is a thunk so a route that checks a lock before spending work keeps its
 * exact ordering.
 */
export async function assertAttemptBudget(
  run: () => Promise<unknown>,
  message = 'Too many attempts',
): Promise<void> {
  try {
    await run()
  } catch (error) {
    if (error instanceof ThrottleError) {
      throw new ApiError(
        429,
        'too_many_attempts',
        `${message}. Try again in ${error.retryAfterSec} seconds`,
        { retryAfter: error.retryAfterSec },
      )
    }
    throw error
  }
}

function placeholders(n: number): string {
  return Array.from({ length: n }, (_, i) => `?${i + 1}`).join(', ')
}

export async function assertNotLocked(db: D1Database, inputs: readonly ThrottleInput[]): Promise<void> {
  const keys = normalizeTargets(inputs).map((target) => target.key)
  if (!keys.length) return
  const { results } = await db
    .prepare(`SELECT locked_until FROM login_attempts WHERE key IN (${placeholders(keys.length)})`)
    .bind(...keys)
    .all<{ locked_until: number | null }>()
  const now = Date.now()
  let retryAfterMs = 0
  for (const row of results) {
    if (row.locked_until && row.locked_until > now) {
      retryAfterMs = Math.max(retryAfterMs, row.locked_until - now)
    }
  }
  if (retryAfterMs) throw new ThrottleError(retryAfterMs)
}

export async function consumeAttemptBudget(
  db: D1Database,
  inputs: readonly AttemptBudgetTarget[],
): Promise<void> {
  const targets = normalizeAttemptBudgets(inputs)
  if (!targets.length) return
  const now = Date.now()
  const sql = `
    INSERT INTO login_attempts (key, fails, last_fail_at, locked_until)
    VALUES (?1, 1, ?2, NULL)
    ON CONFLICT(key) DO UPDATE SET
      fails = CASE
        WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until > ?2
          THEN login_attempts.fails
        WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.fails > ?4
          THEN 1
        WHEN ?2 - login_attempts.last_fail_at >= ?3 THEN 1
        ELSE login_attempts.fails + 1
      END,
      last_fail_at = CASE
        WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until > ?2
          THEN login_attempts.last_fail_at
        ELSE ?2
      END,
      locked_until = CASE
        WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until > ?2
          THEN login_attempts.locked_until
        WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.fails > ?4
          THEN NULL
        WHEN ?2 - login_attempts.last_fail_at >= ?3 THEN NULL
        WHEN login_attempts.fails + 1 > ?4 THEN ?2 + ?5
        ELSE NULL
      END
    RETURNING locked_until`
  const statements = targets.map((target) =>
    db.prepare(sql).bind(
      target.key,
      now,
      target.windowMs,
      target.maxAttempts,
      target.lockMs,
    ),
  )
  const results = await db.batch<{ locked_until: number | null }>(statements)
  let retryAfterMs = 0
  for (const result of results) {
    const lockedUntil = result.results?.[0]?.locked_until
    if (lockedUntil && lockedUntil > now) {
      retryAfterMs = Math.max(retryAfterMs, lockedUntil - now)
    }
  }
  if (retryAfterMs) throw new ThrottleError(retryAfterMs)
}

export async function recordLoginFailure(
  db: D1Database,
  inputs: readonly ThrottleInput[],
): Promise<void> {
  const targets = normalizeTargets(inputs)
  if (!targets.length) return
  const now = Date.now()
  // The ladder is bound rather than spliced into the text: ?5..?8 are its steps and ?9 the lock they
  // stop at, so `LOCKOUT_LADDER_MS` stays the only place a duration is written down.
  const ladderStart = 5
  const rungs = LOCKOUT_LADDER_MS.map((_, step) =>
    `        WHEN login_attempts.fails + 1 = ?4 + ${step} THEN ?2 + ?${ladderStart + step}`,
  ).join('\n')
  const sql = `
    INSERT INTO login_attempts (key, fails, last_fail_at, locked_until)
    VALUES (?1, 1, ?2, NULL)
    ON CONFLICT(key) DO UPDATE SET
      fails = CASE
        WHEN ?2 - login_attempts.last_fail_at > ?3 THEN 1
        ELSE login_attempts.fails + 1
      END,
      last_fail_at = ?2,
      locked_until = CASE
        WHEN ?2 - login_attempts.last_fail_at > ?3 THEN NULL
        WHEN login_attempts.fails + 1 < ?4 THEN NULL
${rungs}
        ELSE ?2 + ?${ladderStart + LOCKOUT_LADDER_MS.length}
      END`
  const statements = targets.map((target) =>
    db.prepare(sql).bind(target.key, now, WINDOW_MS, target.freeFails, ...LOCKOUT_LADDER_MS, LOCKOUT_MAX_MS),
  )
  await db.batch(statements)
}

export async function clearLoginFailures(
  db: D1Database,
  inputs: readonly ThrottleInput[],
): Promise<void> {
  const keys = normalizeTargets(inputs).map((target) => target.key)
  if (!keys.length) return
  await db
    .prepare(`DELETE FROM login_attempts WHERE key IN (${placeholders(keys.length)})`)
    .bind(...keys)
    .run()
}

/**
 * Count budget rows whose key falls in `[lowKey, highKey)` and were touched at or after `since`.
 *
 * `login_attempts` belongs to this module, so the only read of it that is not a lock check lives here
 * too rather than in the route that happens to want the number. The caller picks the range and the
 * window: a reader that keys a metric off the budget writes the prefix, and this just counts rows in
 * it. The range is spelled as `>= / <` (not `LIKE`) so a key that contains a SQL wildcard character
 * still only matches literally. The result column is named for the one caller that reads it.
 */
export async function countAttemptKeysInRange(
  db: D1Database,
  lowKey: string,
  highKey: string,
  since: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS viewers FROM login_attempts WHERE key >= ?1 AND key < ?2 AND last_fail_at >= ?3`,
    )
    .bind(lowKey, highKey, since)
    .first<{ viewers: number }>()
  return Number(row?.viewers ?? 0)
}

function normalizeTargets(inputs: readonly ThrottleInput[]): Required<ThrottleTarget>[] {
  const unique = new Map<string, number>()
  for (const input of inputs) {
    const rawKey = typeof input === 'string' ? input : input.key
    const key = rawKey.slice(0, 256)
    if (!key) continue
    const requested = typeof input === 'string' ? DEFAULT_FREE_FAILS : input.freeFails
    const freeFails = Math.min(100, Math.max(2, Math.trunc(requested ?? DEFAULT_FREE_FAILS)))
    const previous = unique.get(key)
    unique.set(key, previous === undefined ? freeFails : Math.min(previous, freeFails))
  }
  return [...unique].map(([key, freeFails]) => ({ key, freeFails }))
}

function normalizeAttemptBudgets(inputs: readonly AttemptBudgetTarget[]): Required<AttemptBudgetTarget>[] {
  const unique = new Map<string, Required<AttemptBudgetTarget>>()
  for (const input of inputs) {
    const key = input.key.slice(0, 256)
    if (!key) continue
    const maxAttempts = Math.min(1000, Math.max(1, Math.trunc(input.maxAttempts)))
    const windowMs = Math.min(24 * 60 * 60 * 1000, Math.max(1000, Math.trunc(input.windowMs)))
    const lockMs = Math.min(
      24 * 60 * 60 * 1000,
      Math.max(1000, Math.trunc(input.lockMs ?? windowMs)),
    )
    const candidate = { key, maxAttempts, windowMs, lockMs }
    const previous = unique.get(key)
    if (!previous || maxAttempts < previous.maxAttempts) unique.set(key, candidate)
  }
  return [...unique.values()]
}

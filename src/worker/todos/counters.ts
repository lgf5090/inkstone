/**
 * The habits screen: what the reader counts, and how much of it happened on which day.
 *
 * A separate module from the assistant's store because nothing here is a task. A habit has no due date,
 * no list, no repeat rule and no place on the plate — it is a counter with a name, and the only question
 * it answers is whether today reached the target. Pulling it into the store would have put a rule with no
 * neighbours next to the code that carries every task rule in the app.
 *
 * The two tables it owns are declared in `todos/schema.ts` with everything else the boot builds; the
 * statements that read and write them live here, because no route may hold SQL and this module is what
 * owns those names.
 */

import { localDate } from '@shared/assistant-time'
import {
  COUNTER_WINDOW_DAYS,
  MAX_COUNTER_DAY_AMOUNT,
  MAX_COUNTERS_PER_ACCOUNT,
  defaultColorFor,
  isCounterKind,
  type CounterKind,
  type CounterReading,
  type TodoCounter,
} from '@shared/todos/model'
import { newId } from '../lib/id'
import { addDays, eachDay } from './stats'

/** One row of `todos_counters`, as the reads that own it bind against it. */
interface CounterRow {
  id: string
  title: string
  kind: string
  icon: string | null
  color: string | null
  goal: number | null
  running_since: number | null
  created_at: number
  updated_at: number
}

/** One row of `todos_counter_ticks`, with the habit it belongs to still named on it. */
interface TickRow {
  counter_id: string
  day: string
  amount: number | null
}

/** How many habits one account holds. */
interface CounterTallyRow {
  n: number | null
}

/**
 * The row the database holds, as the shape every surface speaks.
 *
 * `kind` is checked rather than cast, for the reason `toTimeEntry` checks its source: a row written by a
 * hand-edited restore can name anything, and a habit of an unknown kind is drawn as the kind that needs
 * no timer rather than breaking the screen that lists it.
 */
function toCounter(row: CounterRow): TodoCounter {
  const kind: CounterKind = isCounterKind(row.kind) ? row.kind : 'clicks'
  return {
    id: row.id,
    title: row.title,
    kind,
    icon: row.icon,
    color: row.color,
    goal: row.goal,
    runningSince: row.running_since,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** The whole list, oldest habit first, and never re-shuffled by editing one. */
export async function listCounters(db: D1Database, userId: string): Promise<TodoCounter[]> {
  const { results } = await db
    .prepare(`SELECT * FROM todos_counters WHERE user_id = ?1 ORDER BY created_at ASC, id ASC`)
    .bind(userId)
    .all<CounterRow>()
  return (results ?? []).map(toCounter)
}

/** One habit by id, scoped to the account, so another account's id reads as a missing one. */
export async function getCounter(db: D1Database, userId: string, id: string): Promise<TodoCounter | null> {
  const row = await db
    .prepare(`SELECT * FROM todos_counters WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, id)
    .first<CounterRow>()
  return row ? toCounter(row) : null
}

/**
 * Creates a habit, or says the account is already full.
 *
 * The ceiling is counted here rather than taken on trust from the caller: forty habits is past what the
 * screen can read, and the count costs one query on a table this small.
 */
export async function createCounter(
  db: D1Database,
  userId: string,
  input: { title: string, kind: CounterKind, icon?: string | null, color?: string | null, goal?: number | null },
): Promise<TodoCounter | null> {
  const tally = await db
    .prepare(`SELECT COUNT(*) AS n FROM todos_counters WHERE user_id = ?1`)
    .bind(userId)
    .first<CounterTallyRow>()
  if (Number(tally?.n ?? 0) >= MAX_COUNTERS_PER_ACCOUNT) return null
  const id = newId()
  const at = Date.now()
  await db
    .prepare(
      `INSERT INTO todos_counters (user_id, id, title, kind, icon, color, goal, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
    )
    .bind(
      userId,
      id,
      input.title,
      input.kind,
      input.icon ?? null,
      input.color ?? defaultColorFor(input.title),
      input.goal ?? null,
      at,
    )
    .run()
  const created = await getCounter(db, userId, id)
  if (!created) throw new Error(`The habit ${id} was written but could not be read back.`)
  return created
}

/**
 * What a PATCH may change.
 *
 * The kind is one of them, and changing it re-labels the days already filed: an amount is a whole number
 * in whatever unit the habit speaks now, so a stopwatch turned into a counter is read as taps. That is the
 * reader's own decision to make, which is why the screen says it out loud instead of refusing.
 */
export interface CounterPatch {
  title?: string
  kind?: CounterKind
  icon?: string | null
  color?: string | null
  goal?: number | null
}

/**
 * Changes one habit, and returns null when the account holds no habit with that id.
 *
 * One statement, with each field's placeholder numbered as its value is pushed onto the bind list, so a
 * field cannot gain a clause without its bind — the reason the store's `Query` builds its WHERE list one
 * value at a time.
 */
export async function updateCounter(
  db: D1Database,
  userId: string,
  id: string,
  patch: CounterPatch,
): Promise<TodoCounter | null> {
  if (!await getCounter(db, userId, id)) return null
  const fields: (readonly [string, unknown])[] = []
  if (patch.title !== undefined) fields.push(['title', patch.title])
  if (patch.kind !== undefined) fields.push(['kind', patch.kind])
  if (patch.icon !== undefined) fields.push(['icon', patch.icon])
  if (patch.color !== undefined) fields.push(['color', patch.color])
  if (patch.goal !== undefined) fields.push(['goal', patch.goal])
  if (!fields.length) return await getCounter(db, userId, id)
  const sets: string[] = []
  const binds: unknown[] = [userId, id]
  for (const [column, value] of fields) {
    sets.push(`${column} = ?${binds.length + 1}`)
    binds.push(value)
  }
  sets.push(`updated_at = ?${binds.length + 1}`)
  binds.push(Date.now())
  await db
    .prepare(`UPDATE todos_counters SET ${sets.join(', ')} WHERE user_id = ?1 AND id = ?2`)
    .bind(...binds)
    .run()
  return await getCounter(db, userId, id)
}

/**
 * Deletes a habit and every day that counts toward it.
 *
 * The days go in the same batch as the habit, in this order: a day belonging to a habit nobody can name
 * is not history but a leak no later read reaches, and §4.5 counts one left-behind child table as a leak
 * forever.
 */
export async function deleteCounter(db: D1Database, userId: string, id: string): Promise<boolean> {
  if (!await getCounter(db, userId, id)) return false
  await db.batch([
    db.prepare(`DELETE FROM todos_counter_ticks WHERE user_id = ?1 AND counter_id = ?2`).bind(userId, id),
    db.prepare(`DELETE FROM todos_counters WHERE user_id = ?1 AND id = ?2`).bind(userId, id),
  ])
  return true
}

/**
 * Adds to — or takes away from — one habit's day.
 *
 * Both rules that make a tap safe to press twice on a bad line live in the statement rather than in what
 * the client believed: the day's total is clamped into `0..MAX_COUNTER_DAY_AMOUNT` by the database, and a
 * total that lands back on zero is removed instead of kept, so undoing the last tap leaves no row and an
 * untouched day keeps reading as a day nobody did rather than as a day with a record in it.
 */
export async function addCounterTick(
  db: D1Database,
  userId: string,
  counterId: string,
  day: string,
  delta: number,
): Promise<void> {
  await db.batch([
    db.prepare(
      `INSERT INTO todos_counter_ticks (user_id, counter_id, day, amount)
       VALUES (?1, ?2, ?3, MAX(0, MIN(?4, ?5)))
       ON CONFLICT(user_id, counter_id, day) DO UPDATE
         SET amount = MAX(0, MIN(?5, todos_counter_ticks.amount + ?4))`,
    ).bind(userId, counterId, day, delta, MAX_COUNTER_DAY_AMOUNT),
    db
      .prepare(`DELETE FROM todos_counter_ticks WHERE user_id = ?1 AND counter_id = ?2 AND day = ?3 AND amount <= 0`)
      .bind(userId, counterId, day),
  ])
}

/**
 * Starts a habit's own stopwatch.
 *
 * Pressing start while one is already running neither begins a second timer nor fails: the run that is
 * going is the answer, so the row comes back as it stands — which is also what makes a start replayed
 * after a dropped response do nothing at all.
 */
export async function startCounterTimer(
  db: D1Database,
  userId: string,
  id: string,
  at: number,
): Promise<TodoCounter | null> {
  const existing = await getCounter(db, userId, id)
  if (!existing) return null
  if (existing.runningSince !== null) return existing
  await db
    .prepare(`UPDATE todos_counters SET running_since = ?3, updated_at = ?3 WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, id, at)
    .run()
  return await getCounter(db, userId, id)
}

/**
 * Claims a habit's open run, and says whether this call won it.
 *
 * The stamp is cleared only while it still holds the instant this call read, which is what makes two
 * screens pressing Stop against one run add the seconds once: the winner is told to write them, the loser
 * is told there was nothing left to write, and neither of them is trusting what it read a moment ago.
 */
export async function claimCounterTimer(
  db: D1Database,
  userId: string,
  id: string,
  startedAt: number,
  now: number,
): Promise<boolean> {
  const cleared = await db
    .prepare(
      `UPDATE todos_counters SET running_since = NULL, updated_at = ?4
        WHERE user_id = ?1 AND id = ?2 AND running_since = ?3`,
    )
    .bind(userId, id, startedAt, now)
    .run()
  return Boolean(cleared.meta?.changes)
}

/**
 * Stops a habit's stopwatch and files what it ran onto one day.
 *
 * Two statements, and the claim between them carries the answer. Reading the instant from the row rather
 * than from the request is what keeps a slow device's clock out of the ledger, and the claim is what keeps
 * a second tab from filing the same run again beside it.
 *
 * The run lands on the day it began, in the account's zone, for the reason every other day column in this
 * schema is written at the write instead of derived at the read.
 */
export async function stopCounterTimer(
  db: D1Database,
  userId: string,
  id: string,
  now: number,
  timezone: string,
): Promise<TodoCounter | null> {
  const existing = await getCounter(db, userId, id)
  if (!existing || existing.runningSince === null) return existing
  if (!await claimCounterTimer(db, userId, id, existing.runningSince, now)) return await getCounter(db, userId, id)
  const startedAt = existing.runningSince
  // Whole seconds, floored at none: a clock that went backwards between the two calls did not run a
  // negative habit. The day's own ceiling is what catches a timer nobody stopped.
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (seconds > 0) await addCounterTick(db, userId, id, localDate(startedAt, timezone), seconds)
  return await getCounter(db, userId, id)
}

/**
 * Every habit with the days behind it, in one read of the whole window.
 *
 * `today` is the account's own day, named by the caller: the window runs back from it and ends on it, so
 * the screen shades a year and still counts a run from the right day. A habit that holds no row in the
 * window gets one entry of zeroes rather than going missing — a habit with no days is an answer, not an
 * absence, and the caller would otherwise have to know that a missing key means the same as an empty one.
 */
export async function loadCounterReadings(
  db: D1Database,
  userId: string,
  today: string,
  windowDays = COUNTER_WINDOW_DAYS,
): Promise<CounterReading[]> {
  const counters = await listCounters(db, userId)
  if (!counters.length) return []
  const from = addDays(today, -(windowDays - 1))
  const { results } = await db
    .prepare(
      `SELECT counter_id, day, amount FROM todos_counter_ticks
        WHERE user_id = ?1 AND day >= ?2 AND day <= ?3`,
    )
    .bind(userId, from, today)
    .all<TickRow>()
  const held = new Map<string, Map<string, number>>()
  for (const row of results ?? []) {
    const days = held.get(row.counter_id) ?? new Map<string, number>()
    days.set(row.day, Number(row.amount ?? 0))
    held.set(row.counter_id, days)
  }
  const window = eachDay(from, today)
  return counters.map((counter) => ({
    from,
    to: today,
    today,
    days: window.map((day) => ({ day, amount: held.get(counter.id)?.get(day) ?? 0 })),
    counter,
  }))
}

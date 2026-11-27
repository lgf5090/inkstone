import type { Context, Hono } from 'hono'
import { localDate } from '@shared/assistant-time'
import {
  MAX_SINGLE_TIME_ENTRY_MS,
  MAX_TIME_ENTRY_AGE_DAYS,
  MAX_TIMER_START_FUTURE_MS,
} from '@shared/todos/model'
import { AssistantStore } from '../assistant/store'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { MAX_STATS_RANGE_DAYS, addDays, isStatsDay } from '../todos/stats'
import { spendTodoReadBudget } from './todo-budget'

const BODY_LIMIT = JSON_BODY_LIMITS.settings
const DAY_MS = 24 * 60 * 60 * 1000

type Ctx = Context<AppBindings>

function store(c: Ctx): AssistantStore {
  return new AssistantStore(c.env.DB, c.get('userId'), c.env)
}

function requiredId(value: unknown): string {
  if (!isValidId(value)) throw ApiError.notFound('Not found')
  return value
}

/**
 * An instant the ledger may be written at, as the request names it — or a refusal with a reason.
 *
 * The server clock is the final trust boundary (AGENTS.md rule 1), and every guard here refuses
 * out loud rather than clamping (rule 2): a silently trimmed timestamp is a wrong fact the worklog
 * can never distinguish from real overtime. A client clock rebuilt from sleep, set by hand, or filed
 * from a wrong zone can therefore only produce three honest outcomes — a number inside the window,
 * a 400 naming what was wrong, or nothing. The five-minute future tolerance covers the drift the
 * platform admits; the lower bound is the harsher of the account's own birth and a remembered year,
 * because anything older is not a back-fill but a clock nobody set.
 */
function ledgerInstant(c: Ctx, value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw ApiError.badRequest(`${field} must be a millisecond timestamp.`)
  }
  const at = Math.trunc(value)
  const now = Date.now()
  if (at > now + MAX_TIMER_START_FUTURE_MS) {
    throw ApiError.badRequest(`${field} is in the future; the server clock decides when work happened.`)
  }
  const accountCreatedAt = c.get('user')?.createdAt ?? 0
  const floor = Math.max(accountCreatedAt, now - MAX_TIME_ENTRY_AGE_DAYS * DAY_MS)
  if (at < floor) {
    throw ApiError.badRequest(`${field} is before the oldest instant this account may record.`)
  }
  return at
}

function assertStatsSpan(from: string, to: string): void {
  const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1
  if (span > MAX_STATS_RANGE_DAYS) {
    throw ApiError.badRequest(`A statistics range cannot cover more than ${MAX_STATS_RANGE_DAYS} days.`)
  }
}

function timeRange(c: Ctx, timezone: string): { from: string, to: string, group: 'day' | 'task' } {
  const today = localDate(Date.now(), timezone)
  const to = c.req.query('to') || today
  if (!isStatsDay(to)) throw ApiError.badRequest('A time range must end on a date like 2026-01-31.')
  const from = c.req.query('from') || addDays(to, -29)
  if (!isStatsDay(from)) throw ApiError.badRequest('A time range must start on a date like 2026-01-31.')
  if (from > to) throw ApiError.badRequest('A time range cannot start after it ends.')
  assertStatsSpan(from, to)
  const group = c.req.query('group') ?? 'day'
  if (group !== 'day' && group !== 'task') throw ApiError.badRequest('A time group must be day or task.')
  return { from, to, group }
}

export function registerTodoTimeRoutes(routes: Hono<AppBindings>): void {
  routes.get('/time', async (c) => {
    spendTodoReadBudget(c.get('userId'))
    const s = store(c)
    const settings = await s.getSettings()
    const { from, to, group } = timeRange(c, settings.timezone)
    const totals = group === 'day' ? await s.timeByDay(from, to) : await s.timeByTask(from, to)
    return c.json({ from, to, group, totals, totalMs: totals.reduce((total, row) => total + row.ms, 0) })
  })

  routes.get('/:id/time', async (c) => {
    spendTodoReadBudget(c.get('userId'))
    const s = store(c)
    const id = requiredId(c.req.param('id'))
    if (!await s.getTask(id)) throw ApiError.notFound('Task not found')
    return c.json({ entries: await s.listTimeEntries({ taskId: id }) })
  })

  routes.post('/:id/timer/start', async (c) => {
    const s = store(c)
    const id = requiredId(c.req.param('id'))
    const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
    const startAt = body.startAt === undefined ? Date.now() : ledgerInstant(c, body.startAt, 'startAt')
    const entry = await s.openTimeEntry(id, startAt)
    if (!entry) throw ApiError.notFound('Task not found')
    return c.json({ entry })
  })

  routes.post('/:id/timer/stop', async (c) => {
    const s = store(c)
    const id = requiredId(c.req.param('id'))
    const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
    const endAt = body.endAt === undefined ? Date.now() : ledgerInstant(c, body.endAt, 'endAt')
    const entries = await s.closeTimeEntry(id, endAt)
    if (!entries) throw ApiError.notFound('No timer is running for this task.')
    return c.json({ entries })
  })

  routes.post('/:id/time', async (c) => {
    const s = store(c)
    const id = requiredId(c.req.param('id'))
    const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
    const startAt = ledgerInstant(c, body.startAt, 'startAt')
    const endAt = ledgerInstant(c, body.endAt, 'endAt')
    if (endAt - startAt > MAX_SINGLE_TIME_ENTRY_MS) {
      throw ApiError.badRequest(
        `A single time entry cannot be longer than ${MAX_SINGLE_TIME_ENTRY_MS / 3_600_000} hours — add it in shorter spans.`,
      )
    }
    const entries = await s.addManualTime(id, startAt, endAt)
    if (!entries) throw ApiError.notFound('Task not found')
    return c.json({ entries }, 201)
  })

  routes.delete('/time/:entryId', async (c) => {
    const removed = await store(c).removeTimeEntry(requiredId(c.req.param('entryId')))
    if (!removed) throw ApiError.notFound('Time entry not found')
    return c.json({ deleted: true })
  })
}

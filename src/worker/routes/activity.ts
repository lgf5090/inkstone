/**
 * The activity heatmap endpoint: one year of per-day counts, filtered by kind.
 *
 * The route only validates and shapes. Everything that decides which rows count lives in
 * `activity/heatmap.ts`, next to the queries, so the day a note is filed under is the same answer the
 * dashboard shows and the tests can call the aggregation on its own.
 *
 * The window is capped at 366 days because the client draws fifty-three columns and because the UTC
 * offset is taken once for the whole window; asking for three years would be a different endpoint
 * with a different answer about daylight saving.
 */

import { Hono } from 'hono'
import {
  ACTIVITY_KINDS,
  HEATMAP_MAX_DAYS,
  daysBetween,
  heatmapWindow,
  isActivityKind,
  parseHeatmapKinds,
  type ActivityKind,
} from '@shared/activity/heatmap'
import { localDate } from '@shared/assistant-time'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { createMinuteBudget } from '../lib/rate-limit'
import { requireAuth } from '../middleware/auth'
import { AssistantStore } from '../assistant/store'
import { heatmapCountsCached } from '../activity/heatmap'

/** Two reads a minute is already more than the grid asks for; a scripted loop is not a reader. */
const readBudget = createMinuteBudget(60, 'Too many activity reads. Try again in a minute.')

export const activityRoutes = new Hono<AppBindings>()

activityRoutes.use('*', requireAuth)

activityRoutes.get('/heatmap', async (c) => {
  readBudget(c.get('userId'))
  const settings = await new AssistantStore(c.env.DB, c.get('userId'), c.env).getSettings()
  const timeZone = settings.timezone
  const today = localDate(Date.now(), timeZone)
  const to = c.req.query('to') ?? today
  const from = c.req.query('from') ?? `${to.slice(0, 4)}-01-01`
  const window = heatmapWindow(from, to)
  if (!window) {
    throw ApiError.badRequest(
      `from and to must be real days, from must not be after to, and the window may not exceed ${HEATMAP_MAX_DAYS} days`,
    )
  }
  const kinds = parseHeatmapKinds(c.req.query('kinds'))
  if (!kinds) throw ApiError.badRequest(`kinds must be a comma-separated subset of ${ACTIVITY_KINDS.join(', ')}`)

  const days = await heatmapCountsCached(c.env.DB, {
    userId: c.get('userId'),
    kinds,
    from: window.from,
    to: window.to,
    timeZone,
  })
  const totals = ACTIVITY_KINDS.reduce<Record<ActivityKind, number>>((sum, kind) => {
    sum[kind] = 0
    return sum
  }, {} as Record<ActivityKind, number>)
  for (const day of days) {
    for (const [kind, total] of Object.entries(day.counts)) {
      if (isActivityKind(kind)) totals[kind] += total ?? 0
    }
  }
  return c.json({
    from: window.from,
    to: window.to,
    kinds,
    days,
    totals,
    // Named so a client can say which zone the buckets were cut in rather than assuming its own.
    timeZone,
    span: daysBetween(window.from, window.to) + 1,
  })
})

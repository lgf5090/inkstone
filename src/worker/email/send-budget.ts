import { EMAIL_SEND_RATE_LIMIT_DAY, EMAIL_SEND_RATE_LIMIT_HOUR } from '@shared/email/model'
import { ApiError } from '../lib/errors'
import { acquireLease } from '../lib/lease'
import type { Env } from '../env'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const LEASE_MS = 5_000

export async function reserveEmailSendBudget(env: Env, userId: string, now = Date.now()): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    let release: Awaited<ReturnType<typeof acquireLease>> | null = null
    try {
      release = await acquireLease(env.DB, `email_send_budget:${userId}`, LEASE_MS, 'Email sending is busy; try again in a moment')
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)))
        continue
      }
      throw error
    }
    try {
      const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS
      const dayStart = Math.floor(now / DAY_MS) * DAY_MS
      const { results } = await env.DB.prepare(
        `SELECT bucket, window_start, count FROM email_send_budget WHERE user_id = ?1 AND bucket IN ('hour', 'day')`,
      ).bind(userId).all<{ bucket: string; window_start: number; count: number }>()
      const counts = new Map(results.map((row) => [row.bucket, row]))
      const hourCount = counts.get('hour')?.window_start === hourStart ? Number(counts.get('hour')!.count) : 0
      const dayCount = counts.get('day')?.window_start === dayStart ? Number(counts.get('day')!.count) : 0
      if (hourCount >= EMAIL_SEND_RATE_LIMIT_HOUR) {
        return `Rate limit exceeded: max ${EMAIL_SEND_RATE_LIMIT_HOUR} emails per hour per user`
      }
      if (dayCount >= EMAIL_SEND_RATE_LIMIT_DAY) {
        return `Rate limit exceeded: max ${EMAIL_SEND_RATE_LIMIT_DAY} emails per day per user`
      }
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO email_send_budget (user_id, bucket, window_start, count) VALUES (?1, 'hour', ?2, 1)
           ON CONFLICT(user_id, bucket) DO UPDATE SET count = CASE WHEN email_send_budget.window_start = excluded.window_start THEN email_send_budget.count + 1 ELSE 1 END, window_start = excluded.window_start`,
        ).bind(userId, hourStart),
        env.DB.prepare(
          `INSERT INTO email_send_budget (user_id, bucket, window_start, count) VALUES (?1, 'day', ?2, 1)
           ON CONFLICT(user_id, bucket) DO UPDATE SET count = CASE WHEN email_send_budget.window_start = excluded.window_start THEN email_send_budget.count + 1 ELSE 1 END, window_start = excluded.window_start`,
        ).bind(userId, dayStart),
        env.DB.prepare(`DELETE FROM email_send_budget WHERE user_id = ?1 AND window_start < ?2`).bind(userId, dayStart),
      ])
      return null
    } finally {
      await release()
    }
  }
  throw new ApiError(409, 'conflict', 'Email sending is busy; try again in a moment')
}

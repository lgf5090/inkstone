/**
 * The hourly sweep: who is due, who has already been told, and what actually went out.
 *
 * It runs on every cron fire rather than once an hour, because the deployment fires every minute and a
 * reminder that waits for the next hour is a reminder that arrives up to fifty-nine minutes late.
 * Repeating the sweep is safe for one reason only: a delivery is recorded against the reader's own
 * local hour before it is sent, so the fires that follow find it already claimed and do nothing. That
 * claim is also what gives an "every N hours after expiry" rule its interval — the last claim is the last
 * delivery, and a rule that asked for twelve hours is not due after one.
 *
 * Each account is swept inside its own try, so one broken configuration cannot stop the others, and the
 * per-account log row is written even when the sweep throws: a reader whose reminders stopped needs to
 * find a line saying why.
 */
import type { ReminderRule, SubscriptionItem, SubscriptionSettings } from '@shared/subscriptions/model'
import { hourIsOpen } from '@shared/subscriptions/model'
import { shouldFire } from '@shared/subscriptions/reminder-engine'
import { MS_PER_HOUR, getDaysBetween, getNowInTimezone, localHourKey } from '@shared/subscriptions/time'
import type { Env } from '../env'
import { dispatch } from './channels'
import { buildNotificationBody, subjectOf, type NotifySubject } from './notify-content'
import { writeNotifyLog, writeScheduleLog } from './logs'
import { enabledChannels, loadSettings } from './settings'
import { SubscriptionsStore, type StoreContext } from './store'

export interface SweepResult {
  accounts: number
  renewed: number
  matched: number
  deduped: number
  sent: number
  failed: number
}

interface Candidate {
  item: SubscriptionItem
  rule: ReminderRule
  daysRemaining: number
  hoursRemaining: number
}

export async function sweepSubscriptions(env: Env, now = Date.now()): Promise<SweepResult> {
  const result: SweepResult = { accounts: 0, renewed: 0, matched: 0, deduped: 0, sent: 0, failed: 0 }
  const { results } = await env.DB.prepare(`SELECT DISTINCT user_id FROM sub_item`).all<{ user_id: string }>()
  for (const row of results) {
    result.accounts++
    try {
      const tally = await sweepAccount(env, row.user_id, now)
      result.renewed += tally.renewed
      result.matched += tally.matched
      result.deduped += tally.deduped
      result.sent += tally.sent
      result.failed += tally.failed
    } catch (error) {
      await writeScheduleLog(env.DB, row.user_id, {
        startedAt: now,
        finishedAt: Date.now(),
        timezone: 'UTC',
        hour: '00',
        hours: [],
        inWindow: false,
        checkedCount: 0,
        matchedCount: 0,
        dedupedCount: 0,
        sentCount: 0,
        renewedCount: 0,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
        detail: error instanceof Error ? error.stack ?? '' : '',
      })
    }
  }
  return result
}

interface AccountTally {
  renewed: number
  matched: number
  deduped: number
  sent: number
  failed: number
}

async function sweepAccount(env: Env, userId: string, now: number): Promise<AccountTally> {
  const settings = await loadSettings(env.DB, userId)
  const store = new SubscriptionsStore(env.DB, userId)
  const context: StoreContext = { timezone: settings.timezone, paymentLimit: settings.paymentHistoryLimit, now }

  const items = await store.list(context)
  let renewed = 0
  const current: SubscriptionItem[] = []
  for (const item of items) {
    if (item.isActive && item.autoRenew && item.daysRemaining < 0) {
      const next = await store.autoRenew(item.id, context)
      if (next) {
        renewed++
        current.push(next)
        continue
      }
    }
    current.push(item)
  }

  const rules = await store.allRules()
  const lastFires = await recentFireTimes(env.DB, userId)
  const nowDate = new Date(now)
  const nowIso = nowDate.toISOString()
  const clock = getNowInTimezone(settings.timezone, nowDate)

  let checked = 0
  let matched = 0
  const candidates: Candidate[] = []
  for (const item of current) {
    if (!item.isActive) continue
    checked++
    const expiry = Date.parse(item.expiryDate)
    if (!Number.isFinite(expiry)) continue
    const daysDiff = getDaysBetween(now, expiry, settings.timezone)
    const hoursDiff = (expiry - now) / MS_PER_HOUR
    for (const rule of rules.get(item.id) ?? []) {
      const lastFireAt = lastFires.get(`${item.id}:${rule.id}`)
      const decision = shouldFire(rule, {
        daysDiff,
        hoursDiff,
        lastFireAt: lastFireAt === undefined ? null : new Date(lastFireAt).toISOString(),
        nowIso,
      })
      if (!decision.fire) continue
      matched++
      candidates.push({ item, rule, daysRemaining: daysDiff, hoursRemaining: hoursDiff })
    }
  }

  const base = {
    startedAt: now,
    finishedAt: Date.now(),
    timezone: settings.timezone,
    hour: clock.hourString,
    hours: settings.notificationHours,
    checkedCount: checked,
    renewedCount: renewed,
  }

  if (!hourIsOpen(settings.notificationHours, clock.hourString)) {
    await writeScheduleLog(env.DB, userId, {
      ...base,
      finishedAt: Date.now(),
      inWindow: false,
      matchedCount: matched,
      dedupedCount: 0,
      sentCount: 0,
      status: 'skipped',
      reason: `Hour ${clock.hourString} is outside the notification window`,
      detail: '',
    })
    return { renewed, matched, deduped: 0, sent: 0, failed: 0 }
  }

  const hourKey = localHourKey(settings.timezone, nowDate)
  const ready: Candidate[] = []
  let deduped = 0
  for (const candidate of candidates) {
    const claimed = await claim(env.DB, userId, candidate, hourKey, now)
    if (claimed) ready.push(candidate)
    else deduped++
  }

  if (ready.length === 0) {
    await writeScheduleLog(env.DB, userId, {
      ...base,
      finishedAt: Date.now(),
      inWindow: true,
      matchedCount: matched,
      dedupedCount: deduped,
      sentCount: 0,
      status: 'skipped',
      reason: matched > 0
        ? `Matched ${matched} rule(s), all already claimed in this hour`
        : 'No reminder rule came due this hour',
      detail: '',
    })
    return { renewed, matched, deduped, sent: 0, failed: 0 }
  }

  ready.sort((left, right) => left.daysRemaining - right.daysRemaining)
  const subjects: NotifySubject[] = ready.map((candidate) => subjectOf(
    candidate.item,
    candidate.daysRemaining,
    candidate.hoursRemaining,
    {
      type: candidate.rule.type,
      value: candidate.rule.value,
      unit: candidate.rule.unit,
      repeatInterval: candidate.rule.repeatInterval,
    },
  ))
  const body = buildNotificationBody(subjects, settings, now)
  const channels = await enabledChannels(env, env.DB, userId)
  const primary = ready[0]!

  if (channels.length === 0) {
    await writeScheduleLog(env.DB, userId, {
      ...base,
      finishedAt: Date.now(),
      inWindow: true,
      matchedCount: matched,
      dedupedCount: deduped,
      sentCount: 0,
      status: 'ok',
      reason: 'No notification channel is enabled',
      detail: describeCandidates(ready),
    })
    return { renewed, matched, deduped, sent: 0, failed: 0 }
  }

  const delivered = await dispatch(
    {
      title: body.title,
      content: body.content,
      metadata: {
        tags: ready.map((candidate) => candidate.item.name),
        daysRemaining: primary.daysRemaining,
        ruleType: primary.rule.type,
        ruleValue: primary.rule.value,
      },
    },
    channels,
    { timezone: settings.timezone, locale: settings.locale, now },
  )

  for (const outcome of delivered.results) {
    await writeNotifyLog(env.DB, userId, {
      subscriptionId: primary.item.id,
      ruleId: primary.rule.id,
      channel: outcome.channel,
      status: outcome.success ? 'success' : 'failed',
      title: body.title,
      body: body.content,
      error: outcome.error ?? '',
      detail: outcome.detail ?? '',
    })
  }

  await writeScheduleLog(env.DB, userId, {
    ...base,
    finishedAt: Date.now(),
    inWindow: true,
    matchedCount: matched,
    dedupedCount: deduped,
    sentCount: delivered.successCount,
    status: delivered.failedCount > 0 && delivered.successCount === 0 ? 'error' : 'ok',
    reason: delivered.attempted > 0
      ? `Sent to ${delivered.attempted} channel(s): ${delivered.successCount} succeeded, ${delivered.failedCount} failed`
      : 'No notification channel is enabled',
    detail: `${describeCandidates(ready)}\n${JSON.stringify(delivered.results.map((outcome) => ({ channel: outcome.channel, ok: outcome.success, error: outcome.error ?? '' })))}`,
  })

  return { renewed, matched, deduped, sent: delivered.successCount, failed: delivered.failedCount }
}

/**
 * Claim one delivery for this hour.
 *
 * The insert is the lock: `INSERT OR IGNORE` on a primary key of (account, subscription, rule, hour)
 * either takes the row or finds it taken, and the answer is the same across two isolates racing on the
 * same tick. A read followed by a write would let both see nothing and both send.
 */
async function claim(db: D1Database, userId: string, candidate: Candidate, hourKey: string, now: number): Promise<boolean> {
  const result = await db.prepare(
    `INSERT OR IGNORE INTO sub_notify_dedupe (user_id, subscription_id, rule_id, hour_key, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(userId, candidate.item.id, candidate.rule.id, hourKey, now).run()
  return (result.meta.changes ?? 0) > 0
}

async function recentFireTimes(db: D1Database, userId: string): Promise<Map<string, number>> {
  const { results } = await db.prepare(
    `SELECT subscription_id, rule_id, MAX(created_at) AS last
       FROM sub_notify_dedupe WHERE user_id = ?1 GROUP BY subscription_id, rule_id`,
  ).bind(userId).all<{ subscription_id: string; rule_id: string; last: number }>()
  return new Map(results.map((row) => [`${row.subscription_id}:${row.rule_id}`, row.last]))
}

function describeCandidates(ready: readonly Candidate[]): string {
  return JSON.stringify(ready.map((candidate) => ({
    subscriptionId: candidate.item.id,
    name: candidate.item.name,
    ruleId: candidate.rule.id,
    ruleType: candidate.rule.type,
    ruleValue: candidate.rule.value,
    daysRemaining: candidate.daysRemaining,
  })))
}

/** The settings a caller needs to explain a schedule, exposed for the diagnostics panel. */
export function describeWindow(settings: SubscriptionSettings, now = Date.now()): { hour: string; open: boolean } {
  const clock = getNowInTimezone(settings.timezone, new Date(now))
  return { hour: clock.hourString, open: hourIsOpen(settings.notificationHours, clock.hourString) }
}

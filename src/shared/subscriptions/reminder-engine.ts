/**
 * Whether a rule fires on this tick, and when it will next fire.
 *
 * Both answers are pure functions of a rule, the distance to expiry, and the last time the rule fired.
 * That is deliberate: the scheduler that calls them touches the database and the network, and a rule
 * whose arithmetic lived inside it could only be tested by standing up all of that. The reference
 * project made the same split, and its reason strings are kept — they are what a schedule log line
 * quotes when it explains why nothing was sent.
 *
 * The three kinds mean what their names say, with one wrinkle worth knowing: a `before_expiry` rule
 * matches a *specific* distance rather than a range, so 7 means "on the day seven days out", not "every
 * day from now until a week before". That is what makes four rules cover a fortnight without repeating.
 */
import type { ReminderRule, ReminderUnit } from './model'

export interface FireContext {
  /** Whole days to expiry, counted between local midnights. Negative once expired. */
  daysDiff: number
  /** Hours to expiry, fractional. Negative once expired. */
  hoursDiff: number
  /** When this same rule last fired, for the repeat interval of an expired subscription. */
  lastFireAt?: string | null
  nowIso?: string
}

export interface FireDecision {
  fire: boolean
  reason: string
}

/** The default repeat interval of an `after_expiry` rule that names none: once a day. */
export const DEFAULT_REPEAT_HOURS = 24

export function shouldFire(rule: ReminderRule, ctx: FireContext): FireDecision {
  if (!rule || rule.isEnabled === false) return { fire: false, reason: 'rule_disabled' }
  if (!Number.isFinite(ctx.daysDiff) || !Number.isFinite(ctx.hoursDiff)) {
    return { fire: false, reason: 'invalid_diff' }
  }
  if (rule.type === 'before_expiry') return decideBeforeExpiry(rule, ctx)
  if (rule.type === 'on_expiry') return decideOnExpiry(ctx)
  if (rule.type === 'after_expiry') return decideAfterExpiry(rule, ctx)
  return { fire: false, reason: 'unknown_rule_type' }
}

function decideBeforeExpiry(rule: ReminderRule, ctx: FireContext): FireDecision {
  if (rule.unit === 'hours') {
    if (rule.value === 0) {
      return ctx.hoursDiff >= 0 && ctx.hoursDiff < 1
        ? { fire: true, reason: 'within_hour' }
        : { fire: false, reason: 'not_within_hour' }
    }
    if (ctx.hoursDiff < 0) return { fire: false, reason: 'already_expired' }
    return Math.round(ctx.hoursDiff) === rule.value
      ? { fire: true, reason: `hours_diff_eq_${rule.value}` }
      : { fire: false, reason: `hours_diff=${ctx.hoursDiff}_not_match_${rule.value}` }
  }
  if (rule.value === 0) {
    return ctx.daysDiff === 0
      ? { fire: true, reason: 'days_diff_zero' }
      : { fire: false, reason: `days_diff=${ctx.daysDiff}_not_zero` }
  }
  return ctx.daysDiff === rule.value
    ? { fire: true, reason: `days_diff_eq_${rule.value}` }
    : { fire: false, reason: `days_diff=${ctx.daysDiff}_not_match_${rule.value}` }
}

function decideOnExpiry(ctx: FireContext): FireDecision {
  return ctx.daysDiff === 0
    ? { fire: true, reason: 'on_expiry_day' }
    : { fire: false, reason: `days_diff=${ctx.daysDiff}_not_today` }
}

function decideAfterExpiry(rule: ReminderRule, ctx: FireContext): FireDecision {
  if (ctx.daysDiff >= 0) return { fire: false, reason: 'not_expired_yet' }
  const interval = repeatHours(rule)
  if (!ctx.lastFireAt) return { fire: true, reason: 'after_expiry_first_fire' }
  const last = new Date(ctx.lastFireAt).getTime()
  const now = ctx.nowIso ? new Date(ctx.nowIso).getTime() : Date.now()
  if (Number.isNaN(last) || Number.isNaN(now)) return { fire: true, reason: 'invalid_last_fire_assume_due' }
  const elapsedHours = (now - last) / 3_600_000
  return elapsedHours >= interval
    ? { fire: true, reason: `after_expiry_interval_${interval}h_elapsed` }
    : { fire: false, reason: `after_expiry_within_${interval}h_window` }
}

function repeatHours(rule: ReminderRule): number {
  const interval = Number(rule.repeatInterval)
  return Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_REPEAT_HOURS
}

/**
 * The next moment this rule would fire, or null when it never will again.
 *
 * Used by the detail panel's "next reminder" line, so it has to agree with `shouldFire` rather than be
 * a second opinion: both read the same interval default, and both treat a past moment as "nothing more".
 */
export function getNextFireTime(rule: ReminderRule, expiryIso: string, nowIso?: string): string | null {
  if (!rule || rule.isEnabled === false) return null
  const expiry = new Date(expiryIso).getTime()
  const now = nowIso ? new Date(nowIso).getTime() : Date.now()
  if (Number.isNaN(expiry)) return null
  const hour = 3_600_000
  const day = 86_400_000

  if (rule.type === 'before_expiry') {
    const fireAt = rule.unit === 'hours' ? expiry - rule.value * hour : expiry - rule.value * day
    return fireAt >= now ? new Date(fireAt).toISOString() : null
  }
  if (rule.type === 'on_expiry') {
    return expiry >= now ? new Date(expiry).toISOString() : null
  }
  if (rule.type === 'after_expiry') {
    if (now < expiry) return new Date(expiry).toISOString()
    const interval = repeatHours(rule)
    const periods = Math.ceil((now - expiry) / (interval * hour))
    return new Date(expiry + periods * interval * hour).toISOString()
  }
  return null
}

/** The soonest upcoming fire across every rule, with the rule that owns it. */
export function soonestFire(
  rules: readonly ReminderRule[],
  expiryIso: string,
  nowIso?: string,
): { ruleId: string; type: ReminderRule['type']; value: number; unit: ReminderUnit; nextFireTime: string } | null {
  const candidates = rules
    .map((rule) => ({ rule, at: getNextFireTime(rule, expiryIso, nowIso) }))
    .filter((entry): entry is { rule: ReminderRule; at: string } => entry.at !== null)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
  const first = candidates[0]
  if (!first) return null
  return {
    ruleId: first.rule.id,
    type: first.rule.type,
    value: first.rule.value,
    unit: first.rule.unit,
    nextFireTime: first.at,
  }
}

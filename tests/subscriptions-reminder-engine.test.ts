import { describe, expect, it } from 'vitest'
import { getNextFireTime, shouldFire, soonestFire } from '../src/shared/subscriptions/reminder-engine'
import type { ReminderRule } from '../src/shared/subscriptions/model'

const EXPIRY = '2026-06-01T00:00:00.000Z'
const NOW = '2026-05-24T00:00:00.000Z'

function rule(overrides: Partial<ReminderRule> = {}): ReminderRule {
  return {
    id: 'rule-1',
    type: 'before_expiry',
    value: 7,
    unit: 'days',
    repeatInterval: null,
    repeatUntil: 'renewed',
    acknowledgedAt: null,
    isEnabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('before expiry', () => {
  it('fires exactly on the named day, not inside a range', () => {
    expect(shouldFire(rule(), { daysDiff: 7, hoursDiff: 168 }).fire).toBe(true)
    expect(shouldFire(rule(), { daysDiff: 6, hoursDiff: 144 }).fire).toBe(false)
    expect(shouldFire(rule(), { daysDiff: 8, hoursDiff: 192 }).fire).toBe(false)
  })

  it('treats zero days as the expiry day itself', () => {
    expect(shouldFire(rule({ value: 0 }), { daysDiff: 0, hoursDiff: 3 }).fire).toBe(true)
    expect(shouldFire(rule({ value: 0 }), { daysDiff: 1, hoursDiff: 30 }).fire).toBe(false)
  })

  it('matches the hour for an hourly rule', () => {
    const hourly = rule({ unit: 'hours', value: 12 })
    expect(shouldFire(hourly, { daysDiff: 1, hoursDiff: 12.2 }).fire).toBe(true)
    expect(shouldFire(hourly, { daysDiff: 0, hoursDiff: 11 }).fire).toBe(false)
    expect(shouldFire(hourly, { daysDiff: -1, hoursDiff: -2 }).reason).toBe('already_expired')
  })

  it('fires within the final hour when the rule names zero hours', () => {
    const hourly = rule({ unit: 'hours', value: 0 })
    expect(shouldFire(hourly, { daysDiff: 0, hoursDiff: 0.4 }).fire).toBe(true)
    expect(shouldFire(hourly, { daysDiff: 0, hoursDiff: 1.5 }).fire).toBe(false)
  })
})

describe('on expiry', () => {
  it('fires only on the day', () => {
    const onExpiry = rule({ type: 'on_expiry', value: 0 })
    expect(shouldFire(onExpiry, { daysDiff: 0, hoursDiff: 0 }).fire).toBe(true)
    expect(shouldFire(onExpiry, { daysDiff: 1, hoursDiff: 5 }).fire).toBe(false)
  })
})

describe('after expiry', () => {
  const after = rule({ type: 'after_expiry', value: 0, repeatInterval: 12 })

  it('does not fire before the expiry date', () => {
    expect(shouldFire(after, { daysDiff: 0, hoursDiff: 0 }).reason).toBe('not_expired_yet')
  })

  it('fires once when it has never fired', () => {
    expect(shouldFire(after, { daysDiff: -1, hoursDiff: -5 }).fire).toBe(true)
  })

  it('waits out its interval', () => {
    const context = { daysDiff: -1, hoursDiff: -30, nowIso: NOW }
    expect(shouldFire(after, { ...context, lastFireAt: '2026-05-24T00:00:00.000Z' }).fire).toBe(false)
    expect(shouldFire(after, { ...context, lastFireAt: '2026-05-23T00:00:00.000Z' }).fire).toBe(true)
  })

  it('falls back to a daily interval when none was set', () => {
    const daily = rule({ type: 'after_expiry', value: 0, repeatInterval: null })
    const context = { daysDiff: -3, hoursDiff: -70, nowIso: NOW }
    expect(shouldFire(daily, { ...context, lastFireAt: '2026-05-23T00:00:00.000Z' }).fire).toBe(true)
    expect(shouldFire(daily, { ...context, lastFireAt: '2026-05-23T20:00:00.000Z' }).fire).toBe(false)
  })
})

describe('refusals', () => {
  it('skips a disabled rule', () => {
    expect(shouldFire(rule({ isEnabled: false }), { daysDiff: 7, hoursDiff: 168 }).reason).toBe('rule_disabled')
  })

  it('skips a rule given a distance it cannot read', () => {
    expect(shouldFire(rule(), { daysDiff: Number.NaN, hoursDiff: 1 }).reason).toBe('invalid_diff')
  })
})

describe('next fire time', () => {
  it('counts back from the expiry date', () => {
    expect(getNextFireTime(rule(), EXPIRY, NOW)).toBe('2026-05-25T00:00:00.000Z')
    expect(getNextFireTime(rule({ unit: 'hours', value: 6 }), EXPIRY, NOW)).toBe('2026-05-31T18:00:00.000Z')
  })

  it('returns nothing once the moment has passed', () => {
    expect(getNextFireTime(rule(), EXPIRY, '2026-06-02T00:00:00.000Z')).toBeNull()
    expect(getNextFireTime(rule({ type: 'on_expiry', value: 0 }), EXPIRY, '2026-06-02T00:00:00.000Z')).toBeNull()
  })

  it('reports the expiry itself for an unexpired subscription', () => {
    expect(getNextFireTime(rule({ type: 'after_expiry' }), EXPIRY, NOW)).toBe(EXPIRY)
  })

  it('lands on the next interval once expired', () => {
    const after = rule({ type: 'after_expiry', repeatInterval: 6 })
    expect(getNextFireTime(after, EXPIRY, '2026-06-01T07:00:00.000Z')).toBe('2026-06-01T12:00:00.000Z')
  })
})

describe('the soonest rule', () => {
  it('picks the earliest of several', () => {
    const soonest = soonestFire([
      rule({ id: 'week', value: 7 }),
      rule({ id: 'day', value: 1 }),
      rule({ id: 'disabled', value: 2, isEnabled: false }),
    ], EXPIRY, NOW)
    expect(soonest?.ruleId).toBe('week')
    expect(soonest?.nextFireTime).toBe('2026-05-25T00:00:00.000Z')
  })

  it('returns nothing when every rule is spent', () => {
    expect(soonestFire([rule()], EXPIRY, '2027-01-01T00:00:00.000Z')).toBeNull()
  })
})

/**
 * `repeat_until` was stored from the first version and consulted by nothing — the reference project had
 * the same dropdown and the same dead field, and its engine header claimed the scheduler filtered on it
 * when the scheduler never did. These are the tests that make the control mean what it says.
 */
describe('acknowledgement', () => {
  const overdue = { daysDiff: -3, hoursDiff: -70, lastFireAt: null, nowIso: '2026-06-04T00:00:00.000Z' }

  it('stops an "until I mark it seen" rule once it has been seen', () => {
    const decision = shouldFire(
      rule({ type: 'after_expiry', repeatInterval: 24, repeatUntil: 'acknowledged', acknowledgedAt: '2026-06-03T00:00:00.000Z' }),
      overdue,
    )
    expect(decision).toEqual({ fire: false, reason: 'acknowledged' })
  })

  it('keeps firing until it is seen', () => {
    expect(shouldFire(rule({ type: 'after_expiry', repeatInterval: 24, repeatUntil: 'acknowledged' }), overdue).fire).toBe(true)
  })

  it('means nothing to a rule that said "until it renews"', () => {
    const decision = shouldFire(
      rule({ type: 'after_expiry', repeatInterval: 24, repeatUntil: 'renewed', acknowledgedAt: '2026-06-03T00:00:00.000Z' }),
      overdue,
    )
    expect(decision.fire).toBe(true)
  })

  it('leaves a not-yet-due rule alone', () => {
    const decision = shouldFire(
      rule({ type: 'before_expiry', value: 7, unit: 'days', acknowledgedAt: '2026-05-20T00:00:00.000Z' }),
      { daysDiff: 7, hoursDiff: 168, nowIso: NOW },
    )
    expect(decision.fire).toBe(true)
  })

  it('promises no next fire once muted', () => {
    const muted = rule({ type: 'after_expiry', repeatInterval: 24, repeatUntil: 'acknowledged', acknowledgedAt: '2026-06-03T00:00:00.000Z' })
    expect(getNextFireTime(muted, EXPIRY, '2026-06-04T00:00:00.000Z')).toBeNull()
    // Before the expiry there is still a first reminder to come, muted or not.
    expect(getNextFireTime(muted, EXPIRY, NOW)).toBe(EXPIRY)
  })
})

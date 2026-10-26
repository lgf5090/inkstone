// @vitest-environment jsdom
/**
 * The day a card prints is the account's day, not the machine's.
 *
 * `dueLabel()` compares the due date against today in the account's zone, and the groups a row is
 * filed under (`groupByPlan`, the calendar's cells, the day-end the server cut the page by) are cut in
 * that zone too. So the *printing* has to answer to the same zone: with the zone left out of the
 * formatter the row is read correctly and printed in the browser's own calendar day, and on an
 * east-eight machine every day-only task arrives wearing the next day — the audit measured seven rows
 * out of seven disagreeing with the calendar cell holding the same task.
 *
 * The cases pin the rule rather than a literal: the printed day is the one the account zone says, it is
 * the same day `localDate()` files the row under, and where the device zone disagrees it is *not* the
 * device's reading — which is the arm that goes red the moment `timeZone` is dropped.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { localDate } from '@shared/assistant-time'
import { getLocale, initI18n, t } from '../../lib/i18n'
import { dueLabel } from './todo-ui'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/**
 * Friday 23 October 2026, one minute before the end of that day in UTC — the shape a due date written
 * as a bare day is stored as. It is the 24th already in Shanghai and still the 23rd in London, which
 * is the distance the row has to get right.
 */
const DUE = Date.parse('2026-10-23T23:59:00Z')
/** A Monday morning that is the 19th in UTC and the 20th in Shanghai. */
const NOW = Date.parse('2026-10-19T20:00:00Z')
const bounds = { dayEnd: NOW + DAY, now: NOW }

const savedZone = process.env.TZ

/** The reading a zone gives of an instant, in the interface language the row is drawn in. */
function dayIn(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat(getLocale(), { month: 'short', day: 'numeric', timeZone }).format(new Date(instant))
}

/**
 * The day a row is *filed under*, printed.
 *
 * `localDate()` is the boundary the groups cut by; rebuilding an instant from the day it returns asks
 * the formatter about that calendar day alone, so the comparison says "the card agrees with the group"
 * without depending on which zone the machine running the test happens to be in.
 */
function dayFiledUnder(instant: number, timeZone: string): string {
  const [year, month, day] = localDate(instant, timeZone).split('-').map(Number)
  return new Intl.DateTimeFormat(getLocale(), { month: 'short', day: 'numeric' }).format(new Date(year, month - 1, day))
}

function labelFor(timeZone: string): string {
  const read = dueLabel(DUE, bounds, timeZone)
  if (!read) throw new Error('a due date read as no date at all')
  return read.text
}

beforeAll(async () => {
  localStorage.clear()
  await initI18n()
})

afterEach(() => {
  if (savedZone === undefined) delete process.env.TZ
  else process.env.TZ = savedZone
})

describe('the day a row prints', () => {
  it('prints the account day when the machine is eight hours ahead of it', () => {
    process.env.TZ = 'Asia/Shanghai'
    expect(labelFor('UTC')).toBe(dayIn(DUE, 'UTC'))
    expect(labelFor('UTC')).toBe(dayFiledUnder(DUE, 'UTC'))
    expect(labelFor('UTC')).not.toBe(dayIn(DUE, 'Asia/Shanghai'))
  })

  it('prints the account day when the machine is behind it', () => {
    process.env.TZ = 'UTC'
    // The same rule read the other way round: the account is not the machine here either.
    expect(labelFor('Asia/Shanghai')).toBe(dayIn(DUE, 'Asia/Shanghai'))
    expect(labelFor('Asia/Shanghai')).toBe(dayFiledUnder(DUE, 'Asia/Shanghai'))
    expect(labelFor('Asia/Shanghai')).not.toBe(dayIn(DUE, 'UTC'))
  })

  it('says today for the account day it is, whichever day the machine is in', () => {
    process.env.TZ = 'UTC'
    // Shanghai's own end of the 20th, which is the 20th in UTC too — but the machine's *today* is the
    // 19th, so a row printed from the device zone would answer with a date instead of with today.
    const shanghaiTonight = Date.parse('2026-10-20T15:59:00Z')
    expect(dueLabel(shanghaiTonight, bounds, 'Asia/Shanghai')?.text).toBe(t('todo.smart.today'))
    expect(dayFiledUnder(shanghaiTonight, 'UTC')).not.toBe(t('todo.smart.today'))
  })

  it('keeps the clock it prints in the same zone as the day', () => {
    process.env.TZ = 'UTC'
    // Half past two on the 20th in UTC is half past ten in Shanghai, the zone the row is read in.
    const thisAfternoon = Date.parse('2026-10-20T02:30:00Z')
    expect(dueLabel(thisAfternoon, bounds, 'Asia/Shanghai')?.text).toBe('10:30')
  })
})

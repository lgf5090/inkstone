/**
 * The account's renewal dates, as a calendar somebody else can subscribe to.
 *
 * The app already tells a reader when a plan is about to charge, but only to a reader who opens the app.
 * A calendar file is the same answer carried into the place a person already looks at every morning, and
 * it costs nothing to keep in step: the events are derived from the rows on every request, so a corrected
 * expiry date is the next fetch.
 *
 * Two rules hold here. The text is what RFC 5545 asks for — CRLF endings, escaped values, long lines
 * folded — because a calendar client that cannot parse one line tends to discard the whole file rather
 * than say so. And nothing personal travels: a plan's notes are the one field a reader may have used for
 * anything, and a subscription URL is a bearer credential that outlives this browser session, so the
 * payload stops at the name, the price and the cycle.
 */
import ICAL from 'ical.js'
import type { ReminderRule, ReminderUnit, SubscriptionItem } from '@shared/subscriptions/model'
import { formatLocalDate } from '@shared/subscriptions/time'

type RecurrenceFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

interface ReminderAlarm {
  value: number
  unit: ReminderUnit
}

export interface ICalEvent {
  /** Stable across fetches, so a client updates the event instead of duplicating it. */
  uid: string
  /** The day something happens, as YYYY-MM-DD. */
  day: string
  title: string
  detail: string
  recurrence?: { frequency: RecurrenceFrequency, interval: number }
  alarms?: readonly ReminderAlarm[]
}

/** ical.js escapes LF but not a lone CR; normalize every newline form before handing it TEXT values. */
function text(value: string): string {
  return value.replace(/\r\n|\r|\u2028|\u2029/g, '\n')
}

/** The day before, as the exclusive end of an all-day event; a whole number of days is what makes it safe. */
function nextDay(day: string): string {
  const stamp = Date.parse(`${day}T00:00:00Z`)
  if (!Number.isFinite(stamp)) return day
  return new Date(stamp + 86_400_000).toISOString().slice(0, 10)
}

const RECURRENCE_FREQUENCIES = {
  day: 'DAILY',
  week: 'WEEKLY',
  month: 'MONTHLY',
  year: 'YEARLY',
} as const

/** One all-day event per plan still running. Stopped and currently paused plans have no date to wait for. */
export function buildEvents(items: readonly SubscriptionItem[], timezone = 'UTC', now = Date.now()): ICalEvent[] {
  const events: ICalEvent[] = []
  for (const item of items) {
    const expiry = Date.parse(item.expiryDate)
    if (!item.isActive || !Number.isFinite(expiry)) continue
    if (item.pausedUntil !== null && Date.parse(item.pausedUntil) > now) continue

    events.push({
      uid: `${item.id}@inkstone.subscriptions`,
      day: formatLocalDate(item.expiryDate, timezone, 'date'),
      title: item.name,
      detail: detailOf(item),
      ...recurrenceOf(item),
      alarms: alarmsFor(item, item.expiryDate, now, 'before_expiry'),
    })

    // A trial ends on its own date, not on the expiry series. Keeping it separate means its alarms are
    // anchored to the right day and disappear after conversion instead of recurring with every renewal.
    if (item.trialEndsAt !== null) {
      const trialAlarms = alarmsFor(item, item.trialEndsAt, now, 'before_trial_end')
      if (trialAlarms.length > 0) {
        events.push({
          uid: `${item.id}-trial@inkstone.subscriptions`,
          day: formatLocalDate(item.trialEndsAt, timezone, 'date'),
          title: item.name,
          detail: detailOf(item),
          alarms: trialAlarms,
        })
      }
    }
  }
  return events
}

function detailOf(item: SubscriptionItem): string {
  return `${item.periodValue} ${item.periodUnit}`
    + (item.amount ? ` · ${item.amount} ${item.currency}` : '')
}

/**
 * Only a solar cycle has a stable RRULE anchor. Reset terms start on the actual payment day, lunar dates
 * need calendar conversion, and fixed/manual plans have no next term to promise.
 */
function recurrenceOf(item: SubscriptionItem): Pick<ICalEvent, 'recurrence'> {
  if (item.useLunar || item.subscriptionMode !== 'cycle' || !item.autoRenew || item.fixedTerm) return {}
  const interval = Math.trunc(item.periodValue)
  if (!Number.isFinite(interval) || interval < 1) return {}
  return { recurrence: { frequency: RECURRENCE_FREQUENCIES[item.periodUnit], interval } }
}

/** Future enabled rules only; duplicate lead times need only one alarm. */
function alarmsFor(item: SubscriptionItem, target: string, now: number, type: ReminderRule['type']): ReminderAlarm[] {
  const targetAt = Date.parse(target)
  if (!Number.isFinite(targetAt)) return []
  const alarms: ReminderAlarm[] = []
  const seen = new Set<string>()
  for (const rule of item.reminderRules ?? []) {
    if (!rule.isEnabled || (rule.type !== type && !(type === 'before_expiry' && rule.type === 'on_expiry'))) continue
    if (!Number.isInteger(rule.value) || rule.value < 0 || (rule.unit !== 'days' && rule.unit !== 'hours')) continue
    const lead = rule.value * (rule.unit === 'hours' ? 3_600_000 : 86_400_000)
    if (targetAt - lead < now) continue
    const key = `${rule.value}${rule.unit}`
    if (seen.has(key)) continue
    seen.add(key)
    alarms.push({ value: rule.value, unit: rule.unit })
  }
  return alarms
}

/**
 * The whole document, ready to serve.
 *
 * `stamp` identifies this generated revision; it is not a renewal date. ical.js owns TEXT escaping,
 * DATE values and UTF-8-safe folding so the feed does not maintain a second, drifting ICS encoder.
 */
export function toICal(events: readonly ICalEvent[], options: { name: string, stamp: number }): string {
  const calendar = new ICAL.Component(['vcalendar', [], []])
  calendar.updatePropertyWithValue('version', '2.0')
  calendar.updatePropertyWithValue('prodid', '-//Inkstone//Subscriptions//EN')
  calendar.updatePropertyWithValue('calscale', 'GREGORIAN')
  calendar.updatePropertyWithValue('method', 'PUBLISH')
  calendar.updatePropertyWithValue('x-wr-calname', text(options.name))
  const stamp = ICAL.Time.fromJSDate(new Date(options.stamp), true)

  for (const event of events) {
    const end = nextDay(event.day)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(event.day) || end === event.day) continue
    const vevent = new ICAL.Component('vevent')
    vevent.updatePropertyWithValue('uid', text(event.uid))
    vevent.updatePropertyWithValue('dtstamp', stamp)
    vevent.updatePropertyWithValue('dtstart', ICAL.Time.fromDateString(event.day))
    vevent.updatePropertyWithValue('dtend', ICAL.Time.fromDateString(end))
    vevent.updatePropertyWithValue('summary', text(event.title))
    vevent.updatePropertyWithValue('description', text(event.detail))
    vevent.updatePropertyWithValue('transp', 'TRANSPARENT')
    if (event.recurrence) {
      vevent.updatePropertyWithValue('rrule', new ICAL.Recur({
        freq: event.recurrence.frequency,
        interval: event.recurrence.interval,
      }))
    }
    for (const alarm of event.alarms ?? []) {
      const trigger = alarmTrigger(alarm)
      if (!trigger) continue
      const valarm = new ICAL.Component('valarm')
      valarm.updatePropertyWithValue('action', 'DISPLAY')
      valarm.updatePropertyWithValue('description', text(event.title))
      // ical.js rejects the widely used zero spelling "0"; the strict values built above are safe jCal.
      valarm.addProperty(new ICAL.Property(['trigger', {}, 'duration', trigger]))
      vevent.addSubcomponent(valarm)
    }
    calendar.addSubcomponent(vevent)
  }

  function alarmTrigger(alarm: ReminderAlarm): string | null {
    if (!Number.isInteger(alarm.value) || alarm.value < 0) return null
    if (alarm.value === 0) return '0'
    return alarm.unit === 'hours' ? `-PT${alarm.value}H` : `-P${alarm.value}D`
  }

  // ical.js counts its continuation marker outside foldLength; 74 keeps every physical line within
  // RFC 5545's 75-octet ceiling. Stringification is synchronous, so the setting cannot leak to a request.
  const previousFoldLength = ICAL.foldLength
  try {
    ICAL.foldLength = 74
    return ICAL.stringify(calendar.jCal)
  } finally {
    ICAL.foldLength = previousFoldLength
  }
}

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
import type { SubscriptionItem } from '@shared/subscriptions/model'
import { formatLocalDate } from '@shared/subscriptions/time'

export interface ICalEvent {
  /** Stable across fetches, so a client updates the event instead of duplicating it. */
  uid: string
  /** The day something happens, as YYYY-MM-DD. */
  day: string
  title: string
  detail: string
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

/** One all-day event per plan still running. A stopped plan has no date the reader is waiting for. */
export function buildEvents(items: readonly SubscriptionItem[], timezone = 'UTC'): ICalEvent[] {
  return items
    .filter((item) => item.isActive)
    .map((item) => ({
      uid: `${item.id}@inkstone.subscriptions`,
      day: formatLocalDate(item.expiryDate, timezone, 'date'),
      title: item.name,
      detail: `${item.periodValue} ${item.periodUnit}`
        + (item.amount ? ` · ${item.amount} ${item.currency}` : ''),
    }))
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
    calendar.addSubcomponent(vevent)
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

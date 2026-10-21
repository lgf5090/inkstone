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
import type { SubscriptionItem } from '@shared/subscriptions/model'

export interface ICalEvent {
  /** Stable across fetches, so a client updates the event instead of duplicating it. */
  uid: string
  /** The day something happens, as YYYY-MM-DD. */
  day: string
  title: string
  detail: string
}

const LINE_LIMIT = 74

/** Escape what the format reserves: a backslash, a semicolon, a comma, and a line break. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/** Fold one content line at the byte limit, continuing with a space as the format requires. */
function fold(line: string): string {
  // Measured in UTF-8 bytes, not characters: the limit is octets, and a plan named in Chinese is over it
  // far sooner than its length suggests.
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= LINE_LIMIT) return line
  const parts: string[] = []
  let current = ''
  for (const char of line) {
    // Re-encode rather than count: a multi-byte character must not be split across two lines.
    if (Buffer.byteLength(current + char, 'utf8') > (parts.length === 0 ? LINE_LIMIT : LINE_LIMIT - 1)) {
      parts.push(current)
      current = char
    } else {
      current += char
    }
  }
  if (current) parts.push(current)
  return parts.join('\r\n ')
}

function line(key: string, value: string): string {
  return fold(`${key}:${value}`)
}

/** The day before, as the exclusive end of an all-day event; a whole number of days is what makes it safe. */
function nextDay(day: string): string {
  const stamp = Date.parse(`${day}T00:00:00Z`)
  if (!Number.isFinite(stamp)) return day
  return new Date(stamp + 86_400_000).toISOString().slice(0, 10)
}

function compact(day: string): string {
  return day.replace(/-/g, '')
}

/** One all-day event per plan still running. A stopped plan has no date the reader is waiting for. */
export function buildEvents(items: readonly SubscriptionItem[]): ICalEvent[] {
  return items
    .filter((item) => item.isActive)
    .map((item) => ({
      uid: `${item.id}@inkstone.subscriptions`,
      day: item.expiryDate.slice(0, 10),
      title: item.name,
      detail: `${item.periodValue} ${item.periodUnit}`
        + (item.amount ? ` · ${item.amount} ${item.currency}` : ''),
    }))
}

/**
 * The whole document, ready to serve.
 *
 * `stamp` is the moment the file was written, not the moment anything renews: a client uses it to decide
 * whether its copy is older, and a fixed value would make every fetch look stale.
 */
export function toICal(events: readonly ICalEvent[], options: { name: string, stamp: number }): string {
  const stamp = new Date(options.stamp).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const out: string[] = [
    line('BEGIN', 'VCALENDAR'),
    line('VERSION', '2.0'),
    line('PRODID', '-//Inkstone//Subscriptions//EN'),
    line('CALSCALE', 'GREGORIAN'),
    line('METHOD', 'PUBLISH'),
    line('X-WR-CALNAME', escapeText(options.name)),
  ]
  for (const event of events) {
    out.push(
      line('BEGIN', 'VEVENT'),
      line('UID', event.uid),
      line('DTSTAMP', stamp),
      line('DTSTART;VALUE=DATE', compact(event.day)),
      line('DTEND;VALUE=DATE', compact(nextDay(event.day))),
      line('SUMMARY', escapeText(event.title)),
      line('DESCRIPTION', escapeText(event.detail)),
      line('TRANSP', 'TRANSPARENT'),
      line('END', 'VEVENT'),
    )
  }
  out.push(line('END', 'VCALENDAR'))
  return `${out.join('\r\n')}\r\n`
}

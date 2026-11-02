/**
 * The public calendar link: `GET /feeds/calendar/<slug>.ics`.
 *
 * There is no session here and there never will be one — a third-party calendar polls this address and
 * cannot log in — so the unguessable slug is the whole capability, exactly as the task feed works. The
 * security `requireAuth` would otherwise supply is done by hand and deliberately:
 *   - the slug shape is checked before any database is touched, so a guessed slug is refused the same
 *     fast 404 as one that never existed and the endpoint cannot be used to probe;
 *   - revoked and unknown links both answer 404, never a 403 that explains which;
 *   - polling is throttled per slug and visitor, and the document itself is capped, so one shared
 *     calendar cannot be turned into unbounded work or an unbounded download.
 *
 * The document is built from the owner's calendar only: no other calendar, no account metadata, and
 * nothing that identifies the owner.
 */
import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidSlug } from '../lib/id'
import { requestClientIp } from '../lib/request'
import { assertAttemptBudget, consumeAttemptBudget } from '../lib/throttle'
import { recordShareView, sharedCalendarChunks, sharedCalendarEtag, shareOwner } from '../calendar/shares'
import { CalendarStore } from '../calendar/store'
import { expandRecurringEvents } from '../calendar/ics'
import { temporalValueToEpochMs } from '@shared/calendar/model'

/** A published calendar is a subscription, not a report: four megabytes of text is generous. */
const PUBLIC_ICS_BYTES = 4 * 1024 * 1024

export const calendarPublicRoutes = new Hono<AppBindings>()

/** `ABC123….ics` and `abc123…` reach the same calendar; the stored slug is always lowercase. */
export function stripCalendarIcsSuffix(value: string | undefined): string {
  if (!value) return ''
  const lowered = value.toLowerCase()
  return lowered.endsWith('.ics') ? lowered.slice(0, -4) : lowered
}

function throttled(c: Context<AppBindings>, slug: string): Promise<void> {
  const ip = requestClientIp(c)
  return assertAttemptBudget(async () => {
    await consumeAttemptBudget(c.env.DB, [
      { key: `calendar-feed:${slug}:ip:${ip}`, maxAttempts: 60, windowMs: 5 * 60 * 1000 },
    ])
  })
}

calendarPublicRoutes.get('/calendar/:slug', async (c) => {
  const slug = stripCalendarIcsSuffix(c.req.param('slug'))
  if (!isValidSlug(slug)) throw ApiError.notFound('Calendar not found')
  await throttled(c, slug)
  const owner = await shareOwner(c.env.DB, slug)
  if (!owner) throw ApiError.notFound('Calendar not found')
  const fingerprint = await sharedCalendarEtag(c.env.DB, owner.userId, owner.calendarId)
  if (!fingerprint) throw ApiError.notFound('Calendar not found')
  const ifNoneMatch = c.req.header('if-none-match')?.split(',').map(value => value.trim()) ?? []
  if (ifNoneMatch.includes(fingerprint.etag)) {
    return c.body(null, 304, {
      ETag: fingerprint.etag,
      'Cache-Control': 'no-cache',
    })
  }
  const answer = await sharedCalendarChunks(c.env.DB, owner.userId, owner.calendarId, PUBLIC_ICS_BYTES)
  if (!answer.chunks) {
    throw ApiError.tooLarge('That shared calendar is too large to publish as one file')
  }
  const chunks = answer.chunks
  await recordShareView(c.env.DB, slug)
  return c.body(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  }), 200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Cache-Control': 'no-cache',
    ETag: fingerprint.etag,
    'X-Content-Type-Options': 'nosniff',
  })
})

// ------------------------------------------------------------- public HTML page

export const calendarSharePageRoutes = new Hono<AppBindings>()

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

calendarSharePageRoutes.get('/:slug', async (c) => {
  const slug = stripCalendarIcsSuffix(c.req.param('slug'))
  if (!isValidSlug(slug)) throw ApiError.notFound('Calendar not found')
  await throttled(c, slug)
  const owner = await shareOwner(c.env.DB, slug)
  if (!owner) throw ApiError.notFound('Calendar not found')
  const store = new CalendarStore(c.env.DB, owner.userId)
  const preferences = await store.preferences()
  const calendar = (await store.listCalendars()).find(entry => entry.id === owner.calendarId)
  if (!calendar) throw ApiError.notFound('Calendar not found')
  const from = Date.now() - 7 * 86_400_000
  const to = Date.now() + 60 * 86_400_000
  const result = await store.listEvents(from, to, [owner.calendarId])
  const expansion = expandRecurringEvents(result.events, from, to, preferences.timeZone)
  const events = [...result.events, ...expansion.occurrences]
    .map(event => ({
      title: event.title,
      description: event.description,
      allDay: event.allDay,
      start: temporalValueToEpochMs(event.start, preferences.timeZone),
      end: temporalValueToEpochMs(event.end, preferences.timeZone),
    }))
    .sort((left, right) => left.start - right.start)
    .slice(0, 500)
  const locale = (c.req.header('accept-language') ?? '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
  const day = new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone: preferences.timeZone })
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone: preferences.timeZone })
  const groups = new Map<string, typeof events>()
  for (const event of events) {
    const key = day.format(new Date(event.start))
    const list = groups.get(key) ?? []
    list.push(event)
    groups.set(key, list)
  }
  const body = groups.size === 0
    ? '<p class="booking-empty">No events in the next two months.</p>'
    : [...groups.entries()].map(([label, list]) => `
        <section class="booking-day">
          <h2>${escapeHtml(label)}</h2>
          <ul class="public-events">
            ${list.map(event => `
              <li class="public-event">
                <span class="public-event-time">${event.allDay ? '—' : escapeHtml(time.format(new Date(event.start)))}</span>
                <span class="public-event-body">
                  <strong>${escapeHtml(event.title)}</strong>
                  ${event.description ? `<span>${escapeHtml(event.description.slice(0, 500))}</span>` : ''}
                </span>
              </li>`).join('')}
          </ul>
        </section>`).join('')
  const html = `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(calendar.name)}</title>
<link rel="stylesheet" href="/schedule.css">
</head>
<body>
<main class="booking-card">
<h1>${escapeHtml(calendar.name)}</h1>
<p class="booking-meta">Public calendar · ${escapeHtml(preferences.timeZone)}</p>
${body}
</main>
</body>
</html>`
  return c.html(html, 200, {
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
  })
})

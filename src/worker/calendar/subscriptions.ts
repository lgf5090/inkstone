import { isBlockedTarget } from '@shared/ai-proxy-guard'
import {
  MAX_ICS_BYTES,
  MAX_ICS_EVENTS,
  type CalendarEventInput,
  type CalendarSubscriptionDto,
} from '@shared/calendar/model'
import type { D1Database } from '@cloudflare/workers-types'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { isRedirectResponse, NO_REDIRECT } from '../lib/no-redirect'
import { readStreamTextWithinLimit } from '../lib/request'
import { CalendarStore, type CalendarEventWriteInput } from './store'
import { parseEventInput } from './validation'
import { IcsParseError, icsExternalId, parseIcsCalendar } from './ics'

const FETCH_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 3
const EVENT_CHUNK = 200
const SUBSCRIPTION_COLORS = [
  '#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ef4444',
  '#f97316', '#ec4899', '#14b8a6', '#6366f1', '#6b7280',
]

interface FeedResult {
  notModified: boolean
  text: string
  etag: string | null
  lastModified: string | null
}

interface SubscriptionRow {
  id: string
  calendar_id: string
  url: string | null
  enabled: number
  sync_state_json: string
  last_sync_at: number | null
  last_error_code: string | null
}

export interface CreateSubscriptionResult {
  subscription: CalendarSubscriptionDto
  calendarId: string
  imported: number
  warnings: ReturnType<typeof parseIcsCalendar>['warnings']
}

export interface RefreshSubscriptionResult {
  imported: number
  removed: number
  notModified: boolean
  warnings: ReturnType<typeof parseIcsCalendar>['warnings']
  lastSyncAt: number
}

export async function createIcsSubscription(
  env: Env,
  userId: string,
  input: { url: string; name?: string; color?: string },
): Promise<CreateSubscriptionResult> {
  const url = validateFeedUrl(input.url)
  const store = new CalendarStore(env.DB, userId)
  const preferences = await store.preferences()
  const feed = await fetchFeed(url, { etag: null, lastModified: null }, preferences.timeZone)
  const parsed = parseFeed(feed.text, preferences.timeZone)
  const name = (input.name?.trim() || parsed.name || url.hostname).slice(0, 80)
  const color = normalizeColor(input.color) ?? colorFor(name)
  const calendar = await store.createCalendar({
    name,
    color,
    darkColor: color,
    isDefault: false,
    isVisible: true,
  })
  const subscriptionId = newId()
  const now = Date.now()
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE calendar_calendars
            SET source = 'ics', read_only = 1, subscription_id = ?3, rev = rev + 1, updated_at = ?4
          WHERE user_id = ?1 AND id = ?2`,
      ).bind(userId, calendar.id, subscriptionId, now),
      env.DB.prepare(
        `INSERT INTO calendar_subscriptions
          (user_id, id, calendar_id, kind, url, enabled, sync_state_json, last_sync_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'ics', ?4, 1, ?5, ?6, ?6, ?6)`,
      ).bind(userId, subscriptionId, calendar.id, url.href, JSON.stringify({
        etag: feed.etag,
        lastModified: feed.lastModified,
      }), now),
    ])
    const inputs = await subscriptionEvents(parsed.events, calendar.id, preferences.timeZone)
    const imported = await insertInChunks(store, inputs)
    return {
      subscription: subscriptionRowToDto({
        id: subscriptionId,
        calendar_id: calendar.id,
        url: url.href,
        enabled: 1,
        sync_state_json: JSON.stringify({ etag: feed.etag, lastModified: feed.lastModified }),
        last_sync_at: now,
        last_error_code: null,
      }),
      calendarId: calendar.id,
      imported,
      warnings: parsed.warnings,
    }
  } catch (error) {
    await removeCalendarData(env.DB, userId, calendar.id).catch((cleanupError) => {
      console.warn('[inkstone] Calendar subscription cleanup failed:', cleanupError instanceof Error ? cleanupError.message : cleanupError)
    })
    throw error
  }
}

export async function refreshIcsSubscription(
  env: Env,
  userId: string,
  subscriptionId: string,
): Promise<RefreshSubscriptionResult> {
  const store = new CalendarStore(env.DB, userId)
  const row = await loadSubscription(env.DB, userId, subscriptionId)
  if (!row || !row.url) throw ApiError.notFound('Subscription not found')
  if (!row.enabled) throw ApiError.conflict('This calendar subscription is disabled')
  const state = readSyncState(row.sync_state_json)
  const preferences = await store.preferences()
  const url = validateFeedUrl(row.url)
  let feed: FeedResult
  try {
    feed = await fetchFeed(url, state, preferences.timeZone)
  } catch (error) {
    await markSubscriptionError(env.DB, userId, subscriptionId, 'fetch_failed')
    throw error
  }
  const now = Date.now()
  if (feed.notModified) {
    await touchSubscription(env.DB, userId, subscriptionId, now, state)
    return { imported: 0, removed: 0, notModified: true, warnings: [], lastSyncAt: now }
  }
  let parsed
  try {
    parsed = parseFeed(feed.text, preferences.timeZone)
  } catch (error) {
    await markSubscriptionError(env.DB, userId, subscriptionId, error instanceof IcsParseError ? error.code : 'invalid_ics')
    throw error
  }
  const inputs = await subscriptionEvents(parsed.events, row.calendar_id, preferences.timeZone)
  let imported = 0
  try {
    imported = await insertInChunks(store, inputs)
    const keep = new Set(inputs.map((event) => event.externalId).filter((id): id is string => Boolean(id)))
    const removed = await removeStaleEvents(env.DB, userId, row.calendar_id, keep)
    await touchSubscription(env.DB, userId, subscriptionId, now, {
      etag: feed.etag,
      lastModified: feed.lastModified,
    })
    return { imported, removed, notModified: false, warnings: parsed.warnings, lastSyncAt: now }
  } catch (error) {
    await markSubscriptionError(env.DB, userId, subscriptionId, 'import_failed')
    throw error
  }
}

export async function deleteIcsSubscription(
  env: Env,
  userId: string,
  subscriptionId: string,
): Promise<void> {
  const row = await loadSubscription(env.DB, userId, subscriptionId)
  if (!row) throw ApiError.notFound('Subscription not found')
  const store = new CalendarStore(env.DB, userId)
  const calendars = await store.listCalendars()
  if (calendars.length <= 1) {
    throw ApiError.conflict('Create another calendar before deleting the last one')
  }
  await removeCalendarData(env.DB, userId, row.calendar_id)
  await store.ensureDefaultCalendar()
}

export async function setIcsSubscriptionEnabled(
  env: Env,
  userId: string,
  subscriptionId: string,
  enabled: boolean,
): Promise<void> {
  const row = await loadSubscription(env.DB, userId, subscriptionId)
  if (!row) throw ApiError.notFound('Subscription not found')
  await env.DB.prepare(
    `UPDATE calendar_subscriptions SET enabled = ?3, updated_at = ?4
      WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, subscriptionId, enabled ? 1 : 0, Date.now()).run()
}

const DUE_REFRESH_INTERVAL_MS = 15 * 60 * 1000
const DUE_REFRESH_RETRY_MS = 60 * 60 * 1000
const DUE_REFRESH_LIMIT = 3

/**
 * Refresh a few due ICS feeds on each cron fire.
 *
 * `last_sync_at` spaces successful runs; `last_error_at` holds a broken feed for an hour instead of
 * retrying it every minute. The limit keeps one slow feed from spending the whole scheduled budget.
 */
export async function refreshDueIcsSubscriptions(env: Env, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT user_id, id FROM calendar_subscriptions
      WHERE kind = 'ics' AND enabled = 1 AND url IS NOT NULL
        AND (last_sync_at IS NULL OR last_sync_at <= ?1)
        AND (last_error_at IS NULL OR last_error_at <= ?2)
      ORDER BY COALESCE(last_sync_at, 0) ASC
      LIMIT ?3`,
  ).bind(now - DUE_REFRESH_INTERVAL_MS, now - DUE_REFRESH_RETRY_MS, DUE_REFRESH_LIMIT)
    .all<{ user_id: string; id: string }>()
  const outcomes = await Promise.all((results ?? []).map(async (row) => {
    try {
      await refreshIcsSubscription(env, row.user_id, row.id)
      return 1
    } catch (error) {
      console.warn('[inkstone] Scheduled calendar subscription refresh failed:', {
        subscription: row.id,
        error: error instanceof Error ? error.message : error,
      })
      return 0
    }
  }))
  return outcomes.reduce<number>((total, value) => total + value, 0)
}

function parseFeed(text: string, defaultTimeZone: string) {
  try {
    return parseIcsCalendar({ content: text, defaultTimeZone, maxEvents: MAX_ICS_EVENTS })
  } catch (error) {
    if (error instanceof IcsParseError) {
      if (error.code === 'too_large' || error.code === 'too_many_events') throw ApiError.tooLarge(error.message)
      throw ApiError.badRequest(error.message)
    }
    throw new ApiError(502, 'internal', 'The calendar feed could not be parsed')
  }
}

async function subscriptionEvents(
  events: readonly CalendarEventInput[],
  calendarId: string,
  defaultTimeZone: string,
): Promise<CalendarEventWriteInput[]> {
  return Promise.all(events.map(async (event) => {
    const uid = event.meta?.originalUid
    const externalId = typeof uid === 'string'
      ? await icsExternalId(calendarId, uid, recurrenceIdOf(event.meta?.recurrenceId))
      : null
    return parseEventInput({
      ...event,
      calendarIds: [calendarId],
      calendarId: undefined,
      source: 'ics',
      externalId,
    }, { defaultTimeZone })
  }))
}

function recurrenceIdOf(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  return typeof record.value === 'string' ? record.value : null
}

async function insertInChunks(store: CalendarStore, inputs: readonly CalendarEventWriteInput[]): Promise<number> {
  let imported = 0
  for (let index = 0; index < inputs.length; index += EVENT_CHUNK) {
    imported += (await store.createEvents(inputs.slice(index, index + EVENT_CHUNK), 'upsert')).length
  }
  return imported
}

async function removeStaleEvents(
  db: D1Database,
  userId: string,
  calendarId: string,
  keepExternalIds: ReadonlySet<string>,
): Promise<number> {
  const { results } = await db.prepare(
    `SELECT e.id, e.external_id
       FROM calendar_events e
       JOIN calendar_event_calendars m
         ON m.user_id = e.user_id AND m.event_id = e.id
      WHERE e.user_id = ?1 AND m.calendar_id = ?2 AND e.calendar_source = 'ics'`,
  ).bind(userId, calendarId).all<{ id: string; external_id: string | null }>()
  const stale = (results ?? [])
    .filter((row) => !row.external_id || !keepExternalIds.has(row.external_id))
    .map((row) => row.id)
  if (!stale.length) return 0
  for (let index = 0; index < stale.length; index += 100) {
    const ids = stale.slice(index, index + 100)
    const membershipPlaceholders = ids.map((_, offset) => `?${offset + 3}`).join(', ')
    const eventPlaceholders = ids.map((_, offset) => `?${offset + 2}`).join(', ')
    await db.batch([
      db.prepare(
        `DELETE FROM calendar_event_calendars
          WHERE user_id = ?1 AND calendar_id = ?2 AND event_id IN (${membershipPlaceholders})`,
      ).bind(userId, calendarId, ...ids),
      db.prepare(
        `DELETE FROM calendar_events
          WHERE user_id = ?1 AND id IN (${eventPlaceholders})
            AND NOT EXISTS (
              SELECT 1 FROM calendar_event_calendars m
               WHERE m.user_id = ?1 AND m.event_id = calendar_events.id
            )`,
      ).bind(userId, ...ids),
    ])
  }
  return stale.length
}

async function removeCalendarData(db: D1Database, userId: string, calendarId: string): Promise<void> {
  await db.batch([
    db.prepare(
      `DELETE FROM calendar_event_calendars WHERE user_id = ?1 AND calendar_id = ?2`,
    ).bind(userId, calendarId),
    db.prepare(
      `DELETE FROM calendar_events
        WHERE user_id = ?1 AND NOT EXISTS (
          SELECT 1 FROM calendar_event_calendars m
           WHERE m.user_id = ?1 AND m.event_id = calendar_events.id
        )`,
    ).bind(userId),
    db.prepare(
      `DELETE FROM calendar_subscriptions WHERE user_id = ?1 AND calendar_id = ?2`,
    ).bind(userId, calendarId),
    db.prepare(
      `DELETE FROM calendar_calendars WHERE user_id = ?1 AND id = ?2`,
    ).bind(userId, calendarId),
  ])
}

async function loadSubscription(
  db: D1Database,
  userId: string,
  id: string,
): Promise<SubscriptionRow | null> {
  return db.prepare(
    `SELECT id, calendar_id, url, enabled, sync_state_json, last_sync_at, last_error_code
       FROM calendar_subscriptions
      WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<SubscriptionRow>()
}

async function touchSubscription(
  db: D1Database,
  userId: string,
  id: string,
  at: number,
  state: { etag: string | null; lastModified: string | null },
): Promise<void> {
  await db.prepare(
    `UPDATE calendar_subscriptions
        SET last_sync_at = ?3, last_error_code = NULL, last_error_at = NULL,
            sync_state_json = ?4, updated_at = ?3
      WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id, at, JSON.stringify(state)).run()
}

async function markSubscriptionError(
  db: D1Database,
  userId: string,
  id: string,
  code: string,
): Promise<void> {
  const now = Date.now()
  await db.prepare(
    `UPDATE calendar_subscriptions
        SET last_error_code = ?3, last_error_at = ?4, updated_at = ?4
      WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id, code, now).run()
}

function subscriptionRowToDto(row: SubscriptionRow): CalendarSubscriptionDto {
  const now = Date.now()
  return {
    id: row.id,
    calendarId: row.calendar_id,
    kind: 'ics',
    url: row.url,
    enabled: row.enabled === 1,
    lastSyncAt: row.last_sync_at,
    lastErrorCode: row.last_error_code,
    createdAt: now,
    updatedAt: now,
  }
}

function readSyncState(raw: string): { etag: string | null; lastModified: string | null } {
  try {
    const parsed = JSON.parse(raw) as { etag?: unknown; lastModified?: unknown }
    return {
      etag: typeof parsed.etag === 'string' ? parsed.etag : null,
      lastModified: typeof parsed.lastModified === 'string' ? parsed.lastModified : null,
    }
  } catch {
    return { etag: null, lastModified: null }
  }
}

function normalizeColor(value: string | undefined): string | null {
  if (!value) return null
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null
}

function colorFor(name: string): string {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return SUBSCRIPTION_COLORS[hash % SUBSCRIPTION_COLORS.length]!
}

function validateFeedUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw ApiError.badRequest('Enter a valid calendar URL')
  }
  if (url.protocol !== 'https:') throw ApiError.badRequest('Calendar subscriptions must use https')
  if (url.username || url.password) throw ApiError.badRequest('Calendar URLs may not carry credentials')
  if (url.hash) throw ApiError.badRequest('Calendar URLs may not carry a fragment')
  if (url.port && url.port !== '443') throw ApiError.badRequest('Calendar URLs must use port 443')
  if (isBlockedTarget(url.hostname)) throw ApiError.badRequest('That address is not reachable from this deployment')
  return url
}

async function fetchFeed(
  url: URL,
  state: { etag: string | null; lastModified: string | null },
  _timeZone: string,
): Promise<FeedResult> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(current.href, {
        redirect: NO_REDIRECT,
        signal: controller.signal,
        headers: {
          accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1',
          'user-agent': 'Inkstone Calendar',
          ...(state.etag ? { 'if-none-match': state.etag } : {}),
          ...(state.lastModified ? { 'if-modified-since': state.lastModified } : {}),
        },
      })
    } catch {
      throw new ApiError(502, 'internal', 'The calendar feed could not be reached')
    } finally {
      clearTimeout(timeout)
    }
    if (response.status === 304) {
      return { notModified: true, text: '', etag: state.etag, lastModified: state.lastModified }
    }
    if (isRedirectResponse(response)) {
      const location = response.headers.get('location')
      if (!location || hop === MAX_REDIRECTS) {
        throw new ApiError(502, 'internal', 'The calendar feed redirected too many times')
      }
      current = validateFeedUrl(new URL(location, current).href)
      continue
    }
    if (!response.ok) {
      throw new ApiError(502, 'internal', `The calendar feed answered ${response.status}`)
    }
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MAX_ICS_BYTES) {
      throw ApiError.tooLarge('That calendar feed is too large')
    }
    const text = await readStreamTextWithinLimit(response.body, MAX_ICS_BYTES)
    if (text === null) throw ApiError.tooLarge('That calendar feed is too large')
    return {
      notModified: false,
      text,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
    }
  }
  throw new ApiError(502, 'internal', 'The calendar feed could not be reached')
}

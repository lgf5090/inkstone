import { isBlockedTarget } from '@shared/ai-proxy-guard'
import { resolvePublicHost } from '../lib/host-guard'
import { sha256Hex } from '../lib/encoding'
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
import { IcsParseError, icsExternalId, parseIcsCalendar, type IcsWarning } from './ics'

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
  created_at: number
  updated_at: number
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
  const feed = await fetchFeed(url, { etag: null, lastModified: null })
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
    const subscription = await loadSubscription(env.DB, userId, subscriptionId)
    if (!subscription) throw new Error('Calendar subscription create did not persist')
    const inputs = await subscriptionEvents(parsed.events, calendar.id, preferences.timeZone, parsed.warnings)
    if (inputs.length === 0) throw ApiError.badRequest('The calendar feed contains no valid events')
    const imported = await insertInChunks(store, inputs)
    return {
      subscription: subscriptionRowToDto(subscription),
      calendarId: calendar.id,
      imported,
      warnings: parsed.warnings,
    }
  } catch (error) {
    await store.deleteCalendar(calendar.id, { mode: 'delete', allowLast: true }).catch((cleanupError) => {
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
    feed = await fetchFeed(url, state)
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
  let inputs: CalendarEventWriteInput[]
  let imported = 0
  try {
    inputs = await subscriptionEvents(parsed.events, row.calendar_id, preferences.timeZone, parsed.warnings)
    if (inputs.length === 0) throw ApiError.badRequest('The calendar feed contains no valid events')
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
  await store.deleteCalendar(row.calendar_id, { mode: 'delete' })
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
const DUE_REFRESH_RETRY_BASE_MS = 5 * 60 * 1000
const DUE_REFRESH_RETRY_MAX_MS = 24 * 60 * 60 * 1000
const DUE_REFRESH_MAX_FAILURES = 8
const DUE_REFRESH_LIMIT = 20

/**
 * Refresh a few due ICS feeds on each cron fire.
 *
 * `last_sync_at` spaces successful runs; `last_error_at` holds the next exponential retry, and repeated
 * failures pause the feed. The limit keeps one slow feed from spending the whole scheduled budget.
 */
export async function refreshDueIcsSubscriptions(env: Env, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT user_id, id FROM calendar_subscriptions
      WHERE kind = 'ics' AND enabled = 1 AND url IS NOT NULL
        AND (last_sync_at IS NULL OR last_sync_at <= ?1)
        AND (last_error_at IS NULL OR last_error_at <= ?2)
      ORDER BY COALESCE(last_sync_at, 0) ASC
      LIMIT ?3`,
  ).bind(now - DUE_REFRESH_INTERVAL_MS, now, DUE_REFRESH_LIMIT)
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
  warnings: IcsWarning[],
): Promise<CalendarEventWriteInput[]> {
  const inputs: CalendarEventWriteInput[] = []
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!
    try {
      const uid = event.meta?.originalUid
      const recurrenceId = recurrenceIdOf(event.meta?.recurrenceId)
      const stableUid = typeof uid === 'string'
        ? uid
        : `missing:${await sha256Hex(JSON.stringify([event.title, event.start, event.end, event.description, event.recurrenceRule, recurrenceId]))}`
      const externalId = await icsExternalId(calendarId, stableUid, recurrenceId)
      inputs.push(parseEventInput({
        ...event,
        calendarIds: [calendarId],
        calendarId: undefined,
        source: 'ics',
        externalId,
      }, { defaultTimeZone }))
    } catch (error) {
      warnings.push({
        line: index + 1,
        ...(typeof event.meta?.originalUid === 'string' ? { uid: event.meta.originalUid } : {}),
        code: 'invalid_event',
        message: error instanceof Error ? error.message : 'The event could not be imported',
      })
    }
  }
  return inputs
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
  const store = new CalendarStore(db, userId)
  let removed = 0
  for (let index = 0; index < stale.length; index += 80) {
    removed += await store.removeEventMembershipsAndDeleteOrphans(calendarId, stale.slice(index, index + 80))
  }
  return removed
}

async function loadSubscription(
  db: D1Database,
  userId: string,
  id: string,
): Promise<SubscriptionRow | null> {
  return db.prepare(
    `SELECT id, calendar_id, url, enabled, sync_state_json, last_sync_at, last_error_code,
            created_at, updated_at
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
  ).bind(userId, id, at, JSON.stringify({ ...state, failures: 0 })).run()
}

async function markSubscriptionError(
  db: D1Database,
  userId: string,
  id: string,
  code: string,
): Promise<void> {
  const row = await db.prepare(
    'SELECT sync_state_json FROM calendar_subscriptions WHERE user_id = ?1 AND id = ?2',
  ).bind(userId, id).first<{ sync_state_json: string }>()
  if (!row) return
  const state = readSyncState(row.sync_state_json)
  const failures = Math.min(state.failures + 1, DUE_REFRESH_MAX_FAILURES)
  const now = Date.now()
  const retryAt = now + Math.min(
    DUE_REFRESH_RETRY_BASE_MS * (2 ** (failures - 1)),
    DUE_REFRESH_RETRY_MAX_MS,
  )
  await db.prepare(
    `UPDATE calendar_subscriptions
        SET last_error_code = ?3, last_error_at = ?4,
            sync_state_json = ?5, enabled = CASE WHEN ?6 >= ?7 THEN 0 ELSE enabled END,
            updated_at = ?8
      WHERE user_id = ?1 AND id = ?2`,
  ).bind(
    userId, id, code, retryAt,
    JSON.stringify({ etag: state.etag, lastModified: state.lastModified, failures }),
    failures, DUE_REFRESH_MAX_FAILURES, now,
  ).run()
}

function subscriptionHost(raw: string | null): string | null {
  if (!raw) return null
  try {
    return new URL(raw).hostname
  } catch {
    return null
  }
}

function subscriptionRowToDto(row: SubscriptionRow): CalendarSubscriptionDto {
  return {
    id: row.id,
    calendarId: row.calendar_id,
    kind: 'ics',
    urlHost: subscriptionHost(row.url),
    enabled: row.enabled === 1,
    lastSyncAt: row.last_sync_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function readSyncState(raw: string): { etag: string | null; lastModified: string | null; failures: number } {
  try {
    const parsed = JSON.parse(raw) as { etag?: unknown; lastModified?: unknown; failures?: unknown }
    return {
      etag: typeof parsed.etag === 'string' ? parsed.etag : null,
      lastModified: typeof parsed.lastModified === 'string' ? parsed.lastModified : null,
      failures: typeof parsed.failures === 'number' && Number.isInteger(parsed.failures)
        ? Math.max(0, Math.min(parsed.failures, DUE_REFRESH_MAX_FAILURES))
        : 0,
    }
  } catch {
    return { etag: null, lastModified: null, failures: 0 }
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
): Promise<FeedResult> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const verdict = await resolvePublicHost(current.hostname)
    if (verdict === 'blocked') throw ApiError.badRequest('That address is not reachable from this deployment')
    if (verdict === 'unresolved') throw ApiError.badRequest('The calendar address does not resolve')
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new ApiError(502, 'internal', 'The calendar feed took too long to download'))
      }, FETCH_TIMEOUT_MS)
    })
    try {
      const response = await Promise.race([fetch(current.href, {
        redirect: NO_REDIRECT,
        signal: controller.signal,
        headers: {
          accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1',
          'user-agent': 'Inkstone Calendar',
          ...(state.etag ? { 'if-none-match': state.etag } : {}),
          ...(state.lastModified ? { 'if-modified-since': state.lastModified } : {}),
        },
      }), deadline])
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
      const text = await Promise.race([readStreamTextWithinLimit(response.body, MAX_ICS_BYTES), deadline])
      if (text === null) throw ApiError.tooLarge('That calendar feed is too large')
      return {
        notModified: false,
        text,
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
      }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'internal', 'The calendar feed could not be reached')
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  throw new ApiError(502, 'internal', 'The calendar feed could not be reached')
}

import {
  attachCalDAVToDayFlow,
  createCalDAVAdapter,
  createCalDAVSync,
  type CalDAVEventSyncState,
  type CalDAVStorage,
} from '@dayflow/caldav'
import {
  attachGoogleSyncToDayFlow,
  createGoogleSync,
  createGoogleSyncAdapter,
  type GoogleSyncStorage,
} from '@dayflow/google-sync'
import {
  attachOutlookSyncToDayFlow,
  createOutlookSync,
  createOutlookSyncAdapter,
  type OutlookSyncStorage,
} from '@dayflow/outlook-sync'
import type { CalendarType, Event, ICalendarApp } from '@dayflow/react'
import { createStore, del, delMany, get, keys, set } from 'idb-keyval'
import type { CalendarConnectionDto } from '@shared/calendar/model'
import * as api from './api'

const store = createStore('inkstone-calendar', 'sync-state')
const STATUS_REPORT_INTERVAL_MS = 30_000

type ProviderStatus = 'connected' | 'error'

export interface ProviderSyncOptions {
  userId: string
  connections: readonly CalendarConnectionDto[]
  getInitialSnapshot: () => { events: Event[]; calendars: CalendarType[] }
  onStatus?: (connection: CalendarConnectionDto, status: ProviderStatus, error?: unknown) => void
  onRefreshMeta?: () => void | Promise<void>
}

export interface ProviderAttachment {
  stop: () => void
}

function storageKey(prefix: string, ...parts: string[]): string {
  return [prefix, ...parts].join(':')
}

class IdbCalDAVStorage implements CalDAVStorage {
  constructor(private readonly prefix: string) {}

  private value<T>(...parts: string[]): Promise<T | undefined> {
    return get<T>(storageKey(this.prefix, ...parts), store)
  }

  private write(...partsAndValue: [...string[], unknown]): Promise<void> {
    const value = partsAndValue.pop()
    return set(storageKey(this.prefix, ...(partsAndValue as string[])), value, store)
  }

  async getSyncToken(calendarId: string): Promise<string | null> {
    return (await this.value<string>('caldav', 'calendar', calendarId, 'token')) ?? null
  }

  setSyncToken(calendarId: string, token: string | null): Promise<void> {
    return token
      ? this.write('caldav', 'calendar', calendarId, 'token', token)
      : del(storageKey(this.prefix, 'caldav', 'calendar', calendarId, 'token'), store)
  }

  async getCtag(calendarId: string): Promise<string | null> {
    return (await this.value<string>('caldav', 'calendar', calendarId, 'ctag')) ?? null
  }

  setCtag(calendarId: string, ctag: string): Promise<void> {
    return ctag
      ? this.write('caldav', 'calendar', calendarId, 'ctag', ctag)
      : del(storageKey(this.prefix, 'caldav', 'calendar', calendarId, 'ctag'), store)
  }

  async getEtag(href: string): Promise<string | null> {
    return (await this.value<string>('caldav', 'etag', href)) ?? null
  }

  setEtag(href: string, etag: string): Promise<void> {
    return this.write('caldav', 'etag', href, etag)
  }

  deleteEtag(href: string): Promise<void> {
    return del(storageKey(this.prefix, 'caldav', 'etag', href), store)
  }

  async getEventState(eventId: string): Promise<CalDAVEventSyncState | null> {
    return (await this.value<CalDAVEventSyncState>('caldav', 'event', eventId)) ?? null
  }

  setEventState(eventId: string, state: CalDAVEventSyncState): Promise<void> {
    return this.write('caldav', 'event', eventId, state)
  }

  deleteEventState(eventId: string): Promise<void> {
    return del(storageKey(this.prefix, 'caldav', 'event', eventId), store)
  }

  async clearCalendar(calendarId: string): Promise<void> {
    const prefix = storageKey(this.prefix, 'caldav')
    const all = await keys<string>(store)
    const doomed = all.filter((key) =>
      key.startsWith(`${prefix}:calendar:${calendarId}:`)
      || key.includes(`:${calendarId}:`))
    if (doomed.length > 0) await delMany(doomed, store)
  }
}

class IdbGoogleStorage implements GoogleSyncStorage {
  constructor(private readonly prefix: string) {}

  async getSyncToken(calendarId: string): Promise<string | null> {
    return (await get<string>(storageKey(this.prefix, 'google', calendarId), store)) ?? null
  }

  setSyncToken(calendarId: string, token: string | null): Promise<void> {
    return token
      ? set(storageKey(this.prefix, 'google', calendarId), token, store)
      : del(storageKey(this.prefix, 'google', calendarId), store)
  }
}

class IdbOutlookStorage implements OutlookSyncStorage {
  constructor(private readonly prefix: string) {}

  async getDeltaToken(calendarId: string): Promise<string | null> {
    return (await get<string>(storageKey(this.prefix, 'outlook', calendarId), store)) ?? null
  }

  setDeltaToken(calendarId: string, token: string | null): Promise<void> {
    return token
      ? set(storageKey(this.prefix, 'outlook', calendarId), token, store)
      : del(storageKey(this.prefix, 'outlook', calendarId), store)
  }
}

/** A provider adapter fetch that talks only to the same-origin connection proxy. */
function proxiedFetch(connectionId: string): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : null
    const url = new URL(request?.url ?? String(input), window.location.href)
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    const headers = Object.fromEntries(new Headers(init?.headers ?? request?.headers).entries())
    const rawBody = init?.body
    let body: string | undefined
    if (typeof rawBody === 'string') body = rawBody
    else if (rawBody instanceof URLSearchParams) body = rawBody.toString()
    else if (rawBody !== undefined && rawBody !== null) {
      throw new Error('The calendar provider sent a request body this client cannot proxy')
    }
    const signal = init?.signal ?? request?.signal ?? undefined
    const response = await api.proxyCalendar(connectionId, {
      method,
      path: `${url.pathname}${url.search}`,
      headers,
      ...(body === undefined ? {} : { body }),
    }, signal ?? undefined)
    const nullBody = response.status === 204 || response.status === 205 || response.status === 304
    return new Response(nullBody ? null : response.body, {
      status: response.status,
      headers: response.headers,
    })
  }
}

function errorCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : ''
  const candidate = message.toLowerCase().replaceAll(/[^a-z0-9_.:-]+/g, '_').replaceAll(/^_+|_+$/g, '')
  return (candidate || fallback).slice(0, 100)
}

function reportStatus(
  connection: CalendarConnectionDto,
  status: ProviderStatus,
  error?: unknown,
): void {
  const lastSyncedAt = status === 'connected' ? Date.now() : undefined
  const code = error === undefined ? undefined : errorCode(error, 'sync_failed')
  void api.reportConnectionStatus(connection.id, status === 'connected' ? 'connected' : 'error', lastSyncedAt, code)
    .catch((reportError: unknown) => {
      console.warn('[inkstone] Calendar connection status report failed:', reportError instanceof Error ? reportError.message : reportError)
    })
}

/**
 * Start one adapter per remote connection. Each adapter writes through its DayFlow binding; the
 * calendar/event persistence hooks in `CalendarSurface` put the resulting rows in D1.
 */
export function attachCalendarProviders(
  app: ICalendarApp,
  options: ProviderSyncOptions,
): ProviderAttachment {
  if (options.connections.length === 0) return { stop: () => {} }

  const controllers: Array<{ stop: () => void }> = []
  const lastReport = new Map<string, number>()

  const announce = (connection: CalendarConnectionDto, status: ProviderStatus, error?: unknown): void => {
    options.onStatus?.(connection, status, error)
    const now = Date.now()
    const last = lastReport.get(connection.id) ?? 0
    if (status === 'error' || now - last >= STATUS_REPORT_INTERVAL_MS) {
      lastReport.set(connection.id, now)
      reportStatus(connection, status, error)
    }
    if (status === 'connected' && options.onRefreshMeta) {
      void Promise.resolve(options.onRefreshMeta()).catch((refreshError: unknown) => {
        console.warn('[inkstone] Calendar metadata refresh after sync failed:', refreshError instanceof Error ? refreshError.message : refreshError)
      })
    }
  }

  for (const connection of options.connections) {
    if (connection.status === 'disconnected' || connection.status === 'expired') continue
    const prefix = storageKey(options.userId, connection.id)
    const fetchImpl = proxiedFetch(connection.id)
    try {
      if (connection.kind === 'caldav') {
        if (!connection.calendarHomeUrl) throw new Error('The CalDAV home address is missing')
        const adapter = createCalDAVAdapter({
          calendarHomeUrl: connection.calendarHomeUrl,
          fetch: fetchImpl,
        })
        const sync = createCalDAVSync({
          adapter,
          storage: new IdbCalDAVStorage(prefix),
        })
        const controller = attachCalDAVToDayFlow(app, sync, {
          writable: connection.writable,
          refreshOnVisibleRangeChange: true,
          eventMode: { recurring: 'read-only' },
          getInitialSnapshot: async () => options.getInitialSnapshot(),
          onError: (error) => announce(connection, 'error', error),
          onSyncComplete: () => announce(connection, 'connected'),
        })
        void controller.start().catch((error: unknown) => announce(connection, 'error', error))
        controllers.push({ stop: () => controller.stop() })
      } else if (connection.kind === 'google') {
        const adapter = createGoogleSyncAdapter({ fetch: fetchImpl })
        const sync = createGoogleSync(adapter, { storage: new IdbGoogleStorage(prefix) })
        const controller = attachGoogleSyncToDayFlow(app, sync, {
          writable: connection.writable,
          getInitialSnapshot: async () => options.getInitialSnapshot(),
          onStatusChange: status => {
            if (status.state === 'error') announce(connection, 'error', status.error)
            else if (status.state === 'idle') announce(connection, 'connected')
          },
          onWriteError: error => announce(connection, 'error', error),
          onSyncComplete: () => announce(connection, 'connected'),
        })
        void controller.start().catch((error: unknown) => announce(connection, 'error', error))
        controllers.push({ stop: () => controller.stop() })
      } else {
        const adapter = createOutlookSyncAdapter({ fetch: fetchImpl })
        const sync = createOutlookSync(adapter, { storage: new IdbOutlookStorage(prefix) })
        const controller = attachOutlookSyncToDayFlow(app, sync, {
          writable: connection.writable,
          getInitialSnapshot: async () => options.getInitialSnapshot(),
          onStatusChange: status => {
            if (status.state === 'error') announce(connection, 'error', status.error)
            else if (status.state === 'idle') announce(connection, 'connected')
          },
          onWriteError: error => announce(connection, 'error', error),
          onSyncComplete: () => announce(connection, 'connected'),
        })
        void controller.start().catch((error: unknown) => announce(connection, 'error', error))
        controllers.push({ stop: () => controller.stop() })
      }
    } catch (error) {
      announce(connection, 'error', error)
    }
  }

  return {
    stop: () => {
      for (const controller of controllers) {
        try {
          controller.stop()
        } catch (error) {
          console.warn('[inkstone] Calendar provider stop failed:', error instanceof Error ? error.message : error)
        }
      }
      lastReport.clear()
    },
  }
}

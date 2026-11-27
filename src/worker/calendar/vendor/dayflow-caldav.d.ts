/**
 * Worker-side type shim for the provider library.
 *
 * The package's published types pull Preact/DOM globals that replace the Worker's BodyInit/Headers.
 * The cron only needs these runtime exports; Vite still resolves the real implementation.
 */
export interface CalDAVDeletedEvent {
  calendarId: string
  uid?: string
  href: string
  etag?: string
}

export interface CalDAVEventData {
  calendarId: string
  uid: string
  href: string
  etag?: string
  icalData: string
}

export interface CalDAVAdapter {
  listCalendars(): Promise<Array<{ id: string }>>
  syncEvents(input: {
    calendarId: string
    range?: { start: Date; end: Date }
    syncToken?: string
  }): Promise<{ events: CalDAVEventData[]; deleted: CalDAVDeletedEvent[]; syncToken?: string }>
}

export interface CalDAVSync {
  listCalendars(): Promise<Array<{ id: string }>>
  syncEvents(input: {
    calendarId: string
    range?: { start: Date; end: Date }
  }): Promise<{ events: CalDAVEventData[]; deleted: CalDAVDeletedEvent[]; syncToken?: string }>
}

export function createCalDAVAdapter(options: {
  calendarHomeUrl: string
  fetch: typeof fetch
}): CalDAVAdapter

export interface CalDAVStorage {
  getSyncToken(calendarId: string): Promise<string | null>
  setSyncToken(calendarId: string, token: string | null): Promise<void>
  getCtag(calendarId: string): Promise<string | null>
  setCtag(calendarId: string, ctag: string): Promise<void>
  getEtag(href: string): Promise<string | null>
  setEtag(href: string, etag: string): Promise<void>
  deleteEtag(href: string): Promise<void>
  getEventState(eventId: string): Promise<{
    calendarId: string; uid: string; href: string; etag?: string; sequence?: number; lastSyncedAt?: string
  } | null>
  setEventState(eventId: string, state: {
    calendarId: string; uid: string; href: string; etag?: string; sequence?: number; lastSyncedAt?: string
  }): Promise<void>
  deleteEventState(eventId: string): Promise<void>
  clearCalendar(calendarId: string): Promise<void>
}

export function createCalDAVSync(options: {
  adapter: CalDAVAdapter
  storage?: CalDAVStorage
  rangeChunkDays?: number
}): CalDAVSync

export function mapCalDAVEventToDayFlow(data: CalDAVEventData): unknown

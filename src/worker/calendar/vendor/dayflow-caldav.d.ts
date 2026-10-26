/**
 * Worker-side type shim for the provider library.
 *
 * The package's published types pull Preact/DOM globals that replace the Worker's BodyInit/Headers.
 * The cron only needs these five runtime exports; Vite still resolves the real implementation.
 */
export interface CalDAVDeletedEvent {
  uid?: string
  href: string
}

export interface CalDAVEventData {
  calendarId: string
  uid: string
  href: string
  etag?: string
  icalData: string
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
}): unknown

export function createCalDAVSync(options: { adapter: unknown }): CalDAVSync

export function mapCalDAVEventToDayFlow(data: CalDAVEventData): unknown

/** Worker-side type shim; see dayflow-caldav.d.ts. */
export interface OutlookSync {
  listCalendars(): Promise<Array<{ id: string }>>
  syncEvents(
    calendarId: string,
    range?: { start: string; end: string },
  ): Promise<{ events: unknown[]; deleted: string[]; deltaToken?: string }>
}

export function createOutlookSyncAdapter(options?: { fetch?: typeof fetch }): unknown
export function createOutlookSync(adapter: unknown): OutlookSync

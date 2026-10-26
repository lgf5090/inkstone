/** Worker-side type shim; see dayflow-caldav.d.ts. */
export interface GoogleSync {
  listCalendars(): Promise<Array<{ id: string }>>
  syncEvents(
    calendarId: string,
    range?: { start: string; end: string },
  ): Promise<{ events: unknown[]; deleted: string[]; syncToken?: string }>
}

export function createGoogleSyncAdapter(options?: { fetch?: typeof fetch }): unknown
export function createGoogleSync(adapter: unknown): GoogleSync

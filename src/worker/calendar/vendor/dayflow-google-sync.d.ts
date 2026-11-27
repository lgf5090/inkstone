/** Worker-side type shim; see dayflow-caldav.d.ts. */
export interface GoogleSync {
  listCalendars(): Promise<Array<{ id: string }>>
  syncEvents(
    calendarId: string,
    range?: { start: string; end: string },
    syncToken?: string,
  ): Promise<{ events: unknown[]; deleted: string[]; syncToken?: string }>
}

export interface GoogleSyncStorage {
  getSyncToken(calendarId: string): Promise<string | null>
  setSyncToken(calendarId: string, token: string | null): Promise<void>
}

export function createGoogleSyncAdapter(options?: { fetch?: typeof fetch }): unknown
export function createGoogleSync(adapter: unknown, options?: { storage?: GoogleSyncStorage }): GoogleSync

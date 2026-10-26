/**
 * The calendar app's API client. Every call goes through the shell's `request` so the client header,
 * locale, error translation and 204 handling stay one implementation.
 */
import { request } from '../../lib/api'
import type {
  CalendarConnectionDto,
  CalendarConnectionKind,
  CalendarDto,
  CalendarEventDto,
  CalendarEventInput,
  CalendarGroupDto,
  CalendarMetaDto,
  CalendarPreferences,
  CalendarSearchResultDto,
  CalendarSource,
} from '@shared/calendar/model'

export interface EventRangeQuery {
  from: number
  to: number
  calendarIds?: string[]
}

export interface EventSearchResponse {
  results: CalendarSearchResultDto[]
  truncated: boolean
}

export interface CalendarCreateInput {
  id?: string
  name: string
  color: string
  darkColor?: string
  groupId?: string | null
  isDefault?: boolean
  isVisible?: boolean
  readOnly?: boolean
  source?: CalendarSource
}

export interface CalendarPatchInput {
  name?: string
  color?: string
  darkColor?: string
  icon?: string | null
  groupId?: string | null
  isVisible?: boolean
  readOnly?: boolean
  isDefault?: boolean
}

export interface IcsImportResponse {
  calendarId: string
  imported: number
  warnings?: Array<{ code: string; message: string }>
}

export interface SubscriptionInput {
  url: string
  name?: string
  color?: string
}

const entity = (id: string): string => encodeURIComponent(id)

function rangeQuery(query: EventRangeQuery): string {
  const params = new URLSearchParams({
    from: new Date(query.from).toISOString(),
    to: new Date(query.to).toISOString(),
  })
  if (query.calendarIds?.length) params.set('calendarIds', query.calendarIds.join(','))
  return params.toString()
}

export function getMeta(signal?: AbortSignal): Promise<CalendarMetaDto> {
  return request<CalendarMetaDto>('/api/calendar/meta', { signal })
}

export interface EventRangeResponse {
  events: CalendarEventDto[]
  occurrences: CalendarEventDto[]
  truncated: boolean
  recurrenceTruncated: boolean
}

export async function getEvents(query: EventRangeQuery, signal?: AbortSignal): Promise<EventRangeResponse> {
  const data = await request<{
    events: CalendarEventDto[]
    occurrences?: CalendarEventDto[]
    truncated?: boolean
    recurrenceTruncated?: boolean
  }>(`/api/calendar/events?${rangeQuery(query)}`, { signal })
  return {
    events: data.events,
    occurrences: data.occurrences ?? [],
    truncated: data.truncated === true,
    recurrenceTruncated: data.recurrenceTruncated === true,
  }
}

export interface EventSearchFilters {
  calendarIds?: string[]
  from?: number
  to?: number
  kind?: 'event' | 'task'
}

export async function searchEvents(
  keyword: string,
  signal?: AbortSignal,
  filters: EventSearchFilters = {},
): Promise<EventSearchResponse> {
  const params = new URLSearchParams({ q: keyword.trim(), limit: '50' })
  if (filters.calendarIds?.length) params.set('calendarIds', filters.calendarIds.join(','))
  if (filters.from !== undefined) params.set('from', new Date(filters.from).toISOString())
  if (filters.to !== undefined) params.set('to', new Date(filters.to).toISOString())
  if (filters.kind) params.set('kind', filters.kind)
  return request<EventSearchResponse>(`/api/calendar/events/search?${params.toString()}`, { signal })
}

export async function createEvent(event: CalendarEventInput): Promise<CalendarEventDto> {
  const data = await request<{ event: CalendarEventDto }>('/api/calendar/events', { method: 'POST', body: event })
  return data.event
}

export async function createEvents(
  events: CalendarEventInput[],
  mode: 'create' | 'upsert',
): Promise<CalendarEventDto[]> {
  const data = await request<{ events: CalendarEventDto[] }>('/api/calendar/events/batch', {
    method: 'POST',
    body: { events, mode },
  })
  return data.events
}

export async function updateEvent(id: string, patch: CalendarEventInput, rev: number): Promise<CalendarEventDto> {
  const patchBody = { ...patch }
  delete patchBody.id
  const data = await request<{ event: CalendarEventDto }>(`/api/calendar/events/${entity(id)}`, {
    method: 'PATCH',
    body: { ...patchBody, rev },
  })
  return data.event
}

export async function updateEventCalendars(
  id: string,
  calendarIds: string[],
  rev: number,
): Promise<CalendarEventDto> {
  const data = await request<{ event: CalendarEventDto }>(`/api/calendar/events/${entity(id)}`, {
    method: 'PATCH',
    body: { calendarIds, rev },
  })
  return data.event
}

export function deleteEvent(id: string, rev: number): Promise<void> {
  return request<void>(`/api/calendar/events/${entity(id)}?rev=${encodeURIComponent(String(rev))}`, { method: 'DELETE' })
}

export async function createCalendar(input: CalendarCreateInput): Promise<CalendarDto | null> {
  const data = await request<{ calendar?: CalendarDto }>('/api/calendar/calendars', { method: 'POST', body: input })
  return data?.calendar ?? null
}

export async function updateCalendar(id: string, patch: CalendarPatchInput, rev: number): Promise<CalendarDto> {
  const data = await request<{ calendar: CalendarDto }>(`/api/calendar/calendars/${entity(id)}`, {
    method: 'PATCH',
    body: { ...patch, rev },
  })
  return data.calendar
}

export function deleteCalendar(
  id: string,
  mode: { kind: 'delete'; rev: number } | { kind: 'merge'; targetId: string },
): Promise<void> {
  const params = mode.kind === 'delete'
    ? `mode=delete&rev=${encodeURIComponent(String(mode.rev))}`
    : `mode=merge&targetId=${encodeURIComponent(mode.targetId)}`
  return request<void>(`/api/calendar/calendars/${entity(id)}?${params}`, { method: 'DELETE' })
}

export function reorderCalendars(ids: string[]): Promise<void> {
  return request<void>('/api/calendar/calendars/order', { method: 'PUT', body: { ids } })
}

export async function createGroup(name: string): Promise<CalendarGroupDto | null> {
  const data = await request<{ group?: CalendarGroupDto }>('/api/calendar/groups', { method: 'POST', body: { name } })
  return data?.group ?? null
}

export function renameGroup(id: string, name: string): Promise<void> {
  return request<void>(`/api/calendar/groups/${entity(id)}`, { method: 'PATCH', body: { name } })
}

export function deleteGroup(id: string): Promise<void> {
  return request<void>(`/api/calendar/groups/${entity(id)}`, { method: 'DELETE' })
}

export function reorderGroups(ids: string[]): Promise<void> {
  return request<void>('/api/calendar/groups/order', { method: 'PUT', body: { ids } })
}

export function putPreferences(preferences: CalendarPreferences): Promise<void> {
  return request<void>('/api/calendar/preferences', { method: 'PUT', body: { preferences } })
}

export function importIcs(input: {
  content: string
  targetCalendarId?: string
  newCalendar?: { name: string; color: string }
  defaultTimeZone: string
}): Promise<IcsImportResponse> {
  return request<IcsImportResponse>('/api/calendar/ics/import', {
    method: 'POST',
    body: {
      content: input.content,
      ...(input.targetCalendarId ? { calendarId: input.targetCalendarId } : {}),
      ...(input.newCalendar ? { newCalendar: input.newCalendar } : {}),
      defaultTimeZone: input.defaultTimeZone,
    },
  })
}

/** The export is a calendar document, not JSON; `request` hands back the body as text. */
export function exportIcs(calendarId: string): Promise<string> {
  return request<string>(`/api/calendar/ics/export?calendarId=${entity(calendarId)}`)
}

export interface SubscriptionCreateResponse {
  calendarId: string
  imported: number
  warnings: Array<{ code: string; message: string }>
}

export function createSubscription(input: SubscriptionInput): Promise<SubscriptionCreateResponse> {
  return request<SubscriptionCreateResponse>('/api/calendar/subscriptions', { method: 'POST', body: input })
}

export function refreshSubscription(id: string): Promise<{ imported: number; removed: number; lastSyncAt: number }> {
  return request(`/api/calendar/subscriptions/${entity(id)}/refresh`, { method: 'POST' })
}

export function setSubscriptionEnabled(id: string, enabled: boolean): Promise<void> {
  return request<void>(`/api/calendar/subscriptions/${entity(id)}`, { method: 'PATCH', body: { enabled } })
}

export function deleteSubscription(id: string): Promise<void> {
  return request<void>(`/api/calendar/subscriptions/${entity(id)}`, { method: 'DELETE' })
}

export interface CalDavConnectionInput {
  preset: 'custom' | 'icloud' | 'nextcloud' | 'radicale' | 'fastmail'
  serverUrl?: string
  username: string
  password: string
  label?: string
  writable: boolean
}

export function listConnections(): Promise<{ connections: CalendarConnectionDto[] }> {
  return request<{ connections: CalendarConnectionDto[] }>('/api/calendar/connections')
}

export function createCalDavConnection(input: CalDavConnectionInput): Promise<{ connection: CalendarConnectionDto }> {
  return request<{ connection: CalendarConnectionDto }>('/api/calendar/connections', {
    method: 'POST',
    body: { kind: 'caldav', ...input },
  })
}

export function startConnectionOAuth(
  provider: Exclude<CalendarConnectionKind, 'caldav'>,
  writable: boolean,
): Promise<{ url: string }> {
  return request<{ url: string }>('/api/calendar/connections/oauth/start', {
    method: 'POST',
    body: { provider, writable, redirectTo: '/calendar' },
  })
}

export interface ProxyRequest {
  method: string
  path: string
  headers?: Record<string, string>
  body?: string
}

export interface ProxyResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export function proxyCalendar(connectionId: string, input: ProxyRequest, signal?: AbortSignal): Promise<ProxyResponse> {
  return request<ProxyResponse>(`/api/calendar/connections/${entity(connectionId)}/proxy`, {
    method: 'POST',
    body: input,
    signal,
  })
}

export function reportConnectionStatus(
  connectionId: string,
  state: CalendarConnectionDto['status'],
  lastSyncedAt?: number,
  errorCode?: string | null,
): Promise<void> {
  return request<void>(`/api/calendar/connections/${entity(connectionId)}/status`, {
    method: 'POST',
    body: {
      state,
      ...(lastSyncedAt === undefined ? {} : { lastSyncedAt }),
      ...(errorCode === undefined ? {} : { errorCode }),
    },
  })
}

export function reportConnectionCalendars(
  connectionId: string,
  calendars: Array<{ remoteId: string; localId: string }>,
): Promise<{ mapped: number }> {
  return request<{ mapped: number }>(`/api/calendar/connections/${entity(connectionId)}/calendars`, {
    method: 'POST',
    body: { calendars },
  })
}

export function deleteConnection(connectionId: string): Promise<void> {
  return request<void>(`/api/calendar/connections/${entity(connectionId)}`, { method: 'DELETE' })
}

/**
 * The calendar app's API client. Every call goes through the shell's `request` so the client header,
 * locale, error translation and 204 handling stay one implementation.
 */
import { ApiError, request } from '../../lib/api'
import type {
  CalendarAttachmentDto,
  CalendarAttendeeDto,
  CalendarBusyBlock,
  CalendarConnectionDto,
  CalendarConnectionKind,
  CalendarContactDto,
  CalendarDto,
  CalendarEventDto,
  CalendarEventInput,
  CalendarGroupDto,
  CalendarMemberDto,
  CalendarMetaDto,
  CalendarPreferences,
  CalendarRangeRevisionDto,
  CalendarResourceDto,
  CalendarSchedulingLinkDto,
  CalendarSearchResultDto,
  CalendarShareDto,
  CalendarSource,
  CalendarTemplateDto,
  TemporalValue,
} from '@shared/calendar/model'

export interface EventRangeQuery {
  from: number
  to: number
  calendarIds?: string[]
  /** Month view expands recurring series in the library; it can skip the server's copy. */
  includeOccurrences?: boolean
  /** Expand only these masters (the month view's exception series). */
  occurrenceMasters?: string[]
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
  icon?: string | null
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
  warnings?: Array<{ code: string; message: string; line?: number; uid?: string }>
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
  if (query.occurrenceMasters?.length) params.set('occurrenceMasters', query.occurrenceMasters.join(','))
  if (query.includeOccurrences === false) params.set('occurrences', '0')
  return params.toString()
}

export function getMeta(defaultCalendarName?: string, signal?: AbortSignal): Promise<CalendarMetaDto> {
  const query = defaultCalendarName ? `?defaultName=${encodeURIComponent(defaultCalendarName)}` : ''
  return request<CalendarMetaDto>(`/api/calendar/meta${query}`, { signal })
}

export interface EventRangeResponse {
  events: CalendarEventDto[]
  occurrences: CalendarEventDto[]
  truncated: boolean
  recurrenceTruncated: boolean
  /** Null when the answer did not carry one; a range without a fingerprint is neither cached nor probed. */
  revision: CalendarRangeRevisionDto | null
}

export async function getEvents(query: EventRangeQuery, signal?: AbortSignal): Promise<EventRangeResponse> {
  const data = await request<{
    events: CalendarEventDto[]
    occurrences?: CalendarEventDto[]
    truncated?: boolean
    recurrenceTruncated?: boolean
    revision?: CalendarRangeRevisionDto
  }>(`/api/calendar/events?${rangeQuery(query)}`, { signal })
  return {
    events: data.events,
    occurrences: data.occurrences ?? [],
    truncated: data.truncated === true,
    recurrenceTruncated: data.recurrenceTruncated === true,
    revision: data.revision ?? null,
  }
}

/** The fingerprint of a range, one small read instead of the rows. */
export async function getEventsRevision(
  query: EventRangeQuery,
  signal?: AbortSignal,
): Promise<CalendarRangeRevisionDto> {
  const data = await request<{ revision: CalendarRangeRevisionDto }>(
    `/api/calendar/events/revision?${rangeQuery(query)}`,
    { signal },
  )
  return data.revision
}

export interface EventSearchFilters {
  calendarIds?: string[]
  from?: number
  to?: number
  kind?: 'event' | 'task'
  attendee?: string
  location?: string
  recurring?: boolean
  taskStatus?: 'open' | 'done'
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
  if (filters.attendee?.trim()) params.set('attendee', filters.attendee.trim())
  if (filters.location?.trim()) params.set('location', filters.location.trim())
  if (filters.recurring !== undefined) params.set('recurring', filters.recurring ? '1' : '0')
  if (filters.taskStatus) params.set('taskStatus', filters.taskStatus)
  return request<EventSearchResponse>(`/api/calendar/events/search?${params.toString()}`, { signal })
}

/** One row as the server has it now, or null when it no longer exists. */
export async function getEvent(id: string): Promise<CalendarEventDto | null> {
  try {
    const data = await request<{ event: CalendarEventDto }>(`/api/calendar/events/${entity(id)}`)
    return data.event
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

export interface EventExtrasResponse {
  event: CalendarEventDto
  reminders: number[]
  attendees: CalendarAttendeeDto[]
  attachments: CalendarAttachmentDto[]
}

/** One read for the sidebar card: reminders, guests and files all belong to one event. */
export async function getEventExtras(id: string): Promise<EventExtrasResponse | null> {
  try {
    return await request<EventExtrasResponse>(`/api/calendar/events/${entity(id)}/extras`)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

export async function getEventReminders(id: string): Promise<number[]> {
  const data = await request<{ minutes: number[] }>(`/api/calendar/events/${entity(id)}/reminders`)
  return Array.isArray(data.minutes) ? data.minutes : []
}

export async function setEventReminders(
  id: string,
  minutes: readonly number[],
  rev: number,
): Promise<{ event: CalendarEventDto; reminders: number[] }> {
  return request<{ event: CalendarEventDto; reminders: number[] }>(
    `/api/calendar/events/${entity(id)}/reminders`,
    { method: 'PUT', body: { minutes: [...minutes], rev } },
  )
}

export async function getEventAttendees(id: string): Promise<CalendarAttendeeDto[]> {
  const data = await request<{ attendees: CalendarAttendeeDto[] }>(`/api/calendar/events/${entity(id)}/attendees`)
  return Array.isArray(data.attendees) ? data.attendees : []
}

export async function setEventAttendees(
  id: string,
  attendees: readonly CalendarAttendeeDto[],
  rev: number,
): Promise<{ event: CalendarEventDto; attendees: CalendarAttendeeDto[] }> {
  return request<{ event: CalendarEventDto; attendees: CalendarAttendeeDto[] }>(
    `/api/calendar/events/${entity(id)}/attendees`,
    { method: 'PUT', body: { attendees, rev } },
  )
}

export async function getEventAttachments(id: string): Promise<CalendarAttachmentDto[]> {
  const data = await request<{ attachments: CalendarAttachmentDto[] }>(`/api/calendar/events/${entity(id)}/attachments`)
  return Array.isArray(data.attachments) ? data.attachments : []
}

/** One multipart field named `file`; every limit and every check is the route's to decide. */
export async function uploadEventAttachment(id: string, file: File): Promise<CalendarAttachmentDto> {
  const form = new FormData()
  form.set('file', file)
  const data = await request<{ attachment: CalendarAttachmentDto }>(
    `/api/calendar/events/${entity(id)}/attachments`,
    { method: 'POST', formData: form },
  )
  return data.attachment
}

export function removeEventAttachment(id: string, attachmentId: string): Promise<void> {
  return request<void>(`/api/calendar/events/${entity(id)}/attachments/${entity(attachmentId)}`, {
    method: 'DELETE',
  })
}

export async function createEvent(event: CalendarEventInput): Promise<CalendarEventDto> {  const data = await request<{ event: CalendarEventDto }>('/api/calendar/events', { method: 'POST', body: event })
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

/** A partial PATCH for fields the extras card owns without re-sending the whole event. */
export async function updateEventPatch(
  id: string,
  patch: Partial<CalendarEventInput>,
  rev: number,
): Promise<CalendarEventDto> {
  const data = await request<{ event: CalendarEventDto }>(`/api/calendar/events/${entity(id)}`, {
    method: 'PATCH',
    body: { ...patch, rev },
  })
  return data.event
}

export interface RecurrenceChangeBody {
  occurrenceStart: TemporalValue
  occurrenceEnd: TemporalValue
  scope: 'this' | 'following' | 'all'
  action: 'update' | 'cancel'
  patch?: Partial<CalendarEventInput>
}

export function applyRecurrenceChange(
  masterId: string,
  change: RecurrenceChangeBody,
): Promise<{ masterId: string | null }> {
  return request(`/api/calendar/events/${entity(masterId)}/recurrence`, {
    method: 'POST',
    body: change,
  })
}

export function snoozeEvent(id: string, minutes: number): Promise<{ notifyAt: number }> {
  return request(`/api/calendar/events/${entity(id)}/snooze`, {
    method: 'POST',
    body: { minutes },
  })
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

export function importCsv(input: {
  content: string
  targetCalendarId?: string
  newCalendar?: { name: string; color: string }
}): Promise<IcsImportResponse> {
  return request<IcsImportResponse>('/api/calendar/csv/import', {
    method: 'POST',
    body: input,
  })
}

/** The export is a calendar document, not JSON; `request` hands back the body as text. */
export function exportIcs(calendarId: string): Promise<string> {
  return request<string>(`/api/calendar/ics/export?calendarId=${entity(calendarId)}`)
}

/** The calendar's public link, or null while it has never been shared. */
export async function getCalendarShare(calendarId: string): Promise<CalendarShareDto | null> {
  const data = await request<{ share: CalendarShareDto | null }>(`/api/calendar/calendars/${entity(calendarId)}/share`)
  return data.share ?? null
}

/** Publish, or return the address the calendar already has. */
export function shareCalendar(calendarId: string): Promise<CalendarShareDto> {
  return request<{ share: CalendarShareDto }>(`/api/calendar/calendars/${entity(calendarId)}/share`, {
    method: 'POST',
  }).then(data => data.share)
}

export function unshareCalendar(calendarId: string): Promise<void> {
  return request<void>(`/api/calendar/calendars/${entity(calendarId)}/share`, { method: 'DELETE' })
}

export interface SubscriptionCreateResponse {
  calendarId: string
  imported: number
  warnings: Array<{ code: string; message: string; line?: number; uid?: string }>
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

// ------------------------------------------------------------- contacts, birthdays, holidays

export async function getContacts(query = ''): Promise<CalendarContactDto[]> {
  const data = await request<{ contacts: CalendarContactDto[] }>(
    `/api/calendar/contacts${query ? `?q=${encodeURIComponent(query)}` : ''}`,
  )
  return data.contacts
}

export async function createContact(input: {
  name: string
  email: string
  birthday: string | null
}): Promise<CalendarContactDto> {
  return (await request<{ contact: CalendarContactDto }>('/api/calendar/contacts', {
    method: 'POST',
    body: input,
  })).contact
}

export async function updateContact(
  id: string,
  input: { name: string; email: string; birthday: string | null; rev: number },
): Promise<CalendarContactDto> {
  return (await request<{ contact: CalendarContactDto }>(`/api/calendar/contacts/${entity(id)}`, {
    method: 'PATCH',
    body: input,
  })).contact
}

export function deleteContact(id: string): Promise<void> {
  return request<void>(`/api/calendar/contacts/${entity(id)}`, { method: 'DELETE' })
}

export function syncBirthdays(input: { calendarName: string; titleTemplate: string }): Promise<{
  calendarId: string
  imported: number
  removed: number
}> {
  return request('/api/calendar/birthdays/sync', { method: 'POST', body: input })
}

export function addHolidays(input: {
  calendarName: string
  holidays: Array<{ date: string; title: string }>
}): Promise<{ calendarId: string; imported: number }> {
  return request('/api/calendar/holidays', { method: 'POST', body: input })
}

// ------------------------------------------------------------- event templates

export async function getTemplates(): Promise<CalendarTemplateDto[]> {
  return (await request<{ templates: CalendarTemplateDto[] }>('/api/calendar/templates')).templates
}

export async function createTemplate(input: Omit<CalendarTemplateDto, 'id' | 'rev'>): Promise<CalendarTemplateDto> {
  return (await request<{ template: CalendarTemplateDto }>('/api/calendar/templates', {
    method: 'POST',
    body: input,
  })).template
}

export async function updateTemplate(template: CalendarTemplateDto): Promise<CalendarTemplateDto> {
  return (await request<{ template: CalendarTemplateDto }>(`/api/calendar/templates/${entity(template.id)}`, {
    method: 'PATCH',
    body: template,
  })).template
}

export function deleteTemplate(id: string): Promise<void> {
  return request<void>(`/api/calendar/templates/${entity(id)}`, { method: 'DELETE' })
}


export async function getCalendarMembers(calendarId: string): Promise<CalendarMemberDto[]> {
  return (await request<{ members: CalendarMemberDto[] }>(`/api/calendar/calendars/${entity(calendarId)}/members`)).members
}

export function addCalendarMember(
  calendarId: string,
  input: { username: string, role: 'reader' | 'writer' },
): Promise<{ member: CalendarMemberDto }> {
  return request(`/api/calendar/calendars/${entity(calendarId)}/members`, { method: 'POST', body: input })
}

export function removeCalendarMember(calendarId: string, memberId: string): Promise<void> {
  return request<void>(`/api/calendar/calendars/${entity(calendarId)}/members/${entity(memberId)}`, { method: 'DELETE' })
}

export async function getResources(): Promise<CalendarResourceDto[]> {
  return (await request<{ resources: CalendarResourceDto[] }>('/api/calendar/resources')).resources
}

export async function createResource(input: { name: string, capacity?: number | null, color?: string }): Promise<CalendarResourceDto> {
  return (await request<{ resource: CalendarResourceDto }>('/api/calendar/resources', { method: 'POST', body: input })).resource
}

export async function updateResource(id: string, patch: { name?: string, capacity?: number | null }): Promise<CalendarResourceDto> {
  return (await request<{ resource: CalendarResourceDto }>(`/api/calendar/resources/${entity(id)}`, { method: 'PATCH', body: patch })).resource
}

export function deleteResource(id: string): Promise<void> {
  return request<void>(`/api/calendar/resources/${entity(id)}`, { method: 'DELETE' })
}

export async function getSchedulingLinks(): Promise<CalendarSchedulingLinkDto[]> {
  return (await request<{ links: CalendarSchedulingLinkDto[] }>('/api/calendar/scheduling-links')).links
}

export interface SchedulingLinkInput {
  calendarId: string
  title: string
  durationMinutes: number
  days: number[]
  startHour: number
  endHour: number
}

export function createSchedulingLink(input: SchedulingLinkInput): Promise<CalendarSchedulingLinkDto> {
  return request<{ link: CalendarSchedulingLinkDto }>('/api/calendar/scheduling-links', { method: 'POST', body: input })
    .then(answer => answer.link)
}

export function updateSchedulingLink(
  id: string,
  patch: Partial<Omit<SchedulingLinkInput, 'calendarId'>> & { enabled?: boolean },
): Promise<CalendarSchedulingLinkDto> {
  return request<{ link: CalendarSchedulingLinkDto }>(`/api/calendar/scheduling-links/${entity(id)}`, { method: 'PATCH', body: patch })
    .then(answer => answer.link)
}

export function deleteSchedulingLink(id: string): Promise<void> {
  return request<void>(`/api/calendar/scheduling-links/${entity(id)}`, { method: 'DELETE' })
}

export function leaveSharedCalendar(ownerId: string, calendarId: string): Promise<void> {
  return request<void>(`/api/calendar/invites/${entity(ownerId)}/${entity(calendarId)}`, { method: 'DELETE' })
}

export function respondInvite(ownerId: string, calendarId: string, status: 'accepted' | 'declined'): Promise<void> {
  return request<void>(`/api/calendar/invites/${entity(ownerId)}/${entity(calendarId)}/response`, {
    method: 'POST',
    body: { status },
  })
}

export function getFreeBusy(input: {
  from: number
  to: number
  calendarIds?: string[]
}): Promise<{ busy: CalendarBusyBlock[], truncated: boolean }> {
  const params = new URLSearchParams({
    from: new Date(input.from).toISOString(),
    to: new Date(input.to).toISOString(),
  })
  if (input.calendarIds?.length) params.set('calendarIds', input.calendarIds.join(','))
  return request(`/api/calendar/free-busy?${params.toString()}`)
}

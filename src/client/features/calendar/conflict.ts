/**
 * Comparing the two versions of an event a write conflict landed between.
 *
 * A refused PATCH means somebody else — another tab, a phone, a provider sync — wrote the same event
 * first, and the queue used to answer that by reloading and losing whatever was just typed. This module
 * turns the two shapes into one comparable list of the parts a person can actually decide about, and
 * then builds the patched event from those decisions. Everything else on the row, including the
 * metadata a provider needs to keep recognising it, comes from the server copy.
 */
import type { CalendarEventDto, CalendarEventInput, TemporalValue } from '@shared/calendar/model'
import { temporalValueToEpochMs } from '@shared/calendar/model'
import { t } from '../../lib/i18n'

export type ConflictFieldKey =
  | 'title'
  | 'time'
  | 'recurrence'
  | 'calendars'
  | 'description'
  | 'location'
  | 'categories'
  | 'meeting'

export type ConflictChoice = 'mine' | 'theirs'

export interface ConflictField {
  key: ConflictFieldKey
  label: string
  mine: string
  theirs: string
  differs: boolean
}

export interface ConflictView {
  locale: string
  timeZone: string
  calendarNames: ReadonlyMap<string, string>
}

const KEYS: readonly ConflictFieldKey[] = [
  'title', 'time', 'recurrence', 'calendars', 'description', 'location', 'categories', 'meeting',
]

function labels(): Record<ConflictFieldKey, string> {
  return {
    title: t('calendar.conflict.title'),
    time: t('calendar.conflict.time'),
    recurrence: t('calendar.conflict.recurrence'),
    calendars: t('calendar.conflict.calendars'),
    description: t('calendar.conflict.description'),
    location: t('calendar.conflict.location'),
    categories: t('calendar.conflict.categories'),
    meeting: t('calendar.conflict.meeting'),
  }
}

function fromDto(dto: CalendarEventDto): CalendarEventInput {
  return {
    id: dto.id,
    title: dto.title,
    description: dto.description,
    kind: dto.kind,
    task: dto.task,
    conference: dto.conference,
    start: dto.start,
    end: dto.end,
    allDay: dto.allDay,
    calendarId: dto.calendarId,
    calendarIds: [...dto.calendarIds],
    meta: { ...dto.meta },
    icon: dto.icon,
    recurrenceRule: dto.recurrenceRule,
  }
}

function calendarIdsOf(side: CalendarEventInput): string[] {
  const ids = side.calendarIds?.length ? side.calendarIds : [side.calendarId ?? '']
  return ids.filter((id) => id.length > 0)
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function categoriesOf(side: CalendarEventInput): string[] {
  const raw = side.meta?.categories
  return Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
}

function meetingOf(side: CalendarEventInput): string {
  return (side.conference?.joinUrl ?? textOf(side.meta?.url)).trim()
}

function ruleOf(side: CalendarEventInput): string {
  return (side.recurrenceRule ?? textOf(side.meta?.recurrenceRule)).replace(/^RRULE:/i, '').trim()
}

function dayText(value: TemporalValue, view: ConflictView): string {
  if (value.type === 'date') {
    const parts = value.value.slice(0, 10).split('-').map(Number)
    const utc = Date.UTC(parts[0] ?? 1970, (parts[1] ?? 1) - 1, parts[2] ?? 1)
    return new Intl.DateTimeFormat(view.locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(utc))
  }
  const moment = new Date(temporalValueToEpochMs(value, view.timeZone))
  return new Intl.DateTimeFormat(view.locale, { dateStyle: 'medium', timeZone: view.timeZone }).format(moment)
}

function clockText(value: TemporalValue, view: ConflictView): string {
  const moment = new Date(temporalValueToEpochMs(value, view.timeZone))
  return new Intl.DateTimeFormat(view.locale, { timeStyle: 'short', timeZone: view.timeZone }).format(moment)
}

function timeText(side: CalendarEventInput, view: ConflictView): string {
  if (side.allDay || side.start.type === 'date') {
    const start = dayText(side.start, view)
    const end = dayText(side.end, view)
    return start === end ? start : `${start} – ${end}`
  }
  const startDay = dayText(side.start, view)
  const endDay = dayText(side.end, view)
  const start = `${startDay} ${clockText(side.start, view)}`
  if (startDay === endDay) return `${start} – ${clockText(side.end, view)}`
  return `${start} – ${endDay} ${clockText(side.end, view)}`
}

function calendarsText(side: CalendarEventInput, view: ConflictView): string {
  const list = new Intl.ListFormat(view.locale, { style: 'short', type: 'conjunction' })
  return list.format(calendarIdsOf(side).map((id) => view.calendarNames.get(id) ?? id))
}

function categoriesText(side: CalendarEventInput, view: ConflictView): string {
  const entries = categoriesOf(side)
  if (entries.length === 0) return t('calendar.conflict.unset')
  return new Intl.ListFormat(view.locale, { style: 'short', type: 'conjunction' }).format(entries)
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const sorted = [...left].sort()
  const other = [...right].sort()
  return sorted.every((entry, index) => entry === other[index])
}

function sameTime(left: CalendarEventInput, right: CalendarEventInput): boolean {
  return left.start.value === right.start.value
    && left.start.type === right.start.type
    && left.end.value === right.end.value
    && left.end.type === right.end.type
}

function describe(key: ConflictFieldKey, mine: CalendarEventInput, theirs: CalendarEventInput, view: ConflictView): ConflictField {
  const label = labels()[key]
  switch (key) {
    case 'title':
      return { key, label, mine: mine.title, theirs: theirs.title, differs: mine.title !== theirs.title }
    case 'time':
      return {
        key,
        label,
        mine: timeText(mine, view),
        theirs: timeText(theirs, view),
        differs: !sameTime(mine, theirs),
      }
    case 'recurrence': {
      const mineRule = ruleOf(mine)
      const theirsRule = ruleOf(theirs)
      return {
        key,
        label,
        mine: mineRule || t('calendar.conflict.none'),
        theirs: theirsRule || t('calendar.conflict.none'),
        differs: mineRule !== theirsRule,
      }
    }
    case 'calendars': {
      const mineIds = calendarIdsOf(mine)
      const theirsIds = calendarIdsOf(theirs)
      return {
        key,
        label,
        mine: calendarsText(mine, view),
        theirs: calendarsText(theirs, view),
        differs: !sameSet(mineIds, theirsIds),
      }
    }
    case 'description': {
      const mineText = mine.description ?? ''
      const theirsText = theirs.description ?? ''
      return { key, label, mine: mineText, theirs: theirsText, differs: mineText !== theirsText }
    }
    case 'location': {
      const mineText = textOf(mine.meta?.location)
      const theirsText = textOf(theirs.meta?.location)
      const blank = t('calendar.conflict.unset')
      return {
        key,
        label,
        mine: mineText || blank,
        theirs: theirsText || blank,
        differs: mineText !== theirsText,
      }
    }
    case 'categories': {
      const mineList = categoriesOf(mine)
      const theirsList = categoriesOf(theirs)
      return {
        key,
        label,
        mine: categoriesText(mine, view),
        theirs: categoriesText(theirs, view),
        differs: !sameSet(mineList, theirsList),
      }
    }
    case 'meeting': {
      const mineUrl = meetingOf(mine)
      const theirsUrl = meetingOf(theirs)
      const blank = t('calendar.conflict.unset')
      return {
        key,
        label,
        mine: mineUrl || blank,
        theirs: theirsUrl || blank,
        differs: mineUrl !== theirsUrl,
      }
    }
  }
}

export function conflictFields(
  mine: CalendarEventInput,
  theirs: CalendarEventDto,
  view: ConflictView,
): ConflictField[] {
  const serverCopy = fromDto(theirs)
  return KEYS.map((key) => describe(key, mine, serverCopy, view))
}

/** The event to send: the server's row, with the parts the reader chose taken from their own copy. */
export function mergeConflict(
  mine: CalendarEventInput,
  theirs: CalendarEventDto,
  picks: Partial<Record<ConflictFieldKey, ConflictChoice>>,
): CalendarEventInput {
  const serverCopy = fromDto(theirs)
  const side = (key: ConflictFieldKey): CalendarEventInput =>
    picks[key] === 'mine' ? mine : serverCopy
  const meta: Record<string, unknown> = { ...serverCopy.meta }
  const merged: CalendarEventInput = { ...serverCopy, meta }

  merged.title = side('title').title
  const time = side('time')
  merged.start = time.start
  merged.end = time.end
  merged.allDay = time.start.type === 'date'
  merged.recurrenceRule = ruleOf(side('recurrence')) || null

  const calendarIds = calendarIdsOf(side('calendars'))
  merged.calendarIds = calendarIds
  merged.calendarId = calendarIds[0] ?? serverCopy.calendarId

  merged.description = side('description').description ?? ''

  const location = textOf(side('location').meta?.location)
  if (location) meta.location = location
  else delete meta.location

  const categories = categoriesOf(side('categories'))
  if (categories.length > 0) meta.categories = categories
  else delete meta.categories

  const meeting = side('meeting')
  const url = textOf(meeting.meta?.url)
  if (url) meta.url = url
  else delete meta.url
  merged.conference = meeting.conference ?? null

  return merged
}

import { Temporal } from 'temporal-polyfill'
import type { Event } from '@dayflow/react'
import { temporalToEpochMs } from '@shared/calendar/model'
import { toEventUpdates } from './model'

export type EventUpdate = { id: string; updates: Partial<Event> }

function zoneOf(value: Event['start'], fallback: string): string {
  return value instanceof Temporal.ZonedDateTime ? value.timeZoneId : fallback
}

function shiftZoned(value: Event['start'], deltaMs: number, fallback: string): Temporal.ZonedDateTime | Temporal.PlainDateTime {
  const zone = zoneOf(value, fallback)
  const moved = Temporal.Instant.fromEpochMilliseconds(temporalToEpochMs(value, fallback) + deltaMs).toZonedDateTimeISO(zone)
  return value instanceof Temporal.PlainDateTime ? moved.toPlainDateTime() : moved
}

export function batchColorUpdates(events: readonly Event[], color: string): EventUpdate[] {
  return events.map(event => ({
    id: event.id,
    updates: toEventUpdates({ ...event, meta: { ...event.meta, color } }),
  }))
}

export function batchMoveUpdates(
  events: readonly Event[],
  targetDate: string,
  targetTime: string,
  timeZone: string,
): EventUpdate[] {
  if (events.length === 0) return []
  const first = events[0]!
  const allDay = first.allDay || first.start instanceof Temporal.PlainDate
  if (events.some(event => (event.allDay || event.start instanceof Temporal.PlainDate) !== allDay)) {
    throw new Error('mixed')
  }
  if (allDay) {
    const target = Temporal.PlainDate.from(targetDate)
    const origin = Temporal.PlainDate.from(first.start.toString())
    const days = target.since(origin).days
    return events.map(event => ({
      id: event.id,
      updates: toEventUpdates({
        ...event,
        start: Temporal.PlainDate.from(event.start.toString()).add({ days }),
        end: Temporal.PlainDate.from(event.end.toString()).add({ days }),
      }),
    }))
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(targetTime)) throw new Error('invalid_time')
  const [year, month, day] = targetDate.split('-').map(Number) as [number, number, number]
  const [hour, minute] = targetTime.split(':').map(Number) as [number, number]
  const target = Temporal.ZonedDateTime.from({ timeZone, year, month, day, hour, minute })
  const deltaMs = target.epochMilliseconds - temporalToEpochMs(first.start, timeZone)
  return events.map(event => ({
    id: event.id,
    updates: toEventUpdates({
      ...event,
      start: shiftZoned(event.start, deltaMs, timeZone),
      end: shiftZoned(event.end, deltaMs, timeZone),
    }),
  }))
}

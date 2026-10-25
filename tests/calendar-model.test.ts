import { Temporal } from 'temporal-polyfill'
import { describe, expect, it } from 'vitest'
import {
  containsSecretMetaKey,
  defaultCalendarPreferences,
  isCalendarEntityId,
  normalizeCalendarPreferences,
  parseTemporalValue,
  temporalToEpochMs,
  temporalValueToEpochMs,
  toTemporalValue,
} from '../src/shared/calendar/model'

describe('calendar model', () => {
  it('accepts local, CalDAV and provider calendar ids, and refuses render-only ids', () => {
    expect(isCalendarEntityId('m7f2k1abc')).toBe(true)
    expect(isCalendarEntityId('caldav:work%2Fteam:uid%40example.com')).toBe(true)
    expect(isCalendarEntityId('en.usa#holiday@group.v.calendar.google.com')).toBe(true)
    expect(isCalendarEntityId('event::repeat-2026-10-26')).toBe(false)
    expect(isCalendarEntityId('../notes')).toBe(false)
    expect(isCalendarEntityId('has space')).toBe(false)
    expect(isCalendarEntityId('')).toBe(false)
  })

  it('round-trips every Temporal shape without changing its kind', () => {
    const date = Temporal.PlainDate.from('2026-10-26')
    const datetime = Temporal.PlainDateTime.from('2026-10-26T09:30:00')
    const zoned = Temporal.ZonedDateTime.from('2026-10-26T09:30:00+08:00[Asia/Shanghai]')

    expect(toTemporalValue(date)).toEqual({ value: '2026-10-26', type: 'date' })
    expect(toTemporalValue(datetime)).toEqual({ value: '2026-10-26T09:30:00', type: 'datetime' })
    expect(toTemporalValue(zoned)).toEqual({
      value: '2026-10-26T09:30:00+08:00[Asia/Shanghai]',
      type: 'zoned',
      timeZone: 'Asia/Shanghai',
    })
    expect(parseTemporalValue(toTemporalValue(date)).toString()).toBe(date.toString())
    expect(parseTemporalValue(toTemporalValue(datetime)).toString()).toBe(datetime.toString())
    expect(parseTemporalValue(toTemporalValue(zoned)).toString()).toBe(zoned.toString())
  })

  it('derives instants using the event zone, including across a DST spring-forward', () => {
    const before = Temporal.PlainDateTime.from('2026-03-08T01:30:00')
    const after = Temporal.PlainDateTime.from('2026-03-08T03:30:00')
    const beforeMs = temporalToEpochMs(before, 'America/New_York')
    const afterMs = temporalToEpochMs(after, 'America/New_York')
    expect(afterMs - beforeMs).toBe(60 * 60 * 1000)
    expect(temporalValueToEpochMs(
      { value: '2026-03-08', type: 'date' },
      'America/New_York',
    )).toBe(Temporal.ZonedDateTime.from({
      timeZone: 'America/New_York',
      year: 2026,
      month: 3,
      day: 8,
      hour: 0,
      minute: 0,
      second: 0,
    }).epochMilliseconds)
  })

  it('merges preferences with defaults and rejects out-of-range values', () => {
    const defaults = defaultCalendarPreferences()
    const preferences = normalizeCalendarPreferences({
      ...defaults,
      defaultView: 'agenda',
      weekStart: 9,
      timeFormat: '12h',
      dayHourHeight: 4,
      showWeekends: false,
    })
    expect(preferences.defaultView).toBe('agenda')
    expect(preferences.weekStart).toBe(defaults.weekStart)
    expect(preferences.timeFormat).toBe('12h')
    expect(preferences.dayHourHeight).toBe(defaults.dayHourHeight)
    expect(preferences.showWeekends).toBe(false)
  })

  it('keeps the year and agenda view preferences DayFlow exposes', () => {
    const defaults = defaultCalendarPreferences()
    expect(defaults).toMatchObject({
      yearViewMode: 'year-canvas',
      yearShowTimedEvents: false,
      yearHeatmapLevels: 5,
      agendaDays: 14,
      agendaShowEmptyDays: true,
    })

    const prefs = normalizeCalendarPreferences({
      ...defaults,
      yearViewMode: 'grid',
      yearShowTimedEvents: true,
      yearHeatmapLevels: 7,
      agendaDays: 30,
      agendaShowEmptyDays: false,
    })
    expect(prefs).toMatchObject({
      yearViewMode: 'grid',
      yearShowTimedEvents: true,
      yearHeatmapLevels: 7,
      agendaDays: 30,
      agendaShowEmptyDays: false,
    })

    const invalid = normalizeCalendarPreferences({
      ...defaults,
      yearViewMode: 'timeline',
      yearHeatmapLevels: 12,
      agendaDays: 0,
      agendaShowEmptyDays: 'yes',
    })
    expect(invalid.yearViewMode).toBe(defaults.yearViewMode)
    expect(invalid.yearHeatmapLevels).toBe(defaults.yearHeatmapLevels)
    expect(invalid.agendaDays).toBe(defaults.agendaDays)
    expect(invalid.agendaShowEmptyDays).toBe(defaults.agendaShowEmptyDays)
  })

  it('finds secret-shaped metadata keys recursively', () => {
    expect(containsSecretMetaKey({ nested: { refresh_token: 'x' } })).toBe(true)
    expect(containsSecretMetaKey({ list: [{ Authorization: 'x' }] })).toBe(true)
    expect(containsSecretMetaKey({ location: 'Room 1', recurrenceRule: 'FREQ=DAILY' })).toBe(false)
  })
})

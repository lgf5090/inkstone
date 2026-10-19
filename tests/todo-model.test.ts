import { describe, expect, it } from 'vitest'
import { getZonedParts } from '../src/shared/assistant-schedule'
import {
  MAX_TAGS_PER_TASK,
  isTaskView,
  nextOccurrence,
  normalizeTagNames,
  parseRepeatRule,
  remindAtFor,
  taskListProgress,
  toggledStatus,
} from '../src/shared/todos/model'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function utc(text: string): number {
  return Date.parse(text)
}

describe('a stored repeat rule', () => {
  it('reads the shape this app writes', () => {
    expect(parseRepeatRule({ freq: 'weekly', interval: 2 })).toEqual({ freq: 'weekly', interval: 2 })
  })

  it('defaults a missing interval to one', () => {
    expect(parseRepeatRule({ freq: 'daily' })).toEqual({ freq: 'daily', interval: 1 })
  })

  it('refuses what it cannot repeat', () => {
    expect(parseRepeatRule(null)).toBeNull()
    expect(parseRepeatRule('weekly')).toBeNull()
    expect(parseRepeatRule({ freq: 'hourly', interval: 1 })).toBeNull()
    expect(parseRepeatRule({ freq: 'daily', interval: 0 })).toBeNull()
    expect(parseRepeatRule({ freq: 'daily', interval: 1000 })).toBeNull()
  })
})

describe('the next occurrence of a repeating task', () => {
  it('adds a day for a daily task', () => {
    const due = utc('2026-10-19T23:30:00Z')
    expect(nextOccurrence(due, { freq: 'daily', interval: 1 }, 'UTC')).toBe(utc('2026-10-20T23:30:00Z'))
  })

  it('adds weeks, not seven days of fixed milliseconds', () => {
    const due = utc('2026-10-19T09:00:00Z')
    expect(nextOccurrence(due, { freq: 'weekly', interval: 2 }, 'UTC')).toBe(utc('2026-11-02T09:00:00Z'))
  })

  it('clamps a month that lacks the day', () => {
    const due = utc('2026-01-31T10:00:00Z')
    expect(nextOccurrence(due, { freq: 'monthly', interval: 1 }, 'UTC')).toBe(utc('2026-02-28T10:00:00Z'))
  })

  it('keeps a leap day out of a year that has none', () => {
    const due = utc('2024-02-29T08:00:00Z')
    expect(nextOccurrence(due, { freq: 'yearly', interval: 1 }, 'UTC')).toBe(utc('2025-02-28T08:00:00Z'))
  })

  it('keeps the wall-clock hour across a daylight-saving change', () => {
    const zone = 'America/New_York'
    const due = Date.parse('2026-03-04T14:00:00Z')
    const next = nextOccurrence(due, { freq: 'weekly', interval: 1 }, zone)
    expect(getZonedParts(new Date(due), zone)).toMatchObject({ year: 2026, month: 3, day: 4, hour: 9 })
    // The same wall time a week later, which is one hour short of seven times 24 hours because
    // the clock sprang forward in between. That hour is the point of the test.
    expect(getZonedParts(new Date(next), zone)).toMatchObject({ year: 2026, month: 3, day: 11, hour: 9 })
    expect(next - due).toBe(7 * DAY - HOUR)
  })
})

describe('when a reminder fires', () => {
  const due = utc('2026-10-20T09:00:00Z')

  it('follows the offset the reader picked', () => {
    expect(remindAtFor(due, 'due')).toBe(due)
    expect(remindAtFor(due, '15m')).toBe(due - 15 * 60_000)
    expect(remindAtFor(due, '1h')).toBe(due - HOUR)
    expect(remindAtFor(due, '1d')).toBe(due - DAY)
  })

  it('has nothing to fire without a due date', () => {
    expect(remindAtFor(null, 'due')).toBeNull()
    expect(remindAtFor(due, 'none')).toBeNull()
  })
})

describe('tag names as this app stores them', () => {
  it('drops the hash, the duplicates and the blanks', () => {
    expect(normalizeTagNames(['#Work', ' work ', '', 'Life'])).toEqual(['Work', 'Life'])
  })

  it('accepts a comma-separated string', () => {
    expect(normalizeTagNames('work, life')).toEqual(['work', 'life'])
  })

  it('stops at the per-task ceiling', () => {
    const many = Array.from({ length: MAX_TAGS_PER_TASK + 4 }, (_, index) => `tag-${index}`)
    expect(normalizeTagNames(many)).toHaveLength(MAX_TAGS_PER_TASK)
  })

  it('ignores anything that is not a name', () => {
    expect(normalizeTagNames([1, null, { name: 'x' }])).toEqual([])
  })
})

describe('the small readings a list card and a checkbox need', () => {
  it('counts a list as done over total', () => {
    expect(taskListProgress({ openCount: 2, doneCount: 4 })).toEqual({ done: 4, total: 6 })
    expect(taskListProgress({ openCount: 0, doneCount: 0 })).toEqual({ done: 0, total: 0 })
  })

  it('toggles a status both ways', () => {
    expect(toggledStatus('todo')).toBe('done')
    expect(toggledStatus('in_progress')).toBe('done')
    expect(toggledStatus('done')).toBe('todo')
  })

  it('recognises only the views the server answers', () => {
    expect(isTaskView('starred')).toBe(true)
    expect(isTaskView('someday')).toBe(false)
    expect(isTaskView(undefined)).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { getZonedParts } from '../src/shared/assistant-schedule'
import {
  MAX_REPEAT_COUNT,
  MAX_REPEAT_EXCLUDED_DAYS,
  MAX_REPEAT_UNTIL_MS,
  MAX_TAGS_PER_TASK,
  advanceRepeat,
  isTaskView,
  nextOccurrence,
  normalizeTagNames,
  parseRepeatRule,
  remindAtFor,
  taskColorOrNull,
  taskIconOrNull,
  taskListProgress,
  toggledStatus,
  withPreviousSeries,
  type RepeatRule,
  type TaskStatus,
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

  it('reads a weekly rule that names its weekdays', () => {
    expect(parseRepeatRule({ freq: 'weekly', interval: 1, weekdays: [5, 1, 3, 3] }))
      .toEqual({ freq: 'weekly', interval: 1, weekdays: [1, 3, 5] })
  })

  it('reads a monthly rule that lands on the last day', () => {
    expect(parseRepeatRule({ freq: 'monthly', interval: 1, monthlyMode: 'lastDay' }))
      .toEqual({ freq: 'monthly', interval: 1, monthlyMode: 'lastDay' })
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
    expect(parseRepeatRule({ freq: 'weekly', weekdays: [1, 7] })).toBeNull()
    expect(parseRepeatRule({ freq: 'weekly', weekdays: ['mon'] })).toBeNull()
    expect(parseRepeatRule({ freq: 'monthly', monthlyMode: 'nthBusinessDay' })).toBeNull()
  })

  // The series fields are read here or not at all: every door that turns a stored rule back into a
  // value — the row decoder, the sync merge, the backup import — comes through this function, so a
  // field the reader set in the editor would otherwise vanish on the first reload, and a bounded
  // series would run forever rather than end.
  it('reads the series the rule carries', () => {
    const rule: RepeatRule = {
      freq: 'weekly',
      interval: 2,
      weekdays: [1, 3, 5],
      untilAt: utc('2026-12-31T00:00:00Z'),
      count: 12,
      produced: 4,
      fromCompletionDate: true,
      paused: true,
      excludedDays: ['2026-11-11', '2026-11-18'],
    }

    expect(parseRepeatRule(rule)).toEqual(rule)
  })

  it('reads the same rule twice', () => {
    const once = parseRepeatRule({ freq: 'daily', interval: 1, count: 3, produced: 2 })
    expect(parseRepeatRule(once)).toEqual(once)
  })

  it('sorts and deduplicates the days a series steps over', () => {
    expect(parseRepeatRule({ freq: 'daily', interval: 1, excludedDays: ['2026-11-02', '2026-11-01', '2026-11-02'] }))
      .toEqual({ freq: 'daily', interval: 1, excludedDays: ['2026-11-01', '2026-11-02'] })
  })

  it('reads an absent ceiling and a cleared one as no ceiling', () => {
    expect(parseRepeatRule({ freq: 'daily', interval: 1, untilAt: null, count: null })).toEqual({ freq: 'daily', interval: 1 })
  })

  it('refuses a series shape it could not have written', () => {
    expect(parseRepeatRule({ freq: 'daily', interval: 1, untilAt: 'soon' })).toBeNull()
    expect(parseRepeatRule({ freq: 'daily', interval: 1, untilAt: 1.5 })).toBeNull()
    expect(parseRepeatRule({ freq: 'daily', interval: 1, untilAt: 0 })).toBeNull()
    expect(parseRepeatRule({ freq: 'daily', interval: 1, untilAt: MAX_REPEAT_UNTIL_MS + 1 })).toBeNull()
    expect(parseRepeatRule({ freq: 'daily', interval: 1, count: 0 })).toBeNull()
    expect(parseRepeatRule({ freq: 'daily', interval: 1, count: MAX_REPEAT_COUNT + 1 })).toBeNull()
    expect(parseRepeatRule({ freq: 'daily', interval: 1, produced: -1 })).toBeNull()
    expect(parseRepeatRule({ freq: 'daily', interval: 1, paused: 'yes' })).toBeNull()
    expect(parseRepeatRule({ freq: 'daily', interval: 1, fromCompletionDate: 1 })).toBeNull()
    expect(parseRepeatRule({ freq: 'daily', interval: 1, excludedDays: ['2026-11-1'] })).toBeNull()
    expect(parseRepeatRule({ freq: 'daily', interval: 1, excludedDays: '2026-11-01' })).toBeNull()
    expect(parseRepeatRule({
      freq: 'daily',
      interval: 1,
      excludedDays: Array.from({ length: MAX_REPEAT_EXCLUDED_DAYS + 1 }, (_, index) => `2026-11-${String(index + 1).padStart(2, '0')}`),
    })).toBeNull()
  })

  it('drops a pause or an anchor the reader left off rather than storing the negation', () => {
    expect(parseRepeatRule({ freq: 'daily', interval: 1, paused: false, fromCompletionDate: false }))
      .toEqual({ freq: 'daily', interval: 1 })
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

  it('walks to the next named weekday inside the week', () => {
    const rule: RepeatRule = { freq: 'weekly', interval: 1, weekdays: [1, 3, 5] }
    // Friday 23 October 2026 → the following Monday, because the week's other days are behind it.
    expect(nextOccurrence(utc('2026-10-23T09:00:00Z'), rule, 'UTC')).toBe(utc('2026-10-26T09:00:00Z'))
    expect(nextOccurrence(utc('2026-10-19T09:00:00Z'), rule, 'UTC')).toBe(utc('2026-10-21T09:00:00Z'))
    expect(nextOccurrence(utc('2026-10-21T09:00:00Z'), rule, 'UTC')).toBe(utc('2026-10-23T09:00:00Z'))
    expect(nextOccurrence(utc('2026-10-24T09:00:00Z'), rule, 'UTC')).toBe(utc('2026-10-26T09:00:00Z'))
  })

  it('skips the weeks an interval passes over', () => {
    const rule: RepeatRule = { freq: 'weekly', interval: 2, weekdays: [1, 3, 5] }
    expect(nextOccurrence(utc('2026-10-23T09:00:00Z'), rule, 'UTC')).toBe(utc('2026-11-02T09:00:00Z'))
    // Wednesday of the same week still belongs to the occurrence's own week.
    expect(nextOccurrence(utc('2026-10-19T09:00:00Z'), rule, 'UTC')).toBe(utc('2026-10-21T09:00:00Z'))
  })

  it('lands on the last day of every month', () => {
    const rule: RepeatRule = { freq: 'monthly', interval: 1, monthlyMode: 'lastDay' }
    expect(nextOccurrence(utc('2026-01-15T10:00:00Z'), rule, 'UTC')).toBe(utc('2026-02-28T10:00:00Z'))
    expect(nextOccurrence(utc('2026-01-31T10:00:00Z'), rule, 'UTC')).toBe(utc('2026-02-28T10:00:00Z'))
  })

  it('keeps the same nth weekday of the month', () => {
    const rule: RepeatRule = { freq: 'monthly', interval: 1, monthlyMode: 'nthWeekday' }
    // The third Wednesday of January 2026 is the 21st; February's third Wednesday is the 18th.
    expect(nextOccurrence(utc('2026-01-21T10:00:00Z'), rule, 'UTC')).toBe(utc('2026-02-18T10:00:00Z'))
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
    // The checkbox flips between owed and not-owed. Work still owed goes finished; a row that already
    // stopped being owed — finished or abandoned — goes back to `todo`. Pressing an abandoned row
    // reopens it rather than quietly re-labeling it finished (the ruling recorded in `toggledStatus`).
    expect(toggledStatus('todo')).toBe('done')
    expect(toggledStatus('in_progress')).toBe('done')
    expect(toggledStatus('done')).toBe('todo')
    expect(toggledStatus('cancelled' as TaskStatus)).toBe('todo')
  })

  it('recognises only the views the server answers', () => {
    expect(isTaskView('starred')).toBe(true)
    expect(isTaskView('someday')).toBe(false)
    expect(isTaskView(undefined)).toBe(false)
  })
})

describe("a task's own icon, as the store keeps it", () => {
  it('keeps a lucide name and an emoji as written', () => {
    expect(taskIconOrNull('lucide:Briefcase')).toBe('lucide:Briefcase')
    expect(taskIconOrNull('🔥')).toBe('🔥')
  })

  it('strips control characters and the surrounding space', () => {
    expect(taskIconOrNull('  lucide:Star\u0000  ')).toBe('lucide:Star')
  })

  it('reads an empty icon as none', () => {
    expect(taskIconOrNull('')).toBeNull()
    expect(taskIconOrNull('   ')).toBeNull()
  })

  it('refuses what is longer than a name can be', () => {
    expect(taskIconOrNull('x'.repeat(40))).toHaveLength(40)
    expect(taskIconOrNull('x'.repeat(41))).toBeNull()
  })

  it('ignores anything that is not text', () => {
    expect(taskIconOrNull(null)).toBeNull()
    expect(taskIconOrNull(undefined)).toBeNull()
    expect(taskIconOrNull(7)).toBeNull()
  })
})

describe("a task's own colour, as the store keeps it", () => {
  it('keeps a palette colour and lowercases a mixed hex', () => {
    expect(taskColorOrNull('#dc2626')).toBe('#dc2626')
    expect(taskColorOrNull('#ABCDEF')).toBe('#abcdef')
  })

  it('refuses what is not a colour', () => {
    expect(taskColorOrNull('red')).toBeNull()
    expect(taskColorOrNull('#12345')).toBeNull()
    expect(taskColorOrNull('')).toBeNull()
  })

  it('ignores anything that is not text', () => {
    expect(taskColorOrNull(null)).toBeNull()
    expect(taskColorOrNull(42)).toBeNull()
  })
})

describe('a series deciding whether it owes another occurrence', () => {
  const DUE = Date.parse('2026-03-12T09:00:00Z')
  const done = Date.parse('2026-03-13T20:00:00Z')
  const weekly = { freq: 'weekly' as const, interval: 1 }
  const at = (patch: Record<string, unknown> = {}) => advanceRepeat(
    { ...weekly, ...patch } as never,
    { anchorDueAt: DUE, completedAt: done, timeZone: 'UTC' },
  )

  it('counts from the old due date, so a late tick does not move the rhythm', () => {
    expect(at().dueAt).toBe(Date.parse('2026-03-19T09:00:00Z'))
  })

  it('counts from the finished day only when the reader asked it to', () => {
    expect(at({ fromCompletionDate: true }).dueAt).toBe(Date.parse('2026-03-20T20:00:00Z'))
  })

  it('stops at a pause without spending a turn', () => {
    const stopped = at({ paused: true })
    expect(stopped).toMatchObject({ dueAt: null, stopped: 'paused' })
    // The rule comes back untouched: a reopen and a second finish must not count an occurrence
    // that was never created.
    expect(stopped.rule.produced).toBeUndefined()
  })

  it('stops once the ceiling day is passed', () => {
    expect(at({ untilAt: Date.parse('2026-03-15T00:00:00Z') })).toMatchObject({ dueAt: null, stopped: 'until' })
    expect(at({ untilAt: Date.parse('2026-03-19T23:00:00Z') }).dueAt).toBe(Date.parse('2026-03-19T09:00:00Z'))
  })

  it('produces exactly `count` occurrences and no more', () => {
    expect(at({ count: 1 })).toMatchObject({ dueAt: null, stopped: 'count' })
    expect(at({ count: 2 }).rule.produced).toBe(2)
    expect(at({ count: 2, produced: 2 })).toMatchObject({ dueAt: null, stopped: 'count' })
  })

  it('steps over an excluded day rather than cancelling the occurrence', () => {
    const next = at({ excludedDays: ['2026-03-19'] })
    expect(next.dueAt).toBe(Date.parse('2026-03-26T09:00:00Z'))
    expect(next.rule.produced).toBe(2)
  })

  it('counts a rule written before the counter existed as its series first occurrence', () => {
    // The only reading that does not restart a series the reader has already run: an absent counter
    // is 1, so `count: 1` means "this row was the whole series".
    expect(at({ count: 1 }).stopped).toBe('count')
    expect(at({ count: 3, produced: 1 }).rule.produced).toBe(2)
  })

  it('gives up rather than spinning when every landing day is excluded', () => {
    const every = ['2026-03-19', '2026-03-26', '2026-04-02']
    const far = advanceRepeat(
      { freq: 'daily', interval: 1, excludedDays: every },
      { anchorDueAt: DUE, completedAt: done, timeZone: 'UTC' },
    )
    // Three named days cannot trap a daily rhythm; the walk only has to bound the pathological case.
    expect(far.dueAt).toBe(Date.parse('2026-03-13T09:00:00Z'))
  })
})

describe('a rhythm named over the series already running', () => {
  const series: RepeatRule = {
    freq: 'weekly',
    interval: 1,
    weekdays: [1, 3],
    untilAt: Date.parse('2026-12-31T00:00:00Z'),
    count: 12,
    produced: 4,
    paused: true,
    fromCompletionDate: true,
    excludedDays: ['2026-11-11'],
  }

  it('keeps the days the rhythm already lands on when the caller names the same rhythm again', () => {
    const fortnightly = withPreviousSeries({ freq: 'weekly', interval: 2 }, series)

    expect(fortnightly).toEqual({ ...series, interval: 2 })
    expect(fortnightly.count).toBe(12)
    expect(fortnightly.produced).toBe(4)
    expect(fortnightly.paused).toBe(true)
  })

  it('takes the days the caller named over the ones the row carried', () => {
    const named = withPreviousSeries({ freq: 'weekly', interval: 1, weekdays: [5] }, series)

    expect(named.weekdays).toEqual([5])
  })

  it('does not carry the modifiers of a rhythm it replaced', () => {
    // Weekdays picked for a weekly task mean nothing on a monthly one, and the reader said monthly.
    const monthly = withPreviousSeries({ freq: 'monthly', interval: 1 }, series)

    expect(monthly.freq).toBe('monthly')
    expect(monthly.weekdays).toBeUndefined()
    expect(monthly.excludedDays).toEqual(['2026-11-11'])
  })

  it('leaves a rule alone when the row carried no series', () => {
    expect(withPreviousSeries({ freq: 'daily', interval: 1 }, null)).toEqual({ freq: 'daily', interval: 1 })
    expect(withPreviousSeries({ freq: 'daily', interval: 1 }, undefined)).toEqual({ freq: 'daily', interval: 1 })
  })

  it('survives the reader of stored rules', () => {
    expect(parseRepeatRule(withPreviousSeries({ freq: 'weekly', interval: 2 }, series)))
      .toEqual({ ...series, interval: 2 })
  })
})

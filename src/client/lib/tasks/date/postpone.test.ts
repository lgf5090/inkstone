import { describe, expect, it } from 'vitest'
import { EmojiTaskSerializer } from '../serializer/emoji'
import { defaultStatusRegistry } from '../line'
import { parseTaskLine, type Task } from '../model/task'
import { unknownPosition } from '../model/task-location'
import { formatTaskDate } from './date-tools'
import { getDateFieldToPostpone, postponeDate, shouldShowPostponeButton } from './postpone'

const NOW = new Date(2026, 9, 19)
const cp = (...codes: number[]): string => String.fromCodePoint(...codes)
const DUE = cp(0x1F4C5)
const SCHEDULED = cp(0x23F3)
const START = cp(0x1F6EB)
const DONE_MARK = cp(0x2705)

const serializer = new EmojiTaskSerializer()

function task(line: string): Task {
  const parsed = parseTaskLine(line, unknownPosition('n1', 'Inbox.md'), {
    registry: defaultStatusRegistry,
    serializer,
    now: NOW,
  })
  if (parsed === null) throw new Error(`test fixture is not a task line: ${line}`)
  return parsed
}

function iso(date: Date | null): string {
  return date === null ? '' : formatTaskDate(date)
}

describe('which date a postponement moves', () => {
  it('takes the due date over the others', () => {
    expect(getDateFieldToPostpone(task(`- [ ] x ${DUE} 2026-10-22 ${SCHEDULED} 2026-10-21 ${START} 2026-10-20`).fields))
      .toBe('dueDate')
  })

  it('falls to scheduled, then start', () => {
    expect(getDateFieldToPostpone(task(`- [ ] x ${SCHEDULED} 2026-10-21 ${START} 2026-10-20`).fields)).toBe('scheduledDate')
    expect(getDateFieldToPostpone(task(`- [ ] x ${START} 2026-10-20`).fields)).toBe('startDate')
  })

  it('answers null when the task names no day at all', () => {
    expect(getDateFieldToPostpone(task('- [ ] x').fields)).toBeNull()
  })

  it('skips a date that names no real day', () => {
    // `2022-02-30` reads as a date and is not one: moving it would invent a day, so it is left where it
    // is and the undated start date is the one the click can move.
    const fields = task(`- [ ] x ${DUE} 2022-02-30 ${START} 2026-10-20`).fields
    expect(getDateFieldToPostpone(fields)).toBe('startDate')
  })
})

describe('whether the button is worth drawing', () => {
  it('is off for a task that is already finished', () => {
    expect(shouldShowPostponeButton(task(`- [x] x ${DUE} 2026-10-22 ${DONE_MARK} 2026-10-19`))).toBe(false)
    expect(shouldShowPostponeButton(task(`- [-] x ${DUE} 2026-10-22 ${cp(0x274C)} 2026-10-19`))).toBe(false)
  })

  it('is off while a date cannot be read', () => {
    expect(shouldShowPostponeButton(task(`- [ ] x ${DUE} 2022-02-30`))).toBe(false)
  })

  it('is off when there is nothing to move', () => {
    expect(shouldShowPostponeButton(task('- [ ] x'))).toBe(false)
  })

  it('is on for the one line a reader postpones', () => {
    expect(shouldShowPostponeButton(task(`- [ ] x ${DUE} 2026-10-22`))).toBe(true)
  })
})

describe('the day a row lands on', () => {
  const due = () => task(`- [ ] x ${DUE} 2026-10-22`).fields

  it('counts from the day the task names', () => {
    expect(iso(postponeDate(due(), 'dueDate', 2, 'day', 'from-date', NOW))).toBe('2026-10-24')
    expect(iso(postponeDate(due(), 'dueDate', 1, 'week', 'from-date', NOW))).toBe('2026-10-29')
  })

  it('counts an overdue day from today, not from itself', () => {
    const overdue = task(`- [ ] x ${DUE} 2026-09-30`).fields
    expect(iso(postponeDate(overdue, 'dueDate', 2, 'day', 'from-date', NOW))).toBe('2026-10-21')
  })

  it('names a day when the row is measured from today', () => {
    expect(iso(postponeDate(due(), 'dueDate', 0, 'day', 'from-today', NOW))).toBe('2026-10-19')
    expect(iso(postponeDate(due(), 'dueDate', 1, 'day', 'from-today', NOW))).toBe('2026-10-20')
  })

  it('clamps a month that has no such day', () => {
    // Ahead of `NOW`, because a date already past is counted from today rather than from itself.
    const endOfMonth = task(`- [ ] x ${DUE} 2027-01-31`).fields
    expect(iso(postponeDate(endOfMonth, 'dueDate', 1, 'month', 'from-date', NOW))).toBe('2027-02-28')
    const middle = task(`- [ ] x ${DUE} 2027-01-15`).fields
    expect(iso(postponeDate(middle, 'dueDate', 1, 'month', 'from-date', NOW))).toBe('2027-02-15')
  })

  it('answers null for a field with no day', () => {
    expect(postponeDate(task('- [ ] x').fields, 'dueDate', 2, 'day', 'from-date', NOW)).toBeNull()
  })

  it('counts in whole days when the clock it is given has one', () => {
    const withTime = task(`- [ ] x ${DUE} 2026-10-22`).fields
    expect(iso(postponeDate(withTime, 'dueDate', 2, 'day', 'from-date', new Date(2026, 9, 19, 23, 30)))).toBe('2026-10-24')
  })
})

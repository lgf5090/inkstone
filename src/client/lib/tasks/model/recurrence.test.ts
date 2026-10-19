import { describe, expect, it } from 'vitest'
import { dateKey } from '../../../lib/time'
import { Occurrence } from './occurrence'
import { Recurrence } from './recurrence'

function day(text: string): Date {
  const [year, month, day] = text.split('-').map(Number)
  return new Date(year!, month! - 1, day!)
}

function nextDue(rule: string, due: string): string {
  const occurrence = new Occurrence({ startDate: null, scheduledDate: null, dueDate: day(due) })
  const recurrence = Recurrence.fromText({ recurrenceRuleText: rule, occurrence, now: day(due) })
  if (recurrence === null) return 'unparseable'
  const next = recurrence.next(day(due))
  return next?.dueDate === null || next?.dueDate === undefined ? 'none' : dateKey(next.dueDate)
}

describe('Recurrence month and year overflow', () => {
  it('matches the six upstream edge cases where the target month is too short', () => {
    expect(nextDue('every month', '2022-01-31')).toBe('2022-02-28')
    expect(nextDue('every 3 months', '2022-01-31')).toBe('2022-04-30')
    expect(nextDue('every 2 months', '2023-12-31')).toBe('2024-02-29')
    expect(nextDue('every 11 months', '2020-03-31')).toBe('2021-02-28')
    expect(nextDue('every 13 months', '2020-01-31')).toBe('2021-02-28')
    expect(nextDue('every 2 years', '2024-02-29')).toBe('2026-02-28')
  })
})

describe('Recurrence text', () => {
  it('writes the rule back the way the reader typed it', () => {
    const occurrence = new Occurrence({ startDate: null, scheduledDate: null, dueDate: day('2026-10-19') })
    const parsed = Recurrence.fromText({ recurrenceRuleText: 'every month on the 2nd', occurrence, now: day('2026-10-19') })
    expect(parsed?.toText()).toBe('every month on the 2nd')
  })

  it('keeps "when done" out of the rule and in the text', () => {
    const occurrence = new Occurrence({ startDate: null, scheduledDate: null, dueDate: day('2026-10-19') })
    const parsed = Recurrence.fromText({ recurrenceRuleText: 'every week when done', occurrence, now: day('2026-10-19') })
    expect(parsed?.baseOnToday).toBe(true)
    expect(parsed?.toText()).toBe('every week when done')
  })

  it('refuses a rule that is not one, rather than inventing a schedule', () => {
    const occurrence = new Occurrence({ startDate: null, scheduledDate: null, dueDate: day('2026-10-19') })
    expect(Recurrence.fromText({ recurrenceRuleText: 'every', occurrence, now: day('2026-10-19') })).toBeNull()
    expect(Recurrence.fromText({ recurrenceRuleText: '!!!', occurrence, now: day('2026-10-19') })).toBeNull()
  })
})

describe('Recurrence anchoring', () => {
  it('keeps the original phase when the reader finishes late', () => {
    const occurrence = new Occurrence({ startDate: null, scheduledDate: null, dueDate: day('2026-10-19') })
    const parsed = Recurrence.fromText({ recurrenceRuleText: 'every week', occurrence, now: day('2026-10-19') })
    const finishedLate = parsed!.next(day('2026-10-28'))
    expect(dateKey(finishedLate!.dueDate!)).toBe('2026-10-26')
  })

  it('restarts from the completion day when the rule says when done', () => {
    const occurrence = new Occurrence({ startDate: null, scheduledDate: null, dueDate: day('2026-10-19') })
    const parsed = Recurrence.fromText({ recurrenceRuleText: 'every week when done', occurrence, now: day('2026-10-28') })
    const next = parsed!.next(day('2026-10-28'))
    expect(dateKey(next!.dueDate!)).toBe('2026-11-04')
  })

  it('carries the lead time between start and due onto every instance', () => {
    const occurrence = new Occurrence({ startDate: day('2026-10-12'), scheduledDate: null, dueDate: day('2026-10-19') })
    const parsed = Recurrence.fromText({ recurrenceRuleText: 'every week', occurrence, now: day('2026-10-19') })
    const next = parsed!.next(day('2026-10-19'))
    expect(dateKey(next!.dueDate!)).toBe('2026-10-26')
    expect(dateKey(next!.startDate!)).toBe('2026-10-19')
  })

  it('drops the scheduled date only when the reader asked for it', () => {
    const plain = new Occurrence({ startDate: null, scheduledDate: day('2026-10-15'), dueDate: day('2026-10-19') })
    const parsed = Recurrence.fromText({ recurrenceRuleText: 'every week', occurrence: plain, now: day('2026-10-19') })
    expect(dateKey(parsed!.next(day('2026-10-19'))!.scheduledDate!)).toBe('2026-10-22')

    const dropping = new Occurrence(
      { startDate: day('2026-10-12'), scheduledDate: day('2026-10-15'), dueDate: day('2026-10-19') },
      { removeScheduledDateOnRecurrence: true },
    )
    const parsedDropping = Recurrence.fromText({ recurrenceRuleText: 'every week', occurrence: dropping, now: day('2026-10-19') })
    expect(parsedDropping!.next(day('2026-10-19'))!.scheduledDate).toBeNull()
  })
})

describe('Recurrence identity', () => {
  it('treats two rules as the same only when text, anchoring and dates all agree', () => {
    const occurrence = new Occurrence({ startDate: null, scheduledDate: null, dueDate: day('2026-10-19') })
    const a = Recurrence.fromText({ recurrenceRuleText: 'every week', occurrence, now: day('2026-10-19') })!
    const b = Recurrence.fromText({ recurrenceRuleText: 'every week', occurrence, now: day('2026-10-19') })!
    const c = Recurrence.fromText({ recurrenceRuleText: 'every 2 weeks', occurrence, now: day('2026-10-19') })!
    expect(a.identicalTo(b)).toBe(true)
    expect(a.identicalTo(c)).toBe(false)
  })
})

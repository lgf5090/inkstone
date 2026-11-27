import { describe, expect, it } from 'vitest'
import { DEFAULT_PLAN_TODAY_SUGGESTIONS, MAX_PLAN_TODAY_SUGGESTIONS, planSuggestions } from './plan-suggestions'
import type { TodoTask } from './model'

const DAY = 24 * 60 * 60 * 1000
/** The end of the reader's own today, and the instant the plan was asked at. */
const dayEnd = Date.parse('2026-10-24T16:00:00Z')
const now = dayEnd - 4 * 60 * 60 * 1000
const today = '2026-10-24'

function task(overrides: Partial<TodoTask> & { id: string, title: string }): TodoTask {
  const { id, title, ...rest } = overrides
  return {
    id,
    title,
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt: null,
    projectId: null,
    listId: null,
    tags: [],
    starred: false,
    repeat: null,
    plannedFor: null,
    noteId: null,
    conversationId: null,
    reminders: [],
    remindAt: null,
    remindedAt: null,
    timeEstimateMs: null,
    timeSpentMs: 0,
    archivedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...rest,
  } as TodoTask
}

describe('what a plan offers', () => {
  it('names an overdue row first, and a row that qualifies twice only once', () => {
    const overdue = task({ id: 'a', title: 'Overdue', dueAt: now - DAY })
    const starredOverdue = task({ id: 'b', title: 'Starred and overdue', dueAt: now - DAY, starred: true })

    const offered = planSuggestions([overdue, starredOverdue], { today, dayEnd, now })

    expect(offered).toEqual([
      { id: 'a', title: 'Overdue', reason: 'overdue' },
      { id: 'b', title: 'Starred and overdue', reason: 'overdue' },
    ])
  })

  it('offers a starred row due in the coming week under its own reason', () => {
    const starred = task({ id: 'a', title: 'Starred', starred: true, dueAt: dayEnd + 2 * DAY })

    expect(planSuggestions([starred], { today, dayEnd, now })).toEqual([
      { id: 'a', title: 'Starred', reason: 'starred_due' },
    ])
  })

  it('leaves out what is already on today, in all three ways it can be', () => {
    const planned = task({ id: 'a', title: 'Planned', plannedFor: today })
    const dueToday = task({ id: 'b', title: 'Due today', dueAt: dayEnd - 60_000 })
    const inProgress = task({ id: 'c', title: 'Under way', status: 'in_progress' })

    expect(planSuggestions([planned, dueToday, inProgress], { today, dayEnd, now })).toEqual([])
  })

  it('offers what has no plan and no date, and stops at the day\u2019s worth', () => {
    const shelf = Array.from({ length: 20 }, (_, index) =>
      task({ id: `t${index}`, title: `Task ${index}` }))

    const offered = planSuggestions(shelf, { today, dayEnd, now, limit: MAX_PLAN_TODAY_SUGGESTIONS })

    expect(offered).toHaveLength(MAX_PLAN_TODAY_SUGGESTIONS)
    expect(offered[0]!.reason).toBe('unscheduled')
    // The default is a day\u2019s worth, not the ceiling: a caller that says nothing gets five.
    expect(planSuggestions(shelf, { today, dayEnd, now })).toHaveLength(DEFAULT_PLAN_TODAY_SUGGESTIONS)
  })

  it('never hands back work the reader has finished or put in the trash', () => {
    const done = task({ id: 'a', title: 'Done', status: 'done', completedAt: now })
    const cancelled = task({ id: 'b', title: 'Cancelled', status: 'cancelled' })
    const trashed = task({ id: 'c', title: 'Trashed', deletedAt: now })

    expect(planSuggestions([done, cancelled, trashed], { today, dayEnd, now })).toEqual([])
  })

  it('still offers a row the reader only shelved: the shelf hides it from every list, not from a plan', () => {
    // A put-away row is the reader\u2019s own work waiting to be picked up again, and the Today screen
    // is the one place that reaches it — so the rule leaves it in, exactly as it always did.
    const archived = task({ id: 'a', title: 'Archived', archivedAt: now })

    expect(planSuggestions([archived], { today, dayEnd, now })).toEqual([
      { id: 'a', title: 'Archived', reason: 'unscheduled' },
    ])
  })

  it('answers with the limit the caller asked for', () => {
    const shelf = Array.from({ length: 10 }, (_, index) => task({ id: `t${index}`, title: `Task ${index}` }))

    expect(planSuggestions(shelf, { today, dayEnd, now, limit: 3 })).toHaveLength(3)
  })
})

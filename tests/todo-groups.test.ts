import { describe, expect, it } from 'vitest'
import type { TodoTask } from '../src/shared/todos/model'
import { compareTasks, groupByPlan, groupCompleted, groupByList } from '../src/client/features/todos/task-groups'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-19T10:00:00Z')
const DAY_END = Date.parse('2026-10-19T23:59:59Z')

function task(id: string, patch: Partial<TodoTask> = {}): TodoTask {
  return {
    id,
    title: id,
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt: null,
    projectId: null,
    listId: null,
    tags: [],
    starred: false,
    repeat: null,
    remindAt: null,
    remindedAt: null,
    plannedFor: null,
    noteId: null,
    conversationId: null,
    stepTotal: 0,
    stepDone: 0,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    ...patch,
  }
}

describe('the plan view', () => {
  it('splits a page into overdue, today, upcoming, later and undated', () => {
    const groups = groupByPlan([
      task('overdue', { dueAt: NOW - DAY }),
      task('today', { dueAt: NOW + 60 * 60 * 1000 }),
      task('upcoming', { dueAt: DAY_END + 2 * DAY }),
      task('later', { dueAt: DAY_END + 30 * DAY }),
      task('none'),
      task('started', { status: 'in_progress' }),
      task('done', { dueAt: NOW - DAY, status: 'done' }),
    ], { dayEnd: DAY_END, now: NOW })

    expect(groups.map((group) => [group.key, group.tasks.map((entry) => entry.id)])).toEqual([
      ['overdue', ['overdue']],
      ['today', ['today', 'started']],
      ['upcoming', ['upcoming']],
      ['later', ['later']],
      ['none', ['none']],
    ])
  })

  it('leaves out a group with nothing in it', () => {
    expect(groupByPlan([task('one', { dueAt: NOW - DAY })], { dayEnd: DAY_END, now: NOW }).map((group) => group.key))
      .toEqual(['overdue'])
  })
})

describe('a list', () => {
  it('reads open tasks first and finished ones last', () => {
    const groups = groupByList([
      task('done', { status: 'done', completedAt: 5 }),
      task('later', { dueAt: NOW + 5 * DAY }),
      task('sooner', { dueAt: NOW + DAY }),
    ])
    expect(groups.map((group) => [group.key, group.tasks.map((entry) => entry.id)])).toEqual([
      ['open', ['sooner', 'later']],
      ['done', ['done']],
    ])
  })
})

describe('the completed view', () => {
  it('files each task under the day it was finished, newest day first', () => {
    const groups = groupCompleted([
      task('a', { status: 'done', completedAt: Date.parse('2026-10-18T09:00:00Z') }),
      task('b', { status: 'done', completedAt: Date.parse('2026-10-19T09:00:00Z') }),
      task('c', { status: 'done', completedAt: Date.parse('2026-10-19T11:00:00Z') }),
    ], 'UTC')

    expect(groups.map((group) => [group.key, group.tasks.map((entry) => entry.id)])).toEqual([
      ['2026-10-19', ['c', 'b']],
      ['2026-10-18', ['a']],
    ])
  })

  it('groups by the reader’s day, not the browser’s', () => {
    // 23:30 UTC is already the next morning in Shanghai.
    const groups = groupCompleted([task('a', { status: 'done', completedAt: Date.parse('2026-10-18T23:30:00Z') })], 'Asia/Shanghai')
    expect(groups[0]!.key).toBe('2026-10-19')
  })
})

describe('ordering', () => {
  it('puts the earliest due date first and undated tasks last', () => {
    const sorted = [
      task('none'),
      task('later', { dueAt: NOW + DAY }),
      task('sooner', { dueAt: NOW }),
    ].sort(compareTasks)
    expect(sorted.map((entry) => entry.id)).toEqual(['sooner', 'later', 'none'])
  })

  it('breaks a tie by priority', () => {
    const sorted = [task('low', { dueAt: NOW, priority: 'low' }), task('urgent', { dueAt: NOW, priority: 'urgent' })].sort(compareTasks)
    expect(sorted.map((entry) => entry.id)).toEqual(['urgent', 'low'])
  })
})

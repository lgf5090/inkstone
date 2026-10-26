import { describe, expect, it } from 'vitest'
import type { TodoTask } from '../src/shared/todos/model'
import { compareTasks, groupByPlan, groupBySection, groupCompleted, groupByList } from '../src/client/features/todos/task-groups'

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
    dependsOn: [],
    blocks: [],
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

describe('a list read as sections', () => {
  const sections = [{ id: 'billing' }, { id: 'retainers' }]

  it('draws one group per section, in the order the reader filed them, and the list own rows first', () => {
    const groups = groupBySection([
      task('in-retainers', { listId: 'retainers' }),
      task('own-row', { listId: 'parent' }),
      task('in-billing', { listId: 'billing' }),
    ], sections)
    expect(groups.map((group) => [group.key, group.tasks.map((entry) => entry.id)])).toEqual([
      ['unsectioned', ['own-row']],
      ['section:billing', ['in-billing']],
      ['section:retainers', ['in-retainers']],
    ])
  })

  it('keeps an empty section on the page, because a section is somewhere to drop a row onto', () => {
    const groups = groupBySection([task('own-row', { listId: 'parent' })], sections)
    expect(groups.map((group) => group.key)).toEqual(['unsectioned', 'section:billing', 'section:retainers'])
    expect(groups[1]!.tasks).toEqual([])
  })

  it('files finished rows together and says which collection each came from', () => {
    const groups = groupBySection([
      task('billing-done', { listId: 'billing', status: 'done', completedAt: 5 }),
      task('own-open', { listId: 'parent' }),
      task('retainer-done', { listId: 'retainers', status: 'done', completedAt: 9 }),
    ], sections)
    const done = groups.find((group) => group.key === 'done')
    expect(done?.tasks.map((entry) => entry.id)).toEqual(['retainer-done', 'billing-done'])
    // The rows in that group arrive from two sections and the list itself, and nothing else on the
    // screen says so; the open groups each stand under a heading that already names their section.
    expect(done?.showList).toBe(true)
    expect(groups.find((group) => group.key === 'unsectioned')?.showList).toBeUndefined()
  })

  it('keeps a row the sections do not explain in the list own group rather than dropping it', () => {
    // The page came from the server already scoped, so a row here that matches no section is a row the
    // reader was told about. Dropping it to keep the grouping tidy is the worse answer.
    const groups = groupBySection([task('elsewhere', { listId: 'somewhere-else' })], sections)
    expect(groups[0]!.tasks.map((entry) => entry.id)).toEqual(['elsewhere'])
  })
})

describe('a list', () => {
  it('reads open tasks first and finished ones last, in the page order', () => {
    const groups = groupByList([
      task('done', { status: 'done', completedAt: 5 }),
      task('later', { dueAt: NOW + 5 * DAY }),
      task('sooner', { dueAt: NOW + DAY }),
    ])
    expect(groups.map((group) => [group.key, group.tasks.map((entry) => entry.id)])).toEqual([
      ['open', ['later', 'sooner']],
      ['done', ['done']],
    ])
  })

  it('keeps the stored order a drag just wrote, rather than sorting it away', () => {
    const groups = groupByList([
      task('moved-to-top', { dueAt: NOW + 9 * DAY }),
      task('dated-first'),
    ])
    expect(groups[0]!.tasks.map((entry) => entry.id)).toEqual(['moved-to-top', 'dated-first'])
  })

  it('holds a started row in the open group, beside the untouched ones', () => {
    // `groupByList` splits on the open/done predicate rather than on a status literal, because the list
    // screen is where a reader sees the work they are in the middle of. Filed into "done" it would sit
    // under the finished rows by completion time; dropped from both groups it would simply vanish from
    // a page the server had just listed it on.
    const groups = groupByList([
      task('finished', { status: 'done', completedAt: 5 }),
      task('started', { status: 'in_progress' }),
      task('untouched'),
    ])
    expect(groups.map((group) => [group.key, group.tasks.map((entry) => entry.id)])).toEqual([
      ['open', ['started', 'untouched']],
      ['done', ['finished']],
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

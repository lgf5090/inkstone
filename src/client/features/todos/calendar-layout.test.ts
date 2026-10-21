/**
 * The calendar's arithmetic, away from the DOM.
 *
 * These are the cases the eye forgives on screen and a reader notices a week later: a bar one column
 * too wide, two tasks due at the same hour drawn on top of each other, a spanning task that also shows
 * up as a chip. Each is a pure function, so each is pinned here.
 */
import { describe, expect, it } from 'vitest'
import type { TodoTask } from '@shared/todos/model'
import { allDayTasksForDay, dayChips, spansForWeek, timeBlocksForDay } from './calendar-layout'

const TZ = 'UTC'

function task(id: string, extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id,
    title: id,
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt: null,
    remindAt: null,
    remindedAt: null,
    plannedFor: null,
    completedAt: null,
    createdAt: 0,
    updatedAt: 0,
    listId: null,
    tags: [],
    starred: false,
    repeat: null,
    noteId: null,
    conversationId: null,
    projectId: null,
    stepTotal: 0,
    stepDone: 0,
    ...extra,
  } as TodoTask
}

const WEEK = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08']
const at = (day: string, hour = 9, minute = 0): number => Date.parse(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`)

describe('spanning tasks', () => {
  it('draws a bar from the day it starts to the day it is due', () => {
    const bars = spansForWeek([
      task('a', { startAt: at('2026-03-03'), dueAt: at('2026-03-05', 17) }),
    ], WEEK, TZ)
    expect(bars).toHaveLength(1)
    expect(bars[0]).toMatchObject({ startCol: 1, endCol: 3, lane: 0 })
  })

  it('clamps a bar that starts before the week and ends after it', () => {
    const bars = spansForWeek([
      task('a', { startAt: at('2026-02-20'), dueAt: at('2026-03-20') }),
    ], WEEK, TZ)
    expect(bars[0]).toMatchObject({ startCol: 0, endCol: 6 })
  })

  it('puts overlapping bars on separate lanes and reuses a lane once it is free', () => {
    const bars = spansForWeek([
      task('a', { startAt: at('2026-03-02'), dueAt: at('2026-03-05') }),
      task('b', { startAt: at('2026-03-04'), dueAt: at('2026-03-06') }),
      task('c', { startAt: at('2026-03-06'), dueAt: at('2026-03-08') }),
    ], WEEK, TZ)
    const lanes = new Map(bars.map((bar) => [bar.task.id, bar.lane]))
    expect(lanes.get('a')).toBe(0)
    expect(lanes.get('b')).toBe(1)
    // c starts where a ended, so it can share a's lane.
    expect(lanes.get('c')).toBe(0)
  })

  it('ignores a task due on one day, a finished task, and a task outside the week', () => {
    const bars = spansForWeek([
      task('single', { dueAt: at('2026-03-03') }),
      task('done', { startAt: at('2026-03-02'), dueAt: at('2026-03-04'), status: 'done' }),
      task('elsewhere', { startAt: at('2026-04-01'), dueAt: at('2026-04-03') }),
    ], WEEK, TZ)
    expect(bars).toEqual([])
  })
})

describe('a day’s chips', () => {
  it('keeps the tasks due that day, in clock order, and drops the ones a bar already covers', () => {
    const chips = dayChips([
      task('late', { dueAt: at('2026-03-03', 17) }),
      task('early', { dueAt: at('2026-03-03', 8) }),
      task('other-day', { dueAt: at('2026-03-04', 8) }),
      task('span', { startAt: at('2026-03-02'), dueAt: at('2026-03-03', 12) }),
      task('done', { dueAt: at('2026-03-03', 9), status: 'done' }),
    ], '2026-03-03', TZ)
    expect(chips.map((entry) => entry.id)).toEqual(['early', 'late'])
  })
})

describe('the hour axis', () => {
  it('draws a task that names a start time from that minute to its due minute', () => {
    const blocks = timeBlocksForDay([
      task('meeting', { startAt: at('2026-03-03', 9), dueAt: at('2026-03-03', 11) }),
    ], '2026-03-03', TZ)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ startMin: 540, endMin: 660, lane: 0 })
  })

  it('gives a bare due time a half-hour block and packs overlaps side by side', () => {
    const blocks = timeBlocksForDay([
      task('a', { dueAt: at('2026-03-03', 10) }),
      task('b', { dueAt: at('2026-03-03', 10, 10) }),
    ], '2026-03-03', TZ)
    expect(blocks.map((block) => [block.task.id, block.startMin, block.lane])).toEqual([
      ['a', 570, 0],
      ['b', 580, 1],
    ])
  })

  it('keeps all-day tasks off the axis', () => {
    const blocks = timeBlocksForDay([
      task('all-day', { dueAt: at('2026-03-03', 23, 59) }),
      task('span', { startAt: at('2026-03-02'), dueAt: at('2026-03-03', 12) }),
    ], '2026-03-03', TZ)
    expect(blocks).toEqual([])
  })
})

describe('the all-day strip', () => {
  it('carries an all-day task on its own day and a bar on every day it covers', () => {
    const tasks = [
      task('all-day', { dueAt: at('2026-03-04', 23, 59) }),
      task('span', { startAt: at('2026-03-02'), dueAt: at('2026-03-04', 12) }),
      task('timed', { dueAt: at('2026-03-04', 9) }),
    ]
    expect(allDayTasksForDay(tasks, '2026-03-02', TZ).map((entry) => entry.id)).toEqual(['span'])
    expect(allDayTasksForDay(tasks, '2026-03-04', TZ).map((entry) => entry.id).sort()).toEqual(['all-day', 'span'])
  })
})

/**
 * The arithmetic behind the calendar: which tasks span several days, where their bars sit, and where a
 * timed task lands on an hour axis.
 *
 * Kept out of the component because it is the part that can be wrong in ways the eye forgives — a bar
 * one column too wide, two overlapping blocks drawn on top of each other — and because a pure function
 * is what a test can pin. Everything is measured in the account's own days, the same calendar the
 * server counts in.
 */
import { localDate, toLocalMinute } from '@shared/assistant-time'
import type { TodoTask } from '@shared/todos/model'

/** A task that covers more than one day, as a bar across one week's columns. */
export interface SpanBar {
  task: TodoTask
  /** Column of the week the bar starts in, 0–6. */
  startCol: number
  endCol: number
  /** The row it is drawn on, so two bars never overlap. */
  lane: number
}

/** One timed task on a day's hour axis. */
export interface TimeBlock {
  task: TodoTask
  /** Minutes from midnight. */
  startMin: number
  endMin: number
  lane: number
}

const DAY_END_MINUTE = 'T23:59'

/** The day a task starts on: the start date it names, or its due date when it names none. */
export function taskStartKey(task: TodoTask, timezone: string): string | null {
  const instant = task.startAt ?? task.dueAt
  return instant === null || instant === undefined ? null : localDate(instant, timezone)
}

/** The day a task ends on: its due date. A task with no due date has no place on a calendar. */
export function taskEndKey(task: TodoTask, timezone: string): string | null {
  return task.dueAt === null ? null : localDate(task.dueAt, timezone)
}

/** Whether a task covers more than one day, which is what makes it a bar instead of a chip. */
export function isSpanning(task: TodoTask, timezone: string): boolean {
  const start = taskStartKey(task, timezone)
  const end = taskEndKey(task, timezone)
  return start !== null && end !== null && start < end
}

/**
 * The bars one week row draws.
 *
 * A bar is clamped to the week it is being drawn in, so a task that runs from the 28th to the 3rd is one
 * bar on each of two rows rather than a bar that overflows its grid. Lanes are assigned greedily by
 * start column, longest first, which is the same packing a month view of any calendar uses.
 */
export function spansForWeek(tasks: readonly TodoTask[], weekKeys: readonly string[], timezone: string): SpanBar[] {
  if (weekKeys.length === 0) return []
  const weekStart = weekKeys[0]!
  const weekEnd = weekKeys[weekKeys.length - 1]!
  const candidates: { task: TodoTask; startCol: number; endCol: number }[] = []
  for (const task of tasks) {
    if (task.status === 'done') continue
    const start = taskStartKey(task, timezone)
    const end = taskEndKey(task, timezone)
    if (start === null || end === null || start >= end) continue
    if (end < weekStart || start > weekEnd) continue
    const startCol = Math.max(0, weekKeys.indexOf(start < weekStart ? weekStart : start))
    const endCol = Math.min(weekKeys.length - 1, weekKeys.indexOf(end > weekEnd ? weekEnd : end))
    if (startCol < 0 || endCol < 0 || endCol < startCol) continue
    candidates.push({ task, startCol, endCol })
  }
  candidates.sort((left, right) => left.startCol - right.startCol || right.endCol - left.endCol)
  const laneEnds: number[] = []
  return candidates.map((candidate) => {
    let lane = laneEnds.findIndex((lastEnd) => lastEnd < candidate.startCol)
    if (lane < 0) {
      lane = laneEnds.length
      laneEnds.push(candidate.endCol)
    } else {
      laneEnds[lane] = candidate.endCol
    }
    return { ...candidate, lane }
  })
}

/** The tasks a day draws as chips: due that day and not part of a bar. */
export function dayChips(tasks: readonly TodoTask[], dayKey: string, timezone: string): TodoTask[] {
  return tasks
    .filter((task) => task.status !== 'done'
      && taskEndKey(task, timezone) === dayKey
      && !isSpanning(task, timezone))
    .sort((left, right) => (left.dueAt ?? 0) - (right.dueAt ?? 0))
}

/** The minute of the day an instant falls on, in the account's zone. */
function minuteOfInstant(instant: number, timezone: string): number {
  const minute = toLocalMinute(instant, timezone)
  const [hour, min] = minute.slice(11).split(':').map(Number)
  return (hour ?? 0) * 60 + (min ?? 0)
}

/** The minute of the day a task is due, or null when it is an all-day task. */
export function dueMinuteOf(task: TodoTask, timezone: string): number | null {
  if (task.dueAt === null) return null
  const minute = toLocalMinute(task.dueAt, timezone)
  if (minute.endsWith(DAY_END_MINUTE)) return null
  return minuteOfInstant(task.dueAt, timezone)
}

/** Whether a task belongs in the all-day strip rather than on the hour axis. */
export function isAllDay(task: TodoTask, timezone: string): boolean {
  return isSpanning(task, timezone) || dueMinuteOf(task, timezone) === null
}

/**
 * The timed blocks of one day, packed into lanes so two tasks due at the same hour sit side by side.
 *
 * A task that names a start time on the same day draws from that minute to its due minute; anything
 * else draws a half-hour block ending at its due time, because a single instant has no height and a
 * calendar still has to show it.
 */
export function timeBlocksForDay(tasks: readonly TodoTask[], dayKey: string, timezone: string): TimeBlock[] {
  const blocks: Omit<TimeBlock, 'lane'>[] = []
  for (const task of tasks) {
    if (task.status === 'done') continue
    if (taskEndKey(task, timezone) !== dayKey) continue
    if (isAllDay(task, timezone)) continue
    const due = dueMinuteOf(task, timezone)
    if (due === null) continue
    const startDay = task.startAt != null ? localDate(task.startAt, timezone) : null
    const startMinute = task.startAt != null && startDay === dayKey ? minuteOfInstant(task.startAt, timezone) : null
    const start = startMinute !== null && startMinute < due ? startMinute : Math.max(0, due - 30)
    blocks.push({ task, startMin: start, endMin: Math.max(start + 15, due) })
  }
  blocks.sort((left, right) => left.startMin - right.startMin || left.endMin - right.endMin)
  const laneEnds: number[] = []
  return blocks.map((block) => {
    let lane = laneEnds.findIndex((lastEnd) => lastEnd <= block.startMin)
    if (lane < 0) {
      lane = laneEnds.length
      laneEnds.push(block.endMin)
    } else {
      laneEnds[lane] = block.endMin
    }
    return { ...block, lane }
  })
}

/** The all-day tasks of one day: no clock time, or a bar that covers it. */
export function allDayTasksForDay(tasks: readonly TodoTask[], dayKey: string, timezone: string): TodoTask[] {
  return tasks.filter((task) => {
    if (task.status === 'done') return false
    const start = taskStartKey(task, timezone)
    const end = taskEndKey(task, timezone)
    if (start === null || end === null) return false
    if (start < end) return dayKey >= start && dayKey <= end
    return end === dayKey && isAllDay(task, timezone)
  })
}

/**
 * The focus history: one row per finished pomodoro phase, and the reads the statistics screen asks of it.
 *
 * The worklog sums time a task was tracked; this records the shape of a focus session — a work block,
 * a short break, a long break — including the phases that named no task and the blocks that ended
 * early. `day` is written here from the account's zone, never accepted from the client, so the history
 * and the rest of the app agree about which calendar day a block belongs to.
 */
import { localDate } from '@shared/assistant-time'
import type { FocusRunKind, TodoFocusDay, TodoFocusRun, TodoFocusStats } from '@shared/todos/model'
import { newId } from '../lib/id'
import { eachDay, isStatsDay } from './stats'

/** How many tasks one focus-history answer names before the rest are counted rather than listed. */
export const FOCUS_TASK_LIMIT = 20
/** The longest one phase may claim, in milliseconds: a day, which is longer than any legal block. */
export const MAX_FOCUS_PHASE_MS = 24 * 60 * 60_000

export interface FocusRunInput {
  taskId: string | null
  kind: FocusRunKind
  startedAt: number
  endedAt: number
  plannedMs: number
  actualMs: number
  completed: boolean
}

interface FocusDayRow {
  day: string
  work_ms: number | null
  rounds: number | null
}

interface FocusTaskRow {
  task_id: string
  title: string | null
  work_ms: number | null
  rounds: number | null
}

function isStamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** A phase duration inside the only window that can really exist. */
function isPhaseMs(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_FOCUS_PHASE_MS
}

export function focusRunProblem(input: FocusRunInput): string | null {
  if (input.kind !== 'work' && input.kind !== 'short_break' && input.kind !== 'long_break')
    return 'A focus record names a work block or a break.'
  if (!isStamp(input.startedAt) || !isStamp(input.endedAt)) return 'A focus record needs both instants.'
  if (input.endedAt < input.startedAt) return 'A focus record cannot end before it began.'
  if (!isPhaseMs(input.plannedMs) || !isPhaseMs(input.actualMs)) return 'A focus phase is outside the allowed length.'
  if (input.taskId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(input.taskId)) return 'A focus record names an invalid task id.'
  return null
}

/** Whether a task id names a row this account holds, which a focus record may point at. */
export async function focusTaskOwned(db: D1Database, userId: string, taskId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 FROM todos_tasks WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, taskId).first()
  return Boolean(row)
}

export async function recordFocusRun(
  db: D1Database,
  userId: string,
  input: FocusRunInput,
  timezone: string,
): Promise<TodoFocusRun> {
  const problem = focusRunProblem(input)
  if (problem) throw new Error(problem)
  const id = newId()
  const now = Date.now()
  const day = localDate(input.endedAt, timezone)
  await db.prepare(
    `INSERT INTO todos_focus_runs
       (user_id, id, task_id, kind, started_at, ended_at, planned_ms, actual_ms, completed, day, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  ).bind(
    userId, id, input.taskId, input.kind, input.startedAt, input.endedAt,
    Math.trunc(input.plannedMs), Math.trunc(input.actualMs), input.completed ? 1 : 0, day, now,
  ).run()
  return {
    id,
    taskId: input.taskId,
    kind: input.kind,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    plannedMs: Math.trunc(input.plannedMs),
    actualMs: Math.trunc(input.actualMs),
    completed: input.completed,
    day,
    createdAt: now,
  }
}

function toDay(row: FocusDayRow | null | undefined, day: string): TodoFocusDay {
  return {
    day,
    workMs: Number(row?.work_ms ?? 0),
    rounds: Number(row?.rounds ?? 0),
  }
}

export async function loadFocusStats(
  db: D1Database,
  userId: string,
  query: { from: string; to: string; timezone: string; now: number },
): Promise<TodoFocusStats> {
  const { from, to, timezone, now } = query
  if (!isStatsDay(from) || !isStatsDay(to)) throw new Error('A focus window is a pair of YYYY-MM-DD days')
  const today = localDate(now, timezone)
  const window = [userId, from, to]

  const totals = await db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'work' THEN actual_ms ELSE 0 END), 0) AS work_ms,
            COALESCE(SUM(CASE WHEN kind <> 'work' THEN actual_ms ELSE 0 END), 0) AS break_ms,
            SUM(CASE WHEN kind = 'work' THEN 1 ELSE 0 END) AS work_rounds,
            SUM(CASE WHEN kind = 'work' AND completed = 1 THEN 1 ELSE 0 END) AS completed_rounds
       FROM todos_focus_runs
      WHERE user_id = ?1 AND day >= ?2 AND day <= ?3`,
  ).bind(...window).first<{ work_ms: number | null; break_ms: number | null; work_rounds: number | null; completed_rounds: number | null }>()

  const perDay = await db.prepare(
    `SELECT day,
            SUM(CASE WHEN kind = 'work' THEN actual_ms ELSE 0 END) AS work_ms,
            SUM(CASE WHEN kind = 'work' THEN 1 ELSE 0 END) AS rounds
       FROM todos_focus_runs
      WHERE user_id = ?1 AND day >= ?2 AND day <= ?3
      GROUP BY day`,
  ).bind(...window).all<FocusDayRow>()

  const perTask = await db.prepare(
    `SELECT f.task_id AS task_id, t.title AS title,
            SUM(f.actual_ms) AS work_ms,
            COUNT(*) AS rounds
       FROM todos_focus_runs f
       LEFT JOIN todos_tasks t ON t.user_id = f.user_id AND t.id = f.task_id
      WHERE f.user_id = ?1 AND f.day >= ?2 AND f.day <= ?3 AND f.kind = 'work' AND f.task_id IS NOT NULL
      GROUP BY f.task_id, t.title
      ORDER BY work_ms DESC
      LIMIT ?4`,
  ).bind(...window, FOCUS_TASK_LIMIT + 1).all<FocusTaskRow>()

  const todayRow = await db.prepare(
    `SELECT day,
            SUM(CASE WHEN kind = 'work' THEN actual_ms ELSE 0 END) AS work_ms,
            SUM(CASE WHEN kind = 'work' THEN 1 ELSE 0 END) AS rounds
       FROM todos_focus_runs
      WHERE user_id = ?1 AND day = ?2
      GROUP BY day`,
  ).bind(userId, today).first<FocusDayRow>()

  const days = new Map((perDay.results ?? []).map((row) => [row.day, row]))
  const tasks = (perTask.results ?? []).map((row) => ({
    taskId: row.task_id,
    title: row.title ?? '',
    workMs: Number(row.work_ms ?? 0),
    rounds: Number(row.rounds ?? 0),
  }))
  const truncated = Math.max(0, tasks.length - FOCUS_TASK_LIMIT)

  return {
    range: { from, to },
    workMs: Number(totals?.work_ms ?? 0),
    breakMs: Number(totals?.break_ms ?? 0),
    workRounds: Number(totals?.work_rounds ?? 0),
    completedRounds: Number(totals?.completed_rounds ?? 0),
    today: toDay(todayRow, today),
    byDay: eachDay(from, to).map((day) => toDay(days.get(day), day)),
    byTask: tasks.slice(0, FOCUS_TASK_LIMIT),
    truncatedTasks: truncated,
  }
}

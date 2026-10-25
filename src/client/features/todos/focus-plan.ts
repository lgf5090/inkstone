/**
 * The arithmetic a focus session runs on, written down where it can be read.
 *
 * Three strategies and one settings group produce a handful of numbers, and every one of them is a rule a
 * reader can be annoyed by when it is wrong: how long the first block is, which break comes next, when
 * flowtime has earned the right to interrupt, and how far the ± row may push a plan. They live here rather
 * than inside the panel because the panel is the worst place in the app to test an arithmetic claim, and
 * because a rule stated twice is a rule that eventually means two different things.
 *
 * Nothing in this file reads the clock, the store, or the DOM. It takes settings and a task's own numbers
 * and answers with milliseconds — `null` where a strategy names no length at all, which is flowtime's
 * whole point.
 */
import { TODO_FOCUS_MINUTES_RANGE } from '@shared/constants'
import type { TodoFocusSettings, TodoFocusSound, TodoFocusStrategy } from '@shared/types'
import type { AudioCue } from '../../lib/audio-cues'

const MINUTE_MS = 60_000

/**
 * How far the ± row moves a block, in whole minutes.
 *
 * Five is the step a reader can reach without breaking concentration and large enough that four presses
 * cross an hour; the settings' own range bounds where the row may land, not how far it travels.
 */
export const FOCUS_NUDGE_MINUTES = 5

/** What a row's plan still has left to work, or null when nobody estimated the task. */
export function remainingEstimateMs(task: { timeEstimateMs?: number | null, timeSpentMs?: number }): number | null {
  const estimate = task.timeEstimateMs ?? null
  if (estimate === null) return null
  return estimate - (task.timeSpentMs ?? 0)
}

/** Whole minutes a length holds, with the part minute left off: the floor, not the nearest. */
export function minutesFloor(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.floor(ms / MINUTE_MS)
}

/** A whole number of minutes held to the range the settings themselves declare. */
function clampedMinutes(minutes: number): number {
  return Math.min(TODO_FOCUS_MINUTES_RANGE[1], Math.max(TODO_FOCUS_MINUTES_RANGE[0], minutes)) * MINUTE_MS
}

/**
 * How long the block a session opens on runs, or null when the strategy plans no length.
 *
 * Countdown is the one rule with a wrinkle worth stating: the shorter of the reader's default and what the
 * task's own estimate still leaves, floored to whole minutes and then held to the shortest block the
 * settings can name. The floor is what keeps a promise honest — twenty-four and a half minutes left is not
 * a twenty-five minute block — and an estimate already worked out lands on the shortest legal block rather
 * than on the default, because a session may not promise time the plan says is gone.
 */
export function plannedBlockMs(
  strategy: TodoFocusStrategy,
  settings: TodoFocusSettings,
  task: { timeEstimateMs?: number | null, timeSpentMs?: number },
): number | null {
  if (strategy === 'flowtime') return null
  if (strategy === 'pomodoro') return settings.pomodoro.work * MINUTE_MS
  const defaultMs = settings.defaultMinutes * MINUTE_MS
  const left = remainingEstimateMs(task)
  if (left === null) return defaultMs
  return clampedMinutes(minutesFloor(Math.min(defaultMs, left)))
}

/** A whole-minute share of the work just done: what flowtime thinks a break of that block would cost. */
export function flowtimeBreakMs(workedMs: number, settings: TodoFocusSettings): number {
  const share = workedMs * (settings.flowtime.breakPercentage / 100)
  return minutesFloor(share) * MINUTE_MS
}

/**
 * Whether flowtime has worked long enough to say something about a break.
 *
 * The threshold is derived rather than picked: a suggestion is worth making as soon as the break it would
 * name is a whole minute long, which is the shortest length this app will hold anywhere. Anything earlier
 * is an interruption on behalf of a break that could not be taken.
 */
export function flowtimeBreakDue(settings: TodoFocusSettings, workedMs: number): boolean {
  if (!settings.flowtime.breakEnabled) return false
  return flowtimeBreakMs(workedMs, settings) >= MINUTE_MS
}

/**
 * The break a finished block leads into, or null for a session that has none to offer.
 *
 * `round` is how many work blocks have finished, so the first one ends with it at one and a long break
 * falls on the rounds `every` names. Countdown carries no break in its own settings, and inventing one
 * would be a length nobody asked for.
 */
export function breakAfterBlock(
  strategy: TodoFocusStrategy,
  settings: TodoFocusSettings,
  round: number,
  workedMs: number,
): number | null {
  if (strategy === 'countdown') return null
  if (strategy === 'flowtime') {
    const suggested = flowtimeBreakMs(workedMs, settings)
    return flowtimeBreakDue(settings, workedMs) ? suggested : null
  }
  const pomodoro = settings.pomodoro
  return round % pomodoro.every === 0 ? pomodoro.long * MINUTE_MS : pomodoro.short * MINUTE_MS
}

/** The plan after one ± press: whole minutes in, whole minutes out, and never past the settings' edges. */
export function nudgedBlockMs(blockMs: number, deltaMinutes: number): number {
  return clampedMinutes(minutesFloor(blockMs) + deltaMinutes)
}

/**
 * Whether a sound level says this cue out loud.
 *
 * The four levels are the settings' words and the two cues are what the synthesiser can make, so this is
 * the one place that has to know which words mean which cue — `both` being both, and `off` being neither.
 */
export function focusSoundPlays(level: TodoFocusSound, cue: AudioCue): boolean {
  if (level === 'off') return false
  if (level === 'both') return true
  return level === cue
}

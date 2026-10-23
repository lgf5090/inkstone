// @vitest-environment node
/**
 * The focus session's arithmetic, before any of it is drawn.
 *
 * Three of the four things here are rules a reader can be annoyed by when they are wrong, and none of
 * them needs a DOM: how long a countdown block takes, which break a pomodoro round leads into, when
 * flowtime has earned a suggestion, and what the ± row may do to a plan. The fourth is what the sound
 * setting promises, because `both` and `off` are four words the overlay has to read the same way every
 * time a cue is due.
 *
 * The floor is the part that is easy to get wrong and hard to see: a remaining estimate of ninety seconds
 * is not a twenty-four-and-a-half-minute block, and it is not a zero-minute block either — it is the one
 * minute the settings themselves call the shortest meaningful length.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_TODO_FOCUS, TODO_FOCUS_MINUTES_RANGE } from '@shared/constants'
import type { TodoFocusSettings } from '@shared/types'
import {
  FOCUS_NUDGE_MINUTES,
  breakAfterBlock,
  flowtimeBreakMs,
  flowtimeBreakDue,
  focusSoundPlays,
  minutesFloor,
  nudgedBlockMs,
  plannedBlockMs,
  remainingEstimateMs,
} from './focus-plan'

const MINUTE = 60_000

/** Settings with one key changed, so a case names only what it is about. */
function settings(patch: Partial<TodoFocusSettings> = {}): TodoFocusSettings {
  return { ...DEFAULT_TODO_FOCUS, ...patch }
}

/** A row with an estimate and a ledger, which is everything the plan reads off a task. */
function task(estimateMs: number | null, spentMs: number): { timeEstimateMs: number | null; timeSpentMs: number } {
  return { timeEstimateMs: estimateMs, timeSpentMs: spentMs }
}

describe('what a plan still has left to work', () => {
  it('says nothing when nobody estimated the task', () => {
    // Null, not zero: a row without a plan has no ceiling to run a session against,
    // and 0 would tell the countdown to start at nothing.
    expect(remainingEstimateMs(task(null, 0))).toBeNull()
    expect(remainingEstimateMs(task(null, 45 * MINUTE))).toBeNull()
  })

  it('takes the ledger off the plan', () => {
    expect(remainingEstimateMs(task(120 * MINUTE, 45 * MINUTE))).toBe(75 * MINUTE)
    expect(remainingEstimateMs(task(120 * MINUTE, 0))).toBe(120 * MINUTE)
  })

  it('goes negative once the work has outgrown the plan, rather than clamping to zero', () => {
    // The floor is the caller's decision, not this function's. `plannedBlockMs` has to be able to
    // tell "an hour left" from "two hours over", and a clamp here would make them the same answer.
    expect(remainingEstimateMs(task(60 * MINUTE, 180 * MINUTE))).toBe(-120 * MINUTE)
  })
})

describe('the length a countdown block takes', () => {
  it('is the default when the task plans nothing', () => {
    expect(plannedBlockMs('countdown', settings({ defaultMinutes: 25 }), task(null, 0))).toBe(25 * MINUTE)
  })

  it('is the shorter of the default and what the estimate still leaves', () => {
    // Ninety minutes planned and nothing worked: the estimate leaves more than the default asks for, so
    // the default is what a session takes.
    expect(plannedBlockMs('countdown', settings({ defaultMinutes: 25 }), task(90 * MINUTE, 0))).toBe(25 * MINUTE)
    // Fifteen minutes planned: the plan is the shorter of the two, and a block that promised twenty-five
    // would be a promise the reader already knows they did not make.
    expect(plannedBlockMs('countdown', settings({ defaultMinutes: 25 }), task(15 * MINUTE, 0))).toBe(15 * MINUTE)
  })

  it('works the already-spent time off the estimate first', () => {
    // Two hours planned, an hour and fifty worked: thirty minutes are left, and the block takes them.
    expect(plannedBlockMs('countdown', settings({ defaultMinutes: 25 }), task(120 * MINUTE, 110 * MINUTE))).toBe(10 * MINUTE)
  })

  it('floors a part minute rather than rounding it up', () => {
    // The case the plan names: the remainder is twenty-four and a half minutes, and a clock that said
    // 25:00 would be promising thirty seconds of work that the estimate does not have.
    expect(plannedBlockMs('countdown', settings({ defaultMinutes: 25 }), task(45 * MINUTE, 20 * MINUTE + 30_000))).toBe(24 * MINUTE)
    expect(minutesFloor(90_000)).toBe(1)
    expect(minutesFloor(59_999)).toBe(0)
  })

  it('never opens a block of no length, and never one shorter than the settings floor', () => {
    // An estimate fully worked out, and one with ninety seconds left, both land on the shortest length
    // the settings will hold rather than on a session that ends the moment it starts.
    expect(plannedBlockMs('countdown', settings({ defaultMinutes: 25 }), task(30 * MINUTE, 30 * MINUTE)))
      .toBe(TODO_FOCUS_MINUTES_RANGE[0] * MINUTE)
    expect(plannedBlockMs('countdown', settings({ defaultMinutes: 25 }), task(30 * MINUTE, 28 * MINUTE + 30_000)))
      .toBe(1 * MINUTE)
  })

  it('takes the pomodoro work length for a pomodoro and no length at all for flowtime', () => {
    const long = settings({ pomodoro: { ...DEFAULT_TODO_FOCUS.pomodoro, work: 18 } })
    expect(plannedBlockMs('pomodoro', long, task(90 * MINUTE, 0))).toBe(18 * MINUTE)
    // Flowtime is the strategy that refuses to plan a length; a number here would be the thing it exists
    // to avoid, and the ring reads `null` as "count up, not down".
    expect(plannedBlockMs('flowtime', settings(), task(90 * MINUTE, 0))).toBeNull()
  })
})

describe('the break a finished block leads into', () => {
  const cycle = settings({ pomodoro: { work: 25, short: 5, long: 15, every: 4 } })

  it('is the short break until the round the long one comes at', () => {
    // `round` is how many blocks have finished, so the first block ends with one done.
    expect(breakAfterBlock('pomodoro', cycle, 1, 25 * MINUTE)).toBe(5 * MINUTE)
    expect(breakAfterBlock('pomodoro', cycle, 3, 75 * MINUTE)).toBe(5 * MINUTE)
    expect(breakAfterBlock('pomodoro', cycle, 4, 100 * MINUTE)).toBe(15 * MINUTE)
    expect(breakAfterBlock('pomodoro', cycle, 8, 200 * MINUTE)).toBe(15 * MINUTE)
  })

  it('is nothing at all for a countdown', () => {
    // Countdown carries no break in its own settings, and inventing one here would be a length the
    // reader never asked for.
    expect(breakAfterBlock('countdown', cycle, 1, 25 * MINUTE)).toBeNull()
  })

  it('is the flowtime suggestion only while the suggestion is switched on', () => {
    const on = settings({ flowtime: { breakEnabled: true, breakPercentage: 20 } })
    const off = settings({ flowtime: { breakEnabled: false, breakPercentage: 20 } })
    expect(breakAfterBlock('flowtime', on, 1, 60 * MINUTE)).toBe(12 * MINUTE)
    expect(breakAfterBlock('flowtime', off, 1, 60 * MINUTE)).toBeNull()
  })

  it('measures a flowtime break against the work just done, in whole minutes', () => {
    const on = settings({ flowtime: { breakEnabled: true, breakPercentage: 20 } })
    expect(flowtimeBreakMs(60 * MINUTE, on)).toBe(12 * MINUTE)
    // Forty-five seconds of the break's own minute is not a minute of break.
    expect(flowtimeBreakMs(6 * MINUTE + 45_000, on)).toBe(1 * MINUTE)
    expect(flowtimeBreakMs(4 * MINUTE, on)).toBe(0)
  })

  it('suggests one only once the break it would name is a whole minute long', () => {
    const on = settings({ flowtime: { breakEnabled: true, breakPercentage: 20 } })
    // The threshold is derived, not chosen: a fifth of five minutes is the first whole minute a fifth
    // of anything can be, so the nudge arrives at five minutes and not before.
    expect(flowtimeBreakDue(on, 4 * MINUTE + 59_000)).toBe(false)
    expect(flowtimeBreakDue(on, 5 * MINUTE)).toBe(true)
    expect(flowtimeBreakDue(settings({ flowtime: { breakEnabled: false, breakPercentage: 20 } }), 90 * MINUTE)).toBe(false)
  })
})

describe('the duration the ± row may ask for', () => {
  it('moves by the step it names and holds to the range the settings hold', () => {
    expect(nudgedBlockMs(25 * MINUTE, FOCUS_NUDGE_MINUTES)).toBe(30 * MINUTE)
    expect(nudgedBlockMs(25 * MINUTE, -FOCUS_NUDGE_MINUTES)).toBe(20 * MINUTE)
    // The edges are the ones `TODO_FOCUS_MINUTES_RANGE` declares, so the row cannot nudge a block past
    // what the settings field itself would refuse to store.
    expect(nudgedBlockMs(238 * MINUTE, FOCUS_NUDGE_MINUTES)).toBe(TODO_FOCUS_MINUTES_RANGE[1] * MINUTE)
    expect(nudgedBlockMs(3 * MINUTE, -FOCUS_NUDGE_MINUTES)).toBe(TODO_FOCUS_MINUTES_RANGE[0] * MINUTE)
  })

  it('keeps a whole number of minutes whatever the block was holding', () => {
    // A block floored to a whole minute stays one after a nudge: part minutes would leave the ring and
    // the ledger disagreeing about what the reader planned.
    expect(nudgedBlockMs(minutesFloor(24.5 * MINUTE) * MINUTE, FOCUS_NUDGE_MINUTES)).toBe(29 * MINUTE)
  })
})

describe('what a sound level says out loud', () => {
  it('plays nothing at all when the level is off', () => {
    expect(focusSoundPlays('off', 'tick')).toBe(false)
    expect(focusSoundPlays('off', 'chime')).toBe(false)
  })

  it('splits the two cues the two levels name, and gives both to `both`', () => {
    expect(focusSoundPlays('tick', 'tick')).toBe(true)
    expect(focusSoundPlays('tick', 'chime')).toBe(false)
    expect(focusSoundPlays('chime', 'tick')).toBe(false)
    expect(focusSoundPlays('chime', 'chime')).toBe(true)
    expect(focusSoundPlays('both', 'tick')).toBe(true)
    expect(focusSoundPlays('both', 'chime')).toBe(true)
  })
})

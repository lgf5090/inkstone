/**
 * One focus session's own state, and the transitions a reader can ask it for.
 *
 * Deliberately not in `store.ts`. The to-do store owns the listing — what rows are on screen, what the
 * server says about them — and a session is none of that: it is a temporary, single-surface fact about
 * *this* block of work. `AGENTS.md` rule 7 puts state at its smallest scope, and the plan's card says the
 * same thing: a local slice, not the global store. Keeping it here is also what lets the panel, the strip
 * that replaces it while it is hidden, and the keyboard all read one answer without any of them owning it.
 *
 * Two separations hold the file together.
 *
 * The ledger is the server's. Nothing here keeps a second copy of "which task is being timed": opening and
 * closing an interval goes through `startTimer`/`stopTimer` on the to-do store, which are the same doors the
 * card's ▶ and the top bar already use. This module decides *when* the interval is open — at a block's
 * start, not during a break the settings say costs no time — and the server decides what the interval is.
 *
 * Elapsed time is nobody's state. The session stores the instant a phase began running and the amount it had
 * gone when it was last held, and every reading in between is a subtraction against `performance.now()`, the
 * same monotonic clock the running bar counts on. A `Date.now()` difference would let a corrected system
 * clock move a block that is in progress, which is the failure that bar exists to avoid.
 */
import { create } from 'zustand'
import { DEFAULT_TODO_FOCUS } from '@shared/constants'
import type { TodoFocusSettings, TodoFocusStrategy } from '@shared/types'
import type { TodoTask } from '@shared/todos/model'
import { isTaskDone } from '@shared/todos/status'
import { playCue, releaseCues, unlockCues } from '../../lib/audio-cues'
import { useSession } from '../../store/session'
import { useTodos } from './store'
import {
  breakAfterBlock,
  focusSoundPlays,
  nudgedBlockMs,
  plannedBlockMs,
} from './focus-plan'

/** The panel's three screens. `break` is a phase of its own, not a state of the block. */
export type FocusScreen = 'main' | 'session-done' | 'break'

/**
 * Whether the current phase's clock is going.
 *
 * `ready` is a session the reader has opened but not started: the panel is on screen, nothing is timed, and
 * the button says "start". It is not the same as `paused`, because pausing has a block behind it to return to.
 */
export type FocusRunState = 'ready' | 'running' | 'paused'

export interface FocusSession {
  taskId: string
  strategy: TodoFocusStrategy
  screen: FocusScreen
  runState: FocusRunState
  /**
   * Whether the panel is on screen.
   *
   * Escape sets this to false and leaves everything else alone — that one bit is the whole of C9. The strip
   * in the frame's header takes over the countdown while it is false, so a reflexive key never costs a block.
   */
  visible: boolean
  /** Whether the session's own settings strip is open inside the panel. */
  settingsOpen: boolean
  /** The block being worked through, or null for flowtime's refusal to plan a length. */
  blockMs: number | null
  /** The break on offer, or already being sat through. Zero is "this session has no break". */
  breakMs: number
  /** Blocks this session has finished, which is what a pomodoro's long break is counted against. */
  round: number
  /** Work the finished blocks of this session logged, which is what flowtime measures a suggestion against. */
  workedMs: number
  /** How far the current phase had gone when it was last held, in milliseconds. */
  heldMs: number
  /** The monotonic instant the current phase began running, or null while it is not running. */
  anchorPerf: number | null
}

interface FocusSessionState {
  session: FocusSession | null
  /** Put the panel on screen for one task, ready to start and timing nothing. */
  open: (taskId: string) => void
  /** Take the panel off the screen without touching the session or its interval. */
  hide: () => void
  show: () => void
  /** The one button for "the clock and the interval": it starts, holds, or picks up again. */
  toggleRun: () => void
  restart: () => void
  /** Move the planned block by whole minutes. Flowtime has no plan, so it says nothing. */
  nudge: (deltaMinutes: number) => void
  setStrategy: (strategy: TodoFocusStrategy) => void
  setSettingsOpen: (open: boolean) => void
  /** File the block that has just gone and stop its clock, leaving the session on screen. */
  finishBlock: () => void
  /** Enter the break the finished block named, filing the block first when it is still live. */
  beginBreak: () => void
  /** Come off the break early. */
  skipBreak: () => void
  /** Begin the next block, which is what a finished break and a "one more" press both mean. */
  nextBlock: () => void
  /** Close the session and the interval it owns. The cancel gesture reaches here through the confirm. */
  endSession: () => void
  /** Finish the task itself: the interval is filed, the row is ticked, the session is over. */
  completeTask: () => void
  /** One second of the session's clock, asked for by the panel's ticker. */
  tick: () => void
}

/** How long a whole minute is, in the only unit this module and the ledger both speak. */
const MINUTE_MS = 60_000

/** The account's focus settings, read when a decision needs them rather than copied into the session. */
function focusSettings(): TodoFocusSettings {
  return useSession.getState().settings.todo.focus ?? DEFAULT_TODO_FOCUS
}

/** The row the session is on, read from the listing that owns rows. Null once it has left the page. */
function sessionTask(taskId: string): TodoTask | null {
  const state = useTodos.getState()
  return state.tasks.find((entry) => entry.id === taskId)
    ?? state.completed.find((entry) => entry.id === taskId)
    ?? null
}

/** Open the account's one interval on this task, through the door every other timer gesture uses. */
function openLedger(task: TodoTask): void {
  void useTodos.getState().startTimer(task)
}

/** File the interval and stop it. The split across days is the server's arithmetic, not this file's. */
function closeLedger(taskId: string): void {
  void useTodos.getState().stopTimer(taskId)
}

/**
 * The two ledger gestures, each asked of the account's mirrored state rather than of a flag of our own.
 *
 * `runningSince` is what the server says is open, and `ux_todos_time_open` says at most one row is — so the
 * mirror is the only honest reading of "is there an interval to open?", and a session with its own copy of
 * that answer would be the second truth the plan refuses. The mirror is written a beat after the gesture, so
 * the worst a stale reading can do is one redundant call; both endpoints are already idempotent about it.
 */
function openLedgerUnlessRunning(taskId: string): void {
  const task = sessionTask(taskId)
  if (task && task.runningSince == null) openLedger(task)
}

function closeLedgerIfRunning(taskId: string): void {
  const task = sessionTask(taskId)
  if (task && task.runningSince != null) closeLedger(taskId)
}

/**
 * Whether a block ending leaves the interval open.
 *
 * Two conditions have to hold: a break has to follow at all, and the reader has to have said that a break
 * costs the task nothing. A session with no break after it may not leave a clock running over a screen
 * nobody is working from.
 */
function keepsLedgerOpen(settings: TodoFocusSettings, nextBreakMs: number | null): boolean {
  return nextBreakMs !== null && !settings.pauseTrackingDuringBreak
}

/** The clock the panel paints: what a phase has gone, including the part since it was last read. */
export function phaseElapsedMs(session: FocusSession, now: number): number {
  const live = session.anchorPerf === null ? 0 : Math.max(0, now - session.anchorPerf)
  return session.heldMs + live
}

/**
 * What the current phase still has of its plan, or null where there is nothing to count down.
 *
 * Two of the three answers are the block and the break, which is what a reader is watching. The third is
 * the screen between a block and what comes next: no clock is running there, and a number that looked like a
 * countdown would be a promise about a phase that has not begun. Flowtime's main screen is null for the same
 * reason read from the other side — the strategy refuses to plan a length at all.
 */
export function phaseRemainingMs(session: FocusSession, now: number): number | null {
  if (session.screen === 'session-done') return null
  const plan = session.screen === 'break' ? session.breakMs : session.blockMs
  if (plan === null) return null
  return Math.max(0, plan - phaseElapsedMs(session, now))
}

/** The plan a phase of this strategy starts with, read off the task's own numbers. */
function blockPlan(session: FocusSession, settings: TodoFocusSettings, task: TodoTask): number | null {
  return plannedBlockMs(session.strategy, settings, task)
}

export const useFocusSession = create<FocusSessionState>()((set, get) => ({
  session: null,

  open: (taskId) => {
    const task = sessionTask(taskId)
    // A row that is not on the page any more has nothing to focus. Said by the panel not opening rather
    // than by a message: the reader pressed a key on a row that had already left.
    if (!task) return
    const settings = focusSettings()
    set({
      session: {
        taskId,
        strategy: settings.strategy,
        screen: 'main',
        runState: 'ready',
        visible: true,
        settingsOpen: false,
        blockMs: plannedBlockMs(settings.strategy, settings, task),
        breakMs: 0,
        round: 0,
        workedMs: 0,
        heldMs: 0,
        anchorPerf: null,
      },
    })
  },

  hide: () => {
    // The whole of C9 in one line: the panel goes away and the session — interval, anchors, block — stays
    // exactly where it was.
    set((state) => (state.session ? { session: { ...state.session, visible: false } } : state))
  },

  show: () => {
    set((state) => (state.session ? { session: { ...state.session, visible: true } } : state))
  },

  toggleRun: () => {
    const session = get().session
    if (!session) return
    if (session.runState === 'running') {
      // Freezing the clock and closing the interval are the same gesture: time nobody is working is not
      // time the ledger should be collecting, and a resumed block opens an interval of its own.
      const heldMs = phaseElapsedMs(session, performance.now())
      closeLedgerIfRunning(session.taskId)
      set({ session: { ...session, runState: 'paused', heldMs, anchorPerf: null } })
      return
    }
    if (!sessionTask(session.taskId)) return
    // Created or woken inside this press: an AudioContext made anywhere else is one the autoplay policy
    // leaves parked, and a focus timer that promises a tick and says nothing is worse than a silent one.
    unlockCues()
    set({ session: { ...session, runState: 'running', anchorPerf: performance.now() } })
    openLedgerUnlessRunning(session.taskId)
  },

  /**
   * Begin the block again from zero.
   *
   * The interval is left alone: what the ledger keeps is time on the task, not time within one plan of it,
   * and the minutes thrown away by a restart were still worked. Splitting the ledger at a restart would be a
   * second bookkeeping of a fact the row already carries.
   */
  restart: () => {
    const session = get().session
    if (!session) return
    const running = session.runState === 'running'
    set({
      session: {
        ...session,
        screen: 'main',
        heldMs: 0,
        anchorPerf: running ? performance.now() : null,
      },
    })
  },

  nudge: (deltaMinutes) => {
    const session = get().session
    // Flowtime is the strategy that plans no length, so there is nothing for the row to move. The panel
    // leaves the two buttons out rather than offering a press that would answer with nothing.
    if (!session || session.blockMs === null) return
    set({ session: { ...session, blockMs: nudgedBlockMs(session.blockMs, deltaMinutes) } })
  },

  setStrategy: (strategy) => {
    const session = get().session
    const task = session ? sessionTask(session.taskId) : null
    if (!session || !task) return
    const settings = focusSettings()
    const running = session.runState === 'running'
    const next: FocusSession = { ...session, strategy }
    set({
      session: {
        ...next,
        blockMs: blockPlan(next, settings, task),
        screen: 'main',
        breakMs: 0,
        heldMs: 0,
        anchorPerf: running ? performance.now() : null,
      },
    })
  },

  setSettingsOpen: (open) => {
    set((state) => (state.session ? { session: { ...state.session, settingsOpen: open } } : state))
  },

  finishBlock: () => {
    const session = get().session
    if (!session || session.screen !== 'main') return
    const settings = focusSettings()
    const worked = phaseElapsedMs(session, performance.now())
    const round = session.round + 1
    const workedMs = session.workedMs + worked
    const nextBreak = breakAfterBlock(session.strategy, settings, round, workedMs)
    if (!keepsLedgerOpen(settings, nextBreak)) closeLedgerIfRunning(session.taskId)
    if (focusSoundPlays(settings.sound, 'chime')) playCue('chime')
    set({
      session: {
        ...session,
        screen: 'session-done',
        runState: 'paused',
        round,
        workedMs,
        breakMs: nextBreak ?? 0,
        heldMs: 0,
        anchorPerf: null,
      },
    })
  },

  beginBreak: () => {
    const current = get().session
    if (!current) return
    // A break asked for from the block itself is the flowtime nudge, which means the block has to be
    // filed before the break can be counted.
    if (current.screen !== 'session-done') get().finishBlock()
    const session = get().session
    if (!session || session.breakMs < MINUTE_MS) return
    set({ session: { ...session, screen: 'break', runState: 'running', heldMs: 0, anchorPerf: performance.now() } })
  },

  skipBreak: () => {
    get().nextBlock()
  },

  nextBlock: () => {
    const session = get().session
    if (!session) return
    const task = sessionTask(session.taskId)
    const settings = focusSettings()
    if (!task) {
      get().endSession()
      return
    }
    set({
      session: {
        ...session,
        blockMs: blockPlan(session, settings, task),
        screen: 'main',
        runState: 'running',
        breakMs: 0,
        heldMs: 0,
        anchorPerf: performance.now(),
      },
    })
    // A break the reader let run out, or skipped, is followed by work: the interval comes back up only if
    // the account says none is open, which is the case whenever a break was left out of the worklog.
    openLedgerUnlessRunning(session.taskId)
  },

  endSession: () => {
    const session = get().session
    if (!session) return
    closeLedgerIfRunning(session.taskId)
    releaseCues()
    set({ session: null })
  },

  completeTask: () => {
    const session = get().session
    if (!session) return
    const task = sessionTask(session.taskId)
    closeLedgerIfRunning(session.taskId)
    const settings = focusSettings()
    if (focusSoundPlays(settings.sound, 'chime')) playCue('chime')
    if (task && !isTaskDone(task.status)) void useTodos.getState().toggleTask(task)
    releaseCues()
    set({ session: null })
  },

  tick: () => {
    const session = get().session
    // A held or unstarted phase has nothing to count, and a hidden panel still gets its tick: the reader
    // who pressed Escape is exactly the person whose block is about to end.
    if (!session || session.runState !== 'running' || session.anchorPerf === null) return
    const settings = focusSettings()
    const elapsed = phaseElapsedMs(session, performance.now())
    if (session.screen === 'break') {
      if (elapsed >= session.breakMs) {
        if (focusSoundPlays(settings.sound, 'chime')) playCue('chime')
        get().nextBlock()
      }
      return
    }
    if (session.screen !== 'main' || session.blockMs === null) return
    if (focusSoundPlays(settings.sound, 'tick')) playCue('tick')
    if (elapsed >= session.blockMs) get().finishBlock()
  },
}))

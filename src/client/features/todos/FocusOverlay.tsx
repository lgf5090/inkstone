/**
 * The focus panel: one task, one block, and the clock that says how far through it the reader is.
 *
 * The panel is a `Modal`, so the focus trap, the Escape route, the scroll lock and the backdrop are the
 * app's own and not a second set written here — rules 10 and 13, and the reuse list, all say so. What is
 * this surface's own business is the state machine under the panel: three screens — the block, the moment it
 * ends, and a break — over three strategies that disagree about whether a block has a length at all.
 *
 * `Esc` is the reason the file is shaped the way it is. It takes the panel off the screen and leaves the
 * session — the interval, the anchors, the countdown — running, and the strip this file also exports takes
 * the number over, because a reader who reflexively reaches for Escape must not lose twenty-five minutes of
 * work they were never trying to cancel. Stopping the interval is a different gesture, with a different name,
 * and it asks first through the app's own `confirm()`.
 *
 * Nothing here keeps time. The session store holds instants, `focus-plan` holds the arithmetic, and the only
 * clock this component reads is `performance.now()`, beat by beat — the same monotonic reading the running
 * bar counts on, so a corrected system clock cannot move a block that is in progress.
 *
 * The ring is hand-drawn SVG on the statistics page's pattern rather than a chart library: it is one circle
 * and one arc, and a third charting mechanism in this app would be the one the plan tells us not to add.
 */
import { useEffect, useRef, useState } from 'react'
import { Minus, Play, Plus, RotateCcw, Settings2, SkipForward, SquareCheckBig, StickyNote, X } from 'lucide-react'
import type { TodoFocusSettings, TodoFocusSound } from '@shared/types'
import { TODO_FOCUS_STRATEGIES } from '@shared/constants'
import type { TodoTask } from '@shared/todos/model'
import { formatRunningDuration } from '@shared/todos/duration'
import { t } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { Button, IconButton } from '../../components/primitives'
import { Input, Segmented, Switch, commitOnEnter } from '../../components/form'
import { Modal, confirm, prompt } from '../../components/overlay'
import { SelectMenu } from '../../components/select-menu'
import { useTodos } from './store'
import { FOCUS_NUDGE_MINUTES, breakAfterBlock, flowtimeBreakDue, flowtimeBreakMs } from './focus-plan'
import { phaseElapsedMs, phaseRemainingMs, useFocusSession } from './focus-session'
import type { FocusSession } from './focus-session'

/** How often the panel re-reads the monotonic clock, which is also the session's own beat. */
const BEAT_MS = 1_000
/** A minute, for the two places this file speaks whole minutes rather than milliseconds. */
const MINUTE_MS = 60_000
/** The ring's geometry in its own 100×100 space: a radius, and the width of the stroke drawn along it. */
const RING_RADIUS = 42
const RING_STROKE = 9
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** The four sound levels, in the order a reader would say them: nothing, each half, then both. */
const SOUND_LEVELS: readonly TodoFocusSound[] = ['off', 'tick', 'chime', 'both']

/**
 * The session's whole surface: the panel, or the strip that stands in for it.
 *
 * One component owns the beat and both faces are drawn from the number it reads, so the panel and the strip
 * cannot disagree about a block the way two independently polled clocks eventually would.
 */
export function FocusLayer() {
  const session = useFocusSession((state) => state.session)
  const now = useFocusBeat(session)
  if (!session) return null
  return (
    <>
      <FocusPanel session={session} now={now} />
      {session.visible ? null : <FocusStrip session={session} now={now} />}
    </>
  )
}

/**
 * The one heartbeat a session runs on.
 *
 * It advances the store's phase and puts the reading on the screen from the same interval — a second timer
 * for the display alone would be a second clock to fall out of step. Nothing is scheduled while the block is
 * held or unstarted: a frozen number needs no poll to stay frozen.
 */
function useFocusBeat(session: FocusSession | null): number {
  const [now, setNow] = useState(() => performance.now())
  const tick = useFocusSession((state) => state.tick)
  const running = session !== null && session.runState === 'running'
  useEffect(() => {
    if (!running) return
    const read = (): void => {
      setNow(performance.now())
      tick()
    }
    // A hidden tab throttles the interval to a beat every so often, so the phase may already have ended
    // while nobody was watching. Reading on the way back in is the whole of the catch-up.
    read()
    const beating = setInterval(read, BEAT_MS)
    document.addEventListener('visibilitychange', read)
    return () => {
      clearInterval(beating)
      document.removeEventListener('visibilitychange', read)
    }
  }, [running, tick])
  return now
}

function FocusPanel({ session, now }: { session: FocusSession; now: number }) {
  const task = useTodos((state) => state.tasks.find((entry) => entry.id === session.taskId)
    ?? state.completed.find((entry) => entry.id === session.taskId)
    ?? null)
  const settings = useSession((state) => state.settings.todo.focus) ?? null
  const actions = useFocusSession.getState()
  const suggested = flowtimeNudge(session, settings, now)

  return (
    <Modal
      open={session.visible}
      onClose={actions.hide}
      title={t('todo.focus.title')}
      width={620}
      footer={<Footer session={session} task={task} />}
    >
      <div data-focus-overlay="" data-focus-screen={session.screen} className="flex flex-col gap-4 pb-1">
        <header className="flex min-w-0 flex-wrap items-center gap-2">
          <Segmented
            label={t('settings.todo_focus_strategy')}
            size="sm"
            value={session.strategy}
            // The three words are the settings page's own, so one vocabulary names the strategies in both
            // places; a second set for the same three would eventually mean two things.
            options={TODO_FOCUS_STRATEGIES.map((strategy) => ({
              value: strategy,
              label: t(`settings.todo_focus_strategy_${strategy}`),
            }))}
            onChange={(strategy) => actions.setStrategy(strategy)}
            disabled={session.screen !== 'main'}
          />
          <Counter session={session} task={task} />
        </header>

        <TaskLine task={task} />

        {session.screen === 'session-done'
          ? (
              <SessionDone session={session} suggested={suggested} />
            )
          : (
              <div className="flex flex-col items-center gap-3">
                <ClockFace session={session} now={now} />
                <p className="text-[length:var(--text-12-5)] text-[var(--text-secondary)]">{captionFor(session, now)}</p>
                {session.screen === 'main' && <NudgeRow session={session} />}
              </div>
            )}

        {suggested !== null && (
          <Button variant="secondary" block data-focus-suggest-break="" onClick={actions.beginBreak}>
            {`${t('todo.focus.break_suggested')} · ${t('todo.focus.break_start')} ${formatRunningDuration(suggested)}`}
          </Button>
        )}

        {session.settingsOpen && <SessionSettings settings={settings} focus={session} />}
      </div>
    </Modal>
  )
}

/** What the block is, in the words the panel says beside the ring. */
function captionFor(session: FocusSession, now: number): string {
  const remaining = phaseRemainingMs(session, now)
  if (session.screen === 'break') return t('todo.focus.break_running')
  if (remaining === null) return t('todo.focus.time_worked', { time: formatRunningDuration(phaseElapsedMs(session, now)) })
  return t('todo.focus.time_left', { time: formatRunningDuration(remaining) })
}

/**
 * The ring and the number inside it.
 *
 * `role="timer"` with a polite live region — but those two are not the same text, and that is the point. The
 * readout a reader watches carries seconds and changes every beat; what the live region holds is the whole
 * minute, so it changes once a minute. A live region over the seconds would speak the rest of the screen
 * away: the count a screen reader is told is how much is left, not a metronome.
 */
function ClockFace({ session, now }: { session: FocusSession; now: number }) {
  const remaining = phaseRemainingMs(session, now)
  const plan = session.screen === 'break' ? session.breakMs : session.blockMs
  const elapsed = phaseElapsedMs(session, now)
  const share = plan === null || plan <= 0 ? 0 : Math.min(1, elapsed / plan)
  const shown = remaining ?? elapsed
  // The announced number never says "zero minutes left" before the block has actually ended, so the part
  // minute is rounded up rather than down.
  const spokenMinutes = Math.max(1, Math.ceil(shown / MINUTE_MS))
  const spokenKey = session.screen === 'break'
    ? 'todo.focus.spoken_break'
    : remaining === null
      ? 'todo.focus.spoken_worked'
      : 'todo.focus.spoken_left'

  return (
    <div
      data-focus-clock=""
      role="timer"
      aria-live="polite"
      className="relative flex size-44 shrink-0 items-center justify-center md:size-48"
    >
      <svg aria-hidden="true" viewBox="0 0 100 100" className="absolute inset-0 size-full -rotate-90">
        <circle cx="50" cy="50" r={RING_RADIUS} fill="none" stroke="var(--bg-inset)" strokeWidth={RING_STROKE} />
        {plan !== null && plan > 0 && (
          <circle
            cx="50"
            cy="50"
            r={RING_RADIUS}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            strokeDasharray={`${share * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
          />
        )}
      </svg>
      {/* The visible count is deliberately out of the accessibility tree: the same number in two places
          would be read twice, once a second. */}
      <span
        aria-hidden="true"
        data-focus-clock-text=""
        className="relative text-[length:var(--text-26)] font-semibold tabular-nums text-[var(--text-primary)]"
      >
        {formatRunningDuration(shown)}
      </span>
      <span data-focus-clock-spoken="" className="sr-only">
        {t(spokenKey, { minutes: spokenMinutes })}
      </span>
    </div>
  )
}

/**
 * The screen between a finished block and what comes next.
 *
 * It shows no countdown, because there is nothing left to count: the block is filed, and what is on offer is
 * the break the plan names — or, for a strategy with no break, the next block and the task itself.
 */
function SessionDone({ session, suggested }: { session: FocusSession; suggested: number | null }) {
  const upcoming = session.breakMs >= MINUTE_MS ? session.breakMs : suggested
  return (
    <div className="flex flex-col items-center gap-2 py-2 text-center">
      <p className="text-[length:var(--text-15)] font-medium text-[var(--text-primary)]">{t('todo.focus.session_done')}</p>
      <p className="text-[length:var(--text-12-5)] tabular-nums text-[var(--text-secondary)]">
        {t('todo.focus.time_worked', { time: formatRunningDuration(session.workedMs) })}
      </p>
      {upcoming !== null && upcoming >= MINUTE_MS && (
        <p className="text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">
          {t('todo.focus.break_start')}
          {' · '}
          <span data-focus-next-break="" className="tabular-nums text-[var(--text-primary)]">
            {formatRunningDuration(upcoming)}
          </span>
        </p>
      )}
    </div>
  )
}

/** The round, and what the task's own plan says about it. */
function Counter({ session, task }: { session: FocusSession; task: TodoTask | null }) {
  const parts: string[] = []
  if (session.round > 0) parts.push(t('todo.focus.round', { round: session.round }))
  if (task && task.timeEstimateMs != null) {
    parts.push(`${formatRunningDuration(task.timeSpentMs ?? 0)} / ${formatRunningDuration(task.timeEstimateMs)}`)
  }
  if (!parts.length) return null
  return (
    <p data-focus-counter="" className="ml-auto text-[length:var(--text-11-5)] tabular-nums text-[var(--text-tertiary)]">
      {parts.join(' · ')}
    </p>
  )
}

/**
 * The task line: its title, and the way to change it without leaving the block.
 *
 * The box marks itself `data-owns-escape`, which is how this app says "this keystroke is mine": the panel's
 * Escape route stands aside while a field is holding it, so taking a typed title back out never takes the
 * panel — and the session — with it.
 */
function TaskLine({ task }: { task: TodoTask | null }) {
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)
  if (!task) return null
  const name = t('todo.focus.edit_title')

  const commit = (value: string): void => {
    const title = value.trim()
    setDraft(null)
    if (!title || title === task.title) return
    void useTodos.getState().updateTask(task.id, { title })
  }

  if (draft === null) {
    return (
      <button
        type="button"
        data-focus-title=""
        aria-label={name}
        onClick={() => {
          cancelled.current = false
          setDraft(task.title)
        }}
        className="min-w-0 self-start rounded-[var(--r-sm)] text-left text-[length:var(--text-15)] font-medium text-[var(--text-primary)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      >
        <span className="block truncate">{task.title}</span>
      </button>
    )
  }

  return (
    <Input
      data-focus-title-input=""
      data-owns-escape=""
      autoFocus
      aria-label={name}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          // The keystroke ends the edit here and is not passed on: the panel stays and the block keeps going.
          event.preventDefault()
          cancelled.current = true
          setDraft(null)
          return
        }
        commitOnEnter(event, () => commit(draft))
      }}
      onBlur={() => {
        // An Escape already took the draft back; the blur that follows it must not save what was refused.
        if (cancelled.current) {
          cancelled.current = false
          return
        }
        commit(draft)
      }}
    />
  )
}

/** The two buttons that move the planned block — and their absence where a strategy has no plan. */
function NudgeRow({ session }: { session: FocusSession }) {
  if (session.blockMs === null) return null
  const nudge = useFocusSession.getState().nudge
  const name = (longer: boolean): string => t(longer ? 'todo.focus.nudge_longer' : 'todo.focus.nudge_shorter', { minutes: FOCUS_NUDGE_MINUTES })
  return (
    <div className="flex items-center gap-1">
      <IconButton label={name(false)} size="sm" onClick={() => nudge(-FOCUS_NUDGE_MINUTES)}>
        <Minus size={14} />
      </IconButton>
      <IconButton label={name(true)} size="sm" onClick={() => nudge(FOCUS_NUDGE_MINUTES)}>
        <Plus size={14} />
      </IconButton>
    </div>
  )
}

/**
 * The session's own two settings.
 *
 * These are the account's keys and nothing else: the panel writes through the same `updateSettings` door the
 * settings page uses, so a level picked here is the level stored rather than a third copy of it. The sound
 * row lives here because this is the surface that plays the cues (D9) — four levels a reader could set and
 * never hear would be four words with no meaning.
 */
function SessionSettings({ settings, focus }: { settings: TodoFocusSettings | null; focus: FocusSession }) {
  const updateSettings = useSession.getState().updateSettings
  const setSettingsOpen = useFocusSession.getState().setSettingsOpen
  if (!settings) return null
  const soundLabel: Record<TodoFocusSound, string> = {
    off: t('todo.focus.sound_off'),
    tick: t('todo.focus.sound_tick'),
    chime: t('todo.focus.sound_chime'),
    both: t('todo.focus.sound_both'),
  }
  const write = (patch: Partial<TodoFocusSettings>): void => {
    updateSettings({ todo: { focus: { ...settings, ...patch } } })
  }

  return (
    <section
      data-focus-settings=""
      aria-label={t('todo.focus.settings')}
      className={focus.settingsOpen ? 'flex flex-col gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-3' : 'hidden'}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[length:var(--text-11)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
          {t('todo.focus.settings')}
        </span>
        <IconButton label={t('common.close')} size="xs" onClick={() => setSettingsOpen(false)}>
          <X size={12} />
        </IconButton>
      </div>
      <div className="flex max-w-[280px] flex-col gap-1">
        <SelectMenu
          label={t('todo.focus.sound')}
          size="sm"
          value={settings.sound}
          options={SOUND_LEVELS.map((level) => ({ value: level, label: soundLabel[level] }))}
          onChange={(sound) => write({ sound })}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 text-[length:var(--text-12-5)] text-[var(--text-secondary)]">{t('settings.todo_focus_pause_break')}</span>
        <Switch
          label={t('settings.todo_focus_pause_break')}
          checked={settings.pauseTrackingDuringBreak}
          onChange={(pauseTrackingDuringBreak) => write({ pauseTrackingDuringBreak })}
        />
      </div>
    </section>
  )
}

/** The bottom row: the gesture the block needs, and the doors that always answer to the same name. */
function Footer({ session, task }: { session: FocusSession; task: TodoTask | null }) {
  const actions = useFocusSession.getState()
  const running = session.runState === 'running'
  const runLabel = session.runState === 'ready'
    ? t('todo.focus.start')
    : running
      ? t('todo.focus.pause')
      : t('todo.focus.resume')

  return (
    <>
      <Button variant="ghost" icon={<X size={14} />} onClick={() => { void cancelSession() }}>
        {t('todo.focus.cancel')}
      </Button>
      <Button
        variant="ghost"
        icon={<Settings2 size={14} />}
        aria-pressed={session.settingsOpen}
        onClick={() => actions.setSettingsOpen(!session.settingsOpen)}
      >
        {t('todo.focus.settings')}
      </Button>
      {task && (
        <Button variant="ghost" icon={<StickyNote size={14} />} onClick={() => { void writeNote(task) }}>
          {t('todo.focus.note')}
        </Button>
      )}
      <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={actions.restart}>
        {t('todo.focus.restart')}
      </Button>

      {session.screen === 'main' && (
        <>
          <Button variant="ghost" onClick={actions.toggleRun} disabled={!task}>
            {runLabel}
          </Button>
          <Button variant="secondary" onClick={actions.finishBlock} disabled={session.runState === 'ready'}>
            {t('todo.focus.finish')}
          </Button>
        </>
      )}

      {session.screen === 'session-done' && (
        <>
          <Button variant="ghost" onClick={actions.endSession}>
            {t('todo.focus.end')}
          </Button>
          <Button variant="secondary" icon={<SquareCheckBig size={14} />} onClick={actions.completeTask}>
            {t('todo.focus.mark_done')}
          </Button>
          {session.breakMs >= MINUTE_MS
            ? (
                <Button variant="primary" onClick={actions.beginBreak}>{t('todo.focus.break_start')}</Button>
              )
            : (
                <Button variant="primary" onClick={actions.nextBlock}>{t('todo.focus.another_block')}</Button>
              )}
        </>
      )}

      {session.screen === 'break' && (
        <>
          <Button variant="ghost" onClick={actions.endSession}>
            {t('todo.focus.end')}
          </Button>
          <Button variant="primary" icon={<SkipForward size={14} />} onClick={actions.skipBreak}>
            {t('todo.focus.break_skip')}
          </Button>
        </>
      )}
    </>
  )
}

/**
 * The strip that stands in for the panel.
 *
 * It is a line of the frame, beside the one that names the running interval, because the session it speaks
 * for outlives the surface that started it. Pressing it puts the panel back over the same block, at the
 * number the strip was already showing: the session was never stopped, only hidden.
 */
function FocusStrip({ session, now }: { session: FocusSession; now: number }) {
  const title = useTodos((state) => state.tasks.find((entry) => entry.id === session.taskId)?.title ?? '')
  const remaining = phaseRemainingMs(session, now)
  const show = useFocusSession.getState().show
  // Between a block and the next phase nothing is counting down, so the strip says what has been worked
  // rather than showing a clock that would not move.
  const shown = remaining ?? (session.screen === 'session-done' ? session.workedMs : phaseElapsedMs(session, now))

  return (
    <div
      data-focus-bar=""
      className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--accent-soft)] px-3 py-1 text-[length:var(--text-11-5)] md:px-5"
    >
      <Play size={11} fill="currentColor" aria-hidden="true" className="shrink-0 text-[var(--accent-on-soft)]" />
      <span className="shrink-0 font-medium text-[var(--accent-on-soft)]">{t('todo.focus.hidden_bar')}</span>
      <button
        type="button"
        data-focus-bar-resume=""
        aria-label={t('todo.focus.hidden_aria', { title })}
        onClick={show}
        className="min-w-0 flex-1 truncate rounded-[var(--r-sm)] text-left text-[var(--accent-on-soft)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      >
        {title}
      </button>
      <span role="timer" data-focus-bar-clock="" className="shrink-0 tabular-nums text-[var(--accent-on-soft)]">
        {formatRunningDuration(shown)}
      </span>
    </div>
  )
}

/**
 * Cancel, out loud and once.
 *
 * The confirm is the app's own dialog rather than the browser's (rule 11), and the answer arrives with the
 * panel still there to be looked at. Asking is the only thing this does: the session keeps running while the
 * question is on screen, because a question that stopped the clock would answer itself.
 */
async function cancelSession(): Promise<void> {
  const answer = await confirm({
    title: t('todo.focus.cancel_title'),
    description: t('todo.focus.cancel_description'),
    confirmLabel: t('todo.focus.cancel'),
    tone: 'danger',
  })
  if (answer) useFocusSession.getState().endSession()
}

/** A note about the task, written through the editor's own door rather than a second field of this panel's. */
async function writeNote(task: TodoTask): Promise<void> {
  const answer = await prompt({
    title: t('todo.focus.note_title', { title: task.title }),
    defaultValue: task.description,
  })
  if (answer === null || answer === task.description) return
  void useTodos.getState().updateTask(task.id, { description: answer })
}

/**
 * Flowtime's interruption, or null when there is nothing to say.
 *
 * The store owns the same rule for the moment a block is filed; this is the live reading of it, which is why
 * it takes the beat's clock rather than asking for its own. `breakAfterBlock` is what the session will answer
 * with one round later, so the length offered here and the length the break takes cannot diverge.
 */
function flowtimeNudge(session: FocusSession, settings: TodoFocusSettings | null, now: number): number | null {
  if (!settings || session.strategy !== 'flowtime' || session.screen !== 'main') return null
  if (session.runState !== 'running') return null
  const worked = session.workedMs + phaseElapsedMs(session, now)
  if (!flowtimeBreakDue(settings, worked)) return null
  return breakAfterBlock('flowtime', settings, session.round + 1, worked)
    ?? flowtimeBreakMs(worked, settings)
}

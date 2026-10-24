/**
 * The habits screen: one row per habit, each with the month of days behind it.
 *
 * Nothing here is a task, and the frame knows it — the screen reads its own address rather than the
 * plate's listing, so the filter bar and the paged fetch stay away (`readsOwnRows`).
 *
 * Every write re-reads the screen instead of editing the row locally. A tap changes the very number the
 * streak beside it is derived from, and an optimistic answer plus the server's answer is two answers to
 * "did today count" — which `counterDayMet` already exists to prevent. The re-read is also what rolls the
 * day over: `today` is the account's, named by the server, not this machine's clock.
 */
import { useEffect, useMemo, useState, type JSX } from 'react'
import { Check, Minus, Pencil, Play, Plus, Square } from 'lucide-react'
import { localeTag, t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { Button, IconButton } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { Modal, confirm } from '../../components/overlay'
import { Field, Input, Segmented } from '../../components/form'
import { buildStripWeeks, heatCell } from '../../components/activity-calendar'
import { streaksOf } from '../../lib/calendar-stats'
import { useUi } from '../../store/ui'
import { durationLabel } from './stats-charts'
import { ListIcon } from './list-icons'
import {
  MAX_COUNTER_DAY_AMOUNT,
  counterDayMet,
  type CounterKind,
  type CounterReading,
  type CounterReadings,
  type TodoCounter,
} from '@shared/todos/model'

const DAY_MS = 86_400_000

/** A calendar day as a Date, anchored at noon so no zone offset can pull it onto its neighbour. */
function dayDate(day: string): Date {
  return new Date(`${day}T12:00:00Z`)
}

/** One day's name, in the words the rest of the app uses for a date. */
function dayName(day: string): string {
  return new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium' }).format(dayDate(day))
}

/** How many days a row's heat strip reaches back: about the month a reader is looking over. */
const STRIP_DAYS = 30
/** A habit's amount is whole seconds; the duration labels the app already uses speak milliseconds. */
const SECOND_MS = 1000
/**
 * One day's cell, and the gap between them.
 *
 * Twelve pixels is what keeps a month of them on one line beside a title, which is how the strip is read
 * where a pointer aims. A finger cannot land on that, and the cells are the only way to log a day other
 * than today, so on a coarse pointer the same cell is drawn at 20 pixels with a 6 pixel gap: the target
 * then clears WCAG 2.5.8's spacing exception, since a 24 pixel circle around one cell reaches no further
 * than the edge of the next. Read-only cells take the same box, or a stopwatch's strip would sit out of
 * line with the habits beside it.
 */
const CELL_CLASS = 'size-3 rounded-[var(--r-2)] pointer-coarse:size-5'
const STRIP_GAP_CLASS = 'gap-1 pointer-coarse:gap-1.5'

/** One amount in the unit the habit speaks: seconds read as a duration, taps as a count. */
function amountLabel(amount: number, kind: CounterKind): string {
  return kind === 'stopwatch' ? durationLabel(amount * SECOND_MS) : String(amount)
}

/**
 * The target a row was saved with, or none at all.
 *
 * Empty is a clear rather than a zero: a habit tracked without a target counts a day by its having
 * happened, and a reader who types nothing means that, not "a target of nothing". `unreadable` is the
 * field's own state — a value the server would refuse — kept apart from a number so the Save button and
 * the hint line can both speak to it without guessing.
 */
type GoalInput = { ok: true, value: number | null } | { ok: false }

function parseGoal(text: string): GoalInput {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true, value: null }
  const amount = Number(trimmed)
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_COUNTER_DAY_AMOUNT) return { ok: false }
  return { ok: true, value: amount }
}

interface EditorProps {
  habit: TodoCounter | null
  onClose: () => void
  onSaved: () => void
}

/** The create-and-edit dialog: a name, what it counts, and what a full day of it would be. */
function HabitEditor({ habit, onClose, onSaved }: EditorProps): JSX.Element {
  const [name, setName] = useState(habit?.title ?? '')
  const [kind, setKind] = useState<CounterKind>(habit?.kind ?? 'clicks')
  const [goalText, setGoalText] = useState(habit?.goal === null || habit?.goal === undefined ? '' : String(habit.goal))
  const [busy, setBusy] = useState(false)
  const goal = parseGoal(goalText)
  const canSave = name.trim() !== '' && goal.ok && !busy

  const save = async (): Promise<void> => {
    if (!canSave) return
    setBusy(true)
    const body = { title: name.trim(), kind, goal: goal.ok ? goal.value : null }
    try {
      if (habit) await api.todos.updateCounter(habit.id, body)
      else await api.todos.createCounter(body)
      onSaved()
      onClose()
    } catch (reason) {
      reportFailure(reason)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!habit) return
    const ok = await confirm({
      title: t('todo.counters.delete_title'),
      description: t('todo.counters.delete_hint', { title: habit.title }),
      confirmLabel: t('todo.action.delete'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await api.todos.removeCounter(habit.id)
      onSaved()
      onClose()
    } catch (reason) {
      reportFailure(reason)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={habit ? t('todo.counters.editor.edit') : t('todo.counters.new')}
      width={480}
      footer={(
        <div className="flex w-full items-center gap-2">
          {habit && <Button variant="danger" size="sm" disabled={busy} onClick={() => { void remove() }}>{t('todo.action.delete')}</Button>}
          <span className="ml-auto" />
          <Button variant="ghost" size="sm" onClick={onClose}>{t('todo.action.cancel')}</Button>
          <Button size="sm" disabled={!canSave} onClick={() => { void save() }}>{t('todo.action.save')}</Button>
        </div>
      )}
    >
      <div className="space-y-4">
        <Field label={t('todo.counters.name_label')}>
          <Input value={name} onChange={(event) => { setName(event.target.value) }} autoFocus />
        </Field>
        <Field label={t('todo.counters.kind_label')}>
          <Segmented
            value={kind}
            onChange={(next) => { setKind(next as CounterKind) }}
            options={[
              { value: 'clicks', label: t('todo.counters.kind.clicks') },
              { value: 'stopwatch', label: t('todo.counters.kind.stopwatch') },
            ]}
          />
        </Field>
        <Field
          label={t('todo.counters.goal_label')}
          hint={!goal.ok
            ? t('todo.counters.goal_invalid', { max: MAX_COUNTER_DAY_AMOUNT })
            : t('todo.counters.goal_hint', { unit: kind === 'stopwatch' ? t('todo.counters.unit_seconds') : t('todo.counters.unit_times') })}
        >
          <Input
            value={goalText}
            inputMode="numeric"
            onChange={(event) => { setGoalText(event.target.value) }}
            aria-invalid={!goal.ok}
          />
        </Field>
        {kind === 'clicks'
          ? null
          : <p className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">{t('todo.counters.stopwatch_hint')}</p>}
      </div>
    </Modal>
  )
}

/** A refused write says so on the rail; the screen keeps showing what the server last confirmed. */
function reportFailure(reason: unknown): void {
  useUi.getState().toast({
    title: t('todo.toast.failed'),
    description: reason instanceof Error ? reason.message : String(reason),
    tone: 'danger',
  })
}

interface RowProps {
  reading: CounterReading
  now: number
  busy: boolean
  onTick: (delta: number, day?: string) => void
  onToggleTimer: () => void
  onEdit: () => void
}

/** One habit: its name and target, what today holds, how long the run is, and the strip of days. */
function HabitRow({ reading, now, busy, onTick, onToggleTimer, onEdit }: RowProps): JSX.Element {
  const { counter, days, today } = reading
  const byDay = useMemo(() => new Map(days.map((entry) => [entry.day, entry.amount])), [days])
  // A run of days counts the target, never "did anything happen" — and it is the same `counterDayMet`
  // that decides this row's own number, so the streak and the cell cannot tell two stories.
  const metDays = useMemo(
    () => new Map(days.map((entry) => [entry.day, counterDayMet(entry.amount, counter.goal) ? 1 : 0])),
    [days, counter.goal],
  )
  const streak = streaksOf(metDays, today).current
  const todayAmount = byDay.get(today) ?? 0
  const reached = counterDayMet(todayAmount, counter.goal)
  // The grid is cut by the range rather than by the map: the answer carries a year of days and the strip
  // draws the month at its end, so `STRIP_DAYS` is the only number a row's tiles are counted from.
  const strip = useMemo(() => buildStripWeeks(byDay, {
    range: { start: new Date(dayDate(today).getTime() - (STRIP_DAYS - 1) * DAY_MS), end: dayDate(today) },
    todayKey: today,
  }).flat(), [byDay, today])
  const running = counter.runningSince !== null
  const elapsed = counter.runningSince === null ? 0 : Math.max(0, Math.floor((now - counter.runningSince) / 1000))

  return (
    <li className="border-t border-[var(--border-subtle)] px-4 py-3 first:border-t-0" data-habit-row={counter.id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: `color-mix(in oklab, ${counter.color ?? 'var(--accent)'} 14%, transparent)`, color: counter.color ?? 'var(--accent)' }}
          aria-hidden="true"
        >
          {counter.icon ? <ListIcon icon={counter.icon} size={15} /> : <Check size={15} />}
        </span>
        <div className="min-w-0 flex-1 basis-40">
          <p className="truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{counter.title}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            <span className="tabular-nums">
              {amountLabel(todayAmount, counter.kind)}
              {counter.goal !== null && ` / ${amountLabel(counter.goal, counter.kind)}`}
            </span>
            {streak > 0 && <span>{t('todo.counters.streak', { value: streak })}</span>}
            {running && <span className="tabular-nums text-[var(--text-tertiary)]">{durationLabel(elapsed * SECOND_MS)}</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {counter.kind === 'clicks' ? (
            <>
              <IconButton size="sm" variant="ghost" disabled={busy || todayAmount === 0} label={t('todo.counters.take_one')} onClick={() => { onTick(-1) }}>
                <Minus size={15} />
              </IconButton>
              <IconButton size="sm" variant="ghost" disabled={busy} label={t('todo.counters.tap')} onClick={() => { onTick(1) }}>
                <Plus size={15} />
              </IconButton>
            </>
          ) : (
            <Button size="sm" variant={running ? 'secondary' : 'ghost'} disabled={busy} onClick={onToggleTimer}>
              {running ? <Square size={14} /> : <Play size={14} />}
              <span className="ml-1.5">{running ? t('todo.counters.stop') : t('todo.counters.start')}</span>
            </Button>
          )}
          <IconButton size="sm" variant="ghost" disabled={busy} label={t('todo.counters.editor.edit')} onClick={onEdit}>
            <Pencil size={14} />
          </IconButton>
        </div>
      </div>
      <div className={`mt-2.5 flex flex-wrap ${STRIP_GAP_CLASS}`} role="group" aria-label={t('todo.counters.strip_aria', { count: STRIP_DAYS })}>
        {strip.map((cell) => (
          counter.kind === 'clicks'
            ? (
              <button
                key={cell.key}
                type="button"
                disabled={busy}
                className={`${CELL_CLASS} outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${cell.today ? 'ring-1 ring-[var(--accent)]' : ''}`}
                style={heatCell(cell.level)}
                aria-label={t('todo.counters.day_aria', { day: dayName(cell.key), value: amountLabel(cell.count, counter.kind) })}
                onClick={() => { onTick(1, cell.key) }}
              />
            )
            : (
              <span
                key={cell.key}
                className={`${CELL_CLASS} ${cell.today ? 'ring-1 ring-[var(--accent)]' : ''}`}
                style={heatCell(cell.level)}
                title={`${dayName(cell.key)} · ${amountLabel(cell.count, counter.kind)}`}
              />
            )
        ))}
        {reached && <span className="ml-1 self-center text-[length:var(--text-11)] text-[var(--accent)]">{t('todo.counters.reached')}</span>}
      </div>
    </li>
  )
}

/** The habits page: every habit the account keeps, newest tap first among them in the order they were made. */
export function CountersView(): JSX.Element {
  const [answer, setAnswer] = useState<CounterReadings | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ open: true, habit: TodoCounter | null } | null>(null)
  // A running stopwatch has to move on the screen, so the row's elapsed line is read against a clock
  // refreshed once a minute rather than at every render.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 60_000)
    return () => { clearInterval(timer) }
  }, [])

  useEffect(() => {
    let live = true
    setStatus('loading')
    api.todos.counters()
      .then((readings) => {
        if (!live) return
        setAnswer(readings)
        setStatus('ready')
      })
      .catch((reason: unknown) => {
        if (!live) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setStatus('error')
      })
    return () => { live = false }
  }, [revision])

  const askAgain = (): void => { setRevision((current) => current + 1) }

  /**
   * One press, then the screen's own re-read. A refused write already said so on the rail.
   *
   * The clock the elapsed line is measured against only moves once a minute, so a run started between
   * two of those beats would read as nothing for up to a minute after it began. A write is the one
   * moment the screen knows the answer moved, so it takes the clock with it.
   */
  const act = async (id: string, write: () => Promise<unknown>): Promise<void> => {
    setBusyId(id)
    try {
      await write()
      setNow(Date.now())
      askAgain()
    } catch (reason) {
      reportFailure(reason)
    } finally {
      setBusyId(null)
    }
  }

  if (status === 'error') {
    return (
      <div className="flex flex-col items-start gap-2 p-4" data-counters-view="">
        <p role="alert" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{error}</p>
        <Button size="sm" variant="ghost" onClick={askAgain}>{t('common.retry')}</Button>
      </div>
    )
  }

  if (status === 'loading' && answer === null) {
    return <div className="p-4"><LoadingBlock label={t('common.loading')} /></div>
  }

  const readings = answer?.readings ?? []
  const newHabit = (): void => { setEditing({ open: true, habit: null }) }

  return (
    <div className="min-h-0 flex-1" data-counters-view="">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <p className="text-[length:var(--text-12)] text-[var(--text-quaternary)]">
          {readings.length === 0 ? '' : t('todo.counters.count', { count: readings.length })}
        </p>
        <Button size="sm" variant="ghost" onClick={newHabit}>
          <Plus size={14} />
          <span className="ml-1.5">{t('todo.counters.new')}</span>
        </Button>
      </div>
      {readings.length === 0
        ? (
          <Empty
            art="notes"
            compact
            title={t('todo.counters.empty')}
            description={t('todo.counters.empty_hint')}
            action={<Button size="sm" onClick={newHabit}>{t('todo.counters.new')}</Button>}
          />
        )
        : (
          <ul className="pb-6">
            {readings.map((reading) => (
              <HabitRow
                key={reading.counter.id}
                reading={reading}
                now={now}
                busy={busyId === reading.counter.id}
                onTick={(delta, day) => {
                  void act(reading.counter.id, () => api.todos.tickCounter(reading.counter.id, day === undefined ? { delta } : { delta, day }))
                }}
                onToggleTimer={() => {
                  void act(reading.counter.id, () => (reading.counter.runningSince === null
                    ? api.todos.startCounter(reading.counter.id)
                    : api.todos.stopCounter(reading.counter.id)))
                }}
                onEdit={() => { setEditing({ open: true, habit: reading.counter }) }}
              />
            ))}
          </ul>
        )}
      {editing !== null && (
        <HabitEditor
          habit={editing.habit}
          onClose={() => { setEditing(null) }}
          onSaved={askAgain}
        />
      )}
    </div>
  )
}

/**
 * The end-of-day pass: one screen that answers four questions about the day being closed.
 *
 * This is the ritual the reference app's whole loop turns on. You finish the day by deciding what
 * happens to what the day left behind, rather than letting closed work pile up in a completed list
 * forever. Four sections, because those are the four things a day actually leaves: what it finished, what
 * it spent time on and left open, what slipped past its date, and what tomorrow has already taken on.
 *
 * The four come from one read (`GET /api/todos/finish-day`), and the screen re-asks after every action.
 * A close-out changes the very rows it is showing — filing a bucket empties it — so four reads made one at
 * a time would let the third section describe a day that the first two had already edited.
 *
 * Nothing here is a listing. The plate's rows are not this screen's rows, and the frame knows that:
 * `readsOwnRows` keeps the page fetch and the filter bar away, because a control that narrowed nothing on
 * this screen would be a control that lies.
 */
import { useEffect, useState } from 'react'
import { localeTag, t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Empty } from '../../components/feedback'
import { confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { useUi } from '../../store/ui'
import { useTodos } from './store'
import type { FinishDay, FinishDayBucket, TodoTask } from '@shared/todos/model'

/** How many the bucket holds: the rows drawn, plus the ones the page could not carry. */
function bucketCount(bucket: FinishDayBucket): number {
  return bucket.rows.length + bucket.more
}

/** A day, in the reader's own calendar. Anchored at noon so a zone offset cannot pull it to a neighbour. */
function dayLabel(day: string): string {
  return new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium' }).format(new Date(`${day}T12:00:00`))
}

/** The line under a title that says when the row is owed. An undated row says nothing rather than guess. */
function dueLine(task: TodoTask): string {
  if (task.dueAt === null) return ''
  return new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium' }).format(new Date(task.dueAt))
}

interface Action {
  label: string
  run: () => Promise<void>
}

function TaskRow({ task, actions, busy }: { task: TodoTask, actions: Action[], busy: boolean }) {
  const meta = dueLine(task)
  return (
    <li className="border-t border-[var(--border-subtle)] first:border-t-0">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1.5 py-2">
        <div className="min-w-0 flex-1 basis-40">
          <p className="truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{task.title}</p>
          {meta !== '' && <p className="truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">{meta}</p>}
        </div>
        {actions.length > 0 && (
          <div className="flex shrink-0 items-center gap-1.5">
            {actions.map((action) => (
              <Button key={action.label} size="sm" variant="ghost" disabled={busy} onClick={() => { void action.run() }}>
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </li>
  )
}

interface SectionProps {
  title: string
  bucket: FinishDayBucket
  /** The heading's own gesture, shown only while the bucket has rows to take. */
  aside?: Action
  asideBusy?: boolean
  actions: (task: TodoTask) => Action[]
  busyId: string | null
}

/**
 * One bucket: its heading, its count, its rows.
 *
 * A bucket with nothing in it draws no section at all. Four headings that each say "none" would be the
 * screen asking the reader to confirm that nothing happened, and a section that vanishes after being
 * filed is the plainest proof the press landed.
 */
function Section({ title, bucket, aside, asideBusy = false, actions, busyId }: SectionProps) {
  if (bucketCount(bucket) === 0) return null
  return (
    <section className="flex flex-col gap-1 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3">
      <div className="flex flex-wrap items-center justify-between gap-2 py-2">
        <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {title}
          <span className="ml-1.5 text-[length:var(--text-11)] font-normal tabular-nums text-[var(--text-quaternary)]">
            {bucketCount(bucket)}
          </span>
        </h2>
        {aside && <Button size="sm" disabled={asideBusy} onClick={() => { void aside.run() }}>{aside.label}</Button>}
      </div>
      {bucket.rows.length > 0 && (
        <ul className="m-0 list-none p-0">
          {bucket.rows.map((task) => (
            <TaskRow key={task.id} task={task} actions={actions(task)} busy={busyId === task.id} />
          ))}
        </ul>
      )}
      {bucket.more > 0 && (
        <p className="py-2 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
          {t('todo.finish_day.more', { count: bucket.more })}
        </p>
      )}
    </section>
  )
}

export function FinishDayView() {
  const [answer, setAnswer] = useState<FinishDay | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  /** Bumped by a retry and by every landed write: the buckets move under the reader's hands. */
  const [revision, setRevision] = useState(0)
  /** The row with a write in flight, so its two buttons cannot be pressed twice. */
  const [busyId, setBusyId] = useState<string | null>(null)
  const [filing, setFiling] = useState(false)

  const planTask = useTodos((state) => state.planTask)
  const updateTask = useTodos((state) => state.updateTask)
  const reportUndo = useTodos((state) => state.reportUndo)

  useEffect(() => {
    let live = true
    setStatus('loading')
    api.todos.finishDay()
      .then((pass) => {
        if (!live) return
        setAnswer(pass)
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

  /** One row's decision, and the pass re-read afterwards. A refused write already said so itself. */
  const act = async (id: string, write: () => Promise<void>): Promise<void> => {
    setBusyId(id)
    try {
      await write()
      askAgain()
    } finally {
      setBusyId(null)
    }
  }

  /** Move a row into tomorrow, and put back the plan it had before if the reader means to undo. */
  const toTomorrow = (task: TodoTask): Action => ({
    label: t('todo.finish_day.to_tomorrow'),
    run: () => act(task.id, async () => {
      if (!answer) return
      const previous = task.plannedFor
      await planTask(task.id, answer.tomorrow)
      reportUndo(t('todo.finish_day.moved_to_tomorrow', { title: task.title }), async () => {
        await planTask(task.id, previous)
        askAgain()
      })
    }),
  })

  const giveUp = (task: TodoTask): Action => ({
    label: t('todo.finish_day.give_up'),
    run: () => act(task.id, async () => {
      const before = task.status
      await updateTask(task.id, { status: 'cancelled' })
      reportUndo(t('todo.finish_day.given_up', { title: task.title }), async () => {
        await updateTask(task.id, { status: before })
        askAgain()
      })
    }),
  })

  /**
   * Take a row out of tomorrow — only offered for a row the reader picked there by hand.
   *
   * A task due tomorrow has no pick to clear: `planTask(id, null)` would write something, change
   * nothing about when it is owed, and leave a button on screen that had not done what it said.
   */
  const unpick = (task: TodoTask): Action => ({
    label: t('todo.finish_day.unpick'),
    run: () => act(task.id, async () => {
      if (!answer) return
      await planTask(task.id, null)
      reportUndo(t('todo.finish_day.unpicked', { title: task.title }), async () => {
        await planTask(task.id, answer.tomorrow)
        askAgain()
      })
    }),
  })

  const fileAway = async (): Promise<void> => {
    if (!answer) return
    const ids = answer.done.rows.map((task) => task.id)
    const ok = await confirm({
      title: t('todo.finish_day.confirm_title', { count: ids.length }),
      description: t('todo.finish_day.confirm_body', { archive: t('todo.shelf.title') }),
      confirmLabel: t('todo.finish_day.confirm_go'),
      tone: 'danger',
    })
    if (!ok) return
    setFiling(true)
    try {
      const result = await api.todos.batch({ ids, op: 'archive', value: 'true' })
      // Half a sweep is reported, not smoothed over: the toast says which half, and the step back only
      // ever covers the rows the server actually changed.
      if (result.failed.length > 0) {
        useUi.getState().toast({
          title: t('todo.toast.batch_partial', { failed: result.failed.length, total: ids.length }),
          description: [...new Set(result.failed.map((entry) => entry.reason))].slice(0, 3).join(' · '),
          tone: 'danger',
        })
      }
      const shelved = result.done.map((entry) => entry.id)
      if (shelved.length > 0) {
        reportUndo(t('todo.toast.batch_archived', { count: shelved.length }), async () => {
          await api.todos.batch({ ids: shelved, op: 'archive', value: 'false' })
          askAgain()
        })
      }
      askAgain()
    } finally {
      setFiling(false)
    }
  }

  if (status === 'error') {
    return (
      <div className="flex flex-col items-start gap-2 p-4" data-finish-day-view="">
        <p role="alert" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{error}</p>
        <Button size="sm" variant="ghost" onClick={askAgain}>{t('common.retry')}</Button>
      </div>
    )
  }

  if (!answer) {
    return (
      <p role="status" className="p-4 text-[length:var(--text-12)] text-[var(--text-tertiary)]" data-finish-day-view="">
        {t('common.loading')}
      </p>
    )
  }

  const tomorrow = answer.tomorrow
  const sectionsLeft = bucketCount(answer.done) + bucketCount(answer.worked)
    + bucketCount(answer.overdue) + bucketCount(answer.planned) === 0

  return (
    <div className="flex flex-col gap-3 p-3 pb-6" data-finish-day-view="">
      <p className="text-[length:var(--text-12-5)] leading-relaxed text-[var(--text-tertiary)]">
        {t('todo.finish_day.lead', { day: dayLabel(answer.day), tomorrow: dayLabel(tomorrow) })}
      </p>

      {sectionsLeft && (
        <Empty title={t('todo.empty.finish_day')} description={t('todo.empty.finish_day_hint')} />
      )}

      <Section
        title={t('todo.finish_day.finished')}
        bucket={answer.done}
        aside={{ label: t('todo.finish_day.file_away', { count: bucketCount(answer.done) }), run: fileAway }}
        asideBusy={filing}
        busyId={busyId}
        actions={() => []}
      />

      <Section
        title={t('todo.finish_day.touched')}
        bucket={answer.worked}
        busyId={busyId}
        actions={(task) => [toTomorrow(task), giveUp(task)]}
      />

      <Section
        title={t('todo.finish_day.behind')}
        bucket={answer.overdue}
        busyId={busyId}
        actions={(task) => [toTomorrow(task), giveUp(task)]}
      />

      <Section
        title={t('todo.finish_day.tomorrow')}
        bucket={answer.planned}
        busyId={busyId}
        actions={(task) => (task.plannedFor === tomorrow ? [unpick(task)] : [])}
      />
    </div>
  )
}

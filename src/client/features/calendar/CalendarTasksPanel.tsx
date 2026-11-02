/**
 * The task events for the range the calendar has loaded, as a checklist.
 *
 * Tasks are ordinary events with `kind: 'task'`; this panel is a second view over the same rows, not
 * a second store. A checkbox writes the task field and asks the surface to refresh the range.
 */
import { useState } from 'react'
import type { CalendarDto } from '@shared/calendar/model'
import type { Event, ICalendarApp } from '@dayflow/react'
import { t } from '../../lib/i18n'
import { Checkbox } from '../../components/form'
import { useUi } from '../../store/ui'
import * as api from './api'
import { isRecurrenceOccurrence } from './model'

interface CalendarTasksPanelProps {
  app: ICalendarApp
  calendars: readonly CalendarDto[]
  onChanged: () => void
}

export function CalendarTasksPanel({ app, calendars, onChanged }: CalendarTasksPanelProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const visible = new Set(calendars.filter(calendar => calendar.isVisible).map(calendar => calendar.id))
  const tasks = app.getEvents()
    .filter(event => event.kind === 'task' && !isRecurrenceOccurrence(event))
    .filter(event => (event.calendarIds ?? (event.calendarId ? [event.calendarId] : [])).some(id => visible.has(id)))
    .sort((left, right) => String(left.start).localeCompare(String(right.start)))
    .slice(0, 12)

  const toggle = async (event: Event): Promise<void> => {
    if (busy) return
    setBusy(event.id)
    try {
      const current = await api.getEvent(event.id)
      if (!current) return
      await api.updateEventPatch(event.id, {
        task: {
          completed: !current.task?.completed,
          ...(current.task?.priority ? { priority: current.task.priority } : {}),
          ...(!current.task?.completed
            ? { completedAt: { value: new Date().toISOString(), type: 'zoned', timeZone: 'UTC' } }
            : {}),
        },
      }, current.rev)
      onChanged()
    } catch (error) {
      useUi.getState().toast({
        title: t('calendar.tasks.save_failed'),
        description: error instanceof Error ? error.message : undefined,
        tone: 'danger',
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-label={t('calendar.tasks.title')} className="px-2 pb-2">
      <p className="py-1 text-[length:var(--text-11)] font-semibold uppercase tracking-[0.07em] text-[var(--text-quaternary)]">
        {t('calendar.tasks.title')}
      </p>
      {tasks.length === 0 && (
        <p className="px-1 py-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('calendar.tasks.empty')}</p>
      )}
      <ul className="space-y-0.5">
        {tasks.map(task => (
          <li key={task.id} className="flex min-w-0 items-start gap-1.5 rounded-[var(--r-sm)] px-1 py-1 hover:bg-[var(--bg-hover)]">
            <Checkbox
              checked={Boolean(task.task?.completed)}
              disabled={busy === task.id}
              onChange={() => void toggle(task)}
              ariaLabel={t('calendar.tasks.toggle', { title: task.title })}
              className="min-w-0 flex-1"
              label={(
                <span className={task.task?.completed ? 'line-through text-[var(--text-quaternary)]' : ''}>
                  {task.title || t('calendar.event.untitled')}
                </span>
              )}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}

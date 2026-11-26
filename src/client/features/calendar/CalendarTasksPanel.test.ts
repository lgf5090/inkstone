import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { Temporal } from 'temporal-polyfill'
import type { CalendarDto } from '@shared/calendar/model'
import type { Event, ICalendarApp } from '@dayflow/react'
import { initI18n } from '../../lib/i18n'
import { renderElement } from '../../lib/test-render'
import { CalendarTasksPanel } from './CalendarTasksPanel'

function task(id: string, date: string): Event {
  return {
    id, title: id, kind: 'task', start: Temporal.PlainDate.from(date), end: Temporal.PlainDate.from(date),
    calendarId: 'calendar-1', calendarIds: ['calendar-1'], task: { completed: false },
  }
}

describe('CalendarTasksPanel', () => {
  it('shows only tasks in the visible range and reports the remainder', async () => {
    await initI18n()
    const events = [
      ...Array.from({ length: 13 }, (_, index) => task(`task-${index}`, '2026-11-26')),
      task('outside', '2026-12-26'),
    ]
    const app = { getEvents: () => events } as unknown as ICalendarApp
    const calendars = [{ id: 'calendar-1', isVisible: true }] as CalendarDto[]
    const rendered = renderElement(createElement(CalendarTasksPanel, {
      app, calendars, from: Date.parse('2026-11-23T00:00:00Z'), to: Date.parse('2026-11-30T00:00:00Z'),
      timeZone: 'UTC', onChanged: () => {},
    }))
    expect(rendered.container.querySelectorAll('li')).toHaveLength(12)
    expect(rendered.container.textContent).not.toContain('outside')
    expect(rendered.container.textContent).toContain('1 more tasks')
  })
})

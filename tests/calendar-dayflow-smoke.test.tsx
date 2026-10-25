import { createElement } from 'react'
import { Temporal } from 'temporal-polyfill'
import { describe, expect, it } from 'vitest'
import { DayFlowCalendar, createWeekView, useCalendarApp } from '@dayflow/react'
import { renderElement } from '../src/client/lib/test-render'
import type { Event } from '@dayflow/core'

const event: Event = {
  id: 'smoke-event',
  title: 'Smoke event',
  start: Temporal.PlainDateTime.from('2026-10-26T09:00:00'),
  end: Temporal.PlainDateTime.from('2026-10-26T10:00:00'),
  calendarId: 'smoke',
}

function Probe() {
  const calendar = useCalendarApp({
    views: [createWeekView({ startOfWeek: 1 })],
    events: [event],
    initialDate: new Date(2026, 9, 26),
    calendars: [{
      id: 'smoke',
      name: 'Smoke',
      colors: {
        eventColor: '#3b82f61A',
        eventSelectedColor: '#3b82f6',
        lineColor: '#3b82f6',
        textColor: '#3b82f6',
      },
    }],
  })
  return createElement(DayFlowCalendar, { calendar })
}

describe('DayFlow React adapter', () => {
  it('mounts a week view and renders an event without a DOM-specific crash', () => {
    const view = renderElement(createElement(Probe))
    try {
      expect(view.container.querySelector('.df-calendar-wrapper')).not.toBeNull()
      expect(view.container.textContent).toContain('Smoke event')
    } finally {
      view.unmount()
    }
  })
})

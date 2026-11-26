import { act, createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { CalendarEventDto, CalendarEventInput } from '../../../shared/calendar/model'
import { initI18n } from '../../lib/i18n'
import { renderElement } from '../../lib/test-render'
import { CalendarConflictDialog } from './CalendarConflictDialog'

const mine: CalendarEventInput = {
  id: 'event-1', title: 'Mine', description: '', kind: 'event', task: null, conference: null,
  start: { type: 'zoned', value: '2026-11-26T09:00:00+08:00[Asia/Shanghai]', timeZone: 'Asia/Shanghai' },
  end: { type: 'zoned', value: '2026-11-26T10:00:00+08:00[Asia/Shanghai]', timeZone: 'Asia/Shanghai' },
  allDay: false, calendarId: 'calendar-1', calendarIds: ['calendar-1'], meta: {}, recurrenceRule: null,
}
const theirs: CalendarEventDto = {
  id: 'event-1', title: 'Theirs', description: '', kind: 'event', task: null, conference: null,
  start: mine.start!, end: mine.end!, allDay: false, calendarId: 'calendar-1', calendarIds: ['calendar-1'],
  meta: {}, icon: null, color: null, recurrenceRule: null, recurrenceParentId: null,
  recurrenceId: null, recurrenceCancelled: false, rev: 2, source: 'local', externalId: null,
}

describe('CalendarConflictDialog', () => {
  it('keeps the local edit on Escape and saves it by default', async () => {
    await initI18n()
    const onDecide = vi.fn()
    renderElement(createElement(CalendarConflictDialog, {
      request: { id: 'event-1', mine, theirs },
      view: { locale: 'en-US', timeZone: 'Asia/Shanghai', calendarNames: new Map([['calendar-1', 'Work']]) },
      onDecide,
    }))
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onDecide).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()

    const save = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('Save'))
    expect(save).toBeTruthy()
    await act(async () => { save!.click() })
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({
      action: 'save', input: expect.objectContaining({ title: 'Mine' }), rev: 2,
    }))
  })
})

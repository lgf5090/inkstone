import { act, createElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { CalendarDto } from '@shared/calendar/model'
import { initI18n } from '../../lib/i18n'
import { renderElement } from '../../lib/test-render'
import { CalendarEventDialog } from './CalendarEventDialog'

describe('CalendarEventDialog', () => {
  it('keeps the draft when an equivalent calendar registry refreshes', async () => {
    await initI18n()
    const initialStart = new Date('2026-11-26T01:00:00Z')
    const calendars = [{ id: 'calendar-1', name: 'Work', isDefault: true, readOnly: false }] as CalendarDto[]
    const render = (items: CalendarDto[]) => createElement(CalendarEventDialog, {
      open: true, initialStart, timeZone: 'UTC', calendars: items, defaultCalendarId: 'calendar-1',
      onClose: () => {}, onCreate: () => {},
    })
    const view = renderElement(render(calendars))
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')
    expect(input).toBeTruthy()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Keep my draft')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    view.rerender(render([...calendars]))
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe('Keep my draft')
  })
})

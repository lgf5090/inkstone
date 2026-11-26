import { act, createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Temporal } from 'temporal-polyfill'
import type { Event } from '@dayflow/react'
import { initI18n } from '../../lib/i18n'
import { renderElement } from '../../lib/test-render'
import { CalendarRecurrenceDialog } from './CalendarRecurrenceDialog'

const { applyMock } = vi.hoisted(() => ({ applyMock: vi.fn(async () => ({ masterId: 'master' })) }))
vi.mock('./api', () => ({ applyRecurrenceChange: applyMock }))

function occurrence(): Event {
  return {
    id: 'master::repeat-1795568400000', _recurrenceMasterId: 'master', title: 'Original', description: 'Notes',
    start: Temporal.ZonedDateTime.from('2026-11-24T09:00:00+00:00[UTC]'),
    end: Temporal.ZonedDateTime.from('2026-11-24T10:00:00+00:00[UTC]'),
    calendarId: 'calendar-1', calendarIds: ['calendar-1'], allDay: false,
  }
}

describe('CalendarRecurrenceDialog', () => {
  it('applies an edited title to the selected occurrence scope', async () => {
    await initI18n()
    const event = occurrence()
    const onApplied = vi.fn()
    renderElement(createElement(CalendarRecurrenceDialog, {
      request: { masterId: 'master', intent: 'save', before: event, after: event },
      timeZone: 'UTC', onClose: () => {}, onApplied,
    }))
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')
    expect(input).toBeTruthy()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Edited occurrence')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const apply = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find(button => button.textContent?.includes('Apply'))
    expect(apply).toBeTruthy()
    await act(async () => { apply!.click() })
    expect(applyMock).toHaveBeenCalledWith('master', expect.objectContaining({
      scope: 'this', action: 'update', patch: expect.objectContaining({ title: 'Edited occurrence' }),
    }))
    expect(onApplied).toHaveBeenCalled()
  })
})

import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CalendarDto, CalendarTemplateDto } from '@shared/calendar/model'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { CalendarEventDialog, type NewCalendarEvent } from './CalendarEventDialog'

const calendars = [{ id: 'calendar-1', name: 'Work', isDefault: true, readOnly: false }] as CalendarDto[]
const initialStart = new Date('2026-11-26T01:00:00Z')
let view: RenderedElement | null = null

function renderDialog(options: { allDay?: boolean; onCreate?: (event: NewCalendarEvent) => void } = {}) {
  const onCreate = options.onCreate ?? vi.fn()
  view = renderElement(createElement(CalendarEventDialog, {
    open: true,
    initialStart,
    timeZone: 'UTC',
    calendars,
    defaultCalendarId: 'calendar-1',
    template: options.allDay ? { title: '', allDay: true, durationMinutes: 60 } as CalendarTemplateDto : null,
    onClose: () => {},
    onCreate,
  }))
  return onCreate
}

function panel(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!node) throw new Error('the event dialog did not render a panel')
  return node
}

async function setValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(label: string): Promise<void> {
  const button = [...panel().querySelectorAll<HTMLButtonElement>('button')]
    .find(candidate => candidate.textContent?.includes(label))
  if (!button) throw new Error(`the "${label}" button is not rendered`)
  await act(async () => { button.click() })
}

afterEach(() => {
  view?.unmount()
  view = null
})

describe('CalendarEventDialog', () => {
  it('keeps the draft when an equivalent calendar registry refreshes', async () => {
    await initI18n()
    const render = (items: CalendarDto[]) => createElement(CalendarEventDialog, {
      open: true, initialStart, timeZone: 'UTC', calendars: items, defaultCalendarId: 'calendar-1',
      onClose: () => {}, onCreate: () => {},
    })
    view = renderElement(render(calendars))
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')
    expect(input).toBeTruthy()
    await setValue(input!, 'Keep my draft')
    view.rerender(render([...calendars]))
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe('Keep my draft')
  })

  it.each([false, true])('rejects a blank required title for allDay=%s and associates the error', async (allDay) => {
    await initI18n()
    const onCreate = renderDialog({ allDay })
    const title = panel().querySelector<HTMLInputElement>('#calendar-event-title')!
    expect(title.required).toBe(true)
    expect(title.getAttribute('aria-required')).toBe('true')
    await setValue(title, '   ')
    await click(t('calendar.event.create'))

    const error = panel().querySelector<HTMLElement>('[role="alert"]')!
    expect(onCreate).not.toHaveBeenCalled()
    expect(error.textContent).toBe(t('calendar.event.title_required'))
    expect(title.getAttribute('aria-invalid')).toBe('true')
    expect(title.getAttribute('aria-describedby')).toBe(error.id)
  })

  it('offers only ordinary events and creates the title the reader actually entered', async () => {
    await initI18n()
    const onCreate = renderDialog()
    expect(panel().textContent).not.toContain('Block type')
    expect(panel().textContent).not.toContain('Focus time')
    expect(panel().textContent).not.toContain('Out of office')
    expect(panel().querySelectorAll('[role="radio"]')).toHaveLength(0)

    await setValue(panel().querySelector<HTMLInputElement>('#calendar-event-title')!, '  Planning  ')
    await click(t('calendar.event.create'))
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ title: 'Planning', allDay: false, color: null }))
  })
})

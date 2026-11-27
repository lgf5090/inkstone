import { Temporal } from 'temporal-polyfill'
import type { Event } from '@dayflow/react'
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, setLocale, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { CalendarBatchDialog } from './CalendarBatchDialog'

function event(id: string): Event {
  return {
    id,
    title: id,
    start: Temporal.ZonedDateTime.from('2026-11-27T09:00:00+08:00[Asia/Shanghai]'),
    end: Temporal.ZonedDateTime.from('2026-11-27T10:00:00+08:00[Asia/Shanghai]'),
    allDay: false,
    calendarId: 'cal-1',
    calendarIds: ['cal-1'],
    meta: {},
  }
}

let view: RenderedElement | null = null

beforeAll(async () => {
  await initI18n()
  await setLocale('en-US', false)
})

afterEach(() => {
  view?.unmount()
  view = null
  document.body.innerHTML = ''
})

async function open(events: Event[], onMove: (date: string, time: string) => void, onColor: (color: string) => void): Promise<HTMLElement> {
  view = renderElement(createElement(CalendarBatchDialog, {
    open: true,
    events,
    timeZone: 'Asia/Shanghai',
    onClose: vi.fn(),
    onMove,
    onColor,
  }))
  await act(async () => { await Promise.resolve() })
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!dialog) throw new Error('batch dialog missing')
  return dialog
}

describe('CalendarBatchDialog', () => {
  it('moves the earliest event and applies a selected color through semantic controls', async () => {
    const onMove = vi.fn()
    const onColor = vi.fn()
    const dialog = await open([event('a'), event('b')], onMove, onColor)
    expect(dialog.textContent).toContain(t('calendar.batch.title', { count: 2 }))
    const inputs = [...dialog.querySelectorAll('input')]
    const setValue = (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await act(async () => {
      setValue(inputs[0]!, '2026-12-02')
      setValue(inputs[1]!, '11:30')
      const select = dialog.querySelector('select')!
      select.value = '#e5484d'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      const buttons = [...dialog.querySelectorAll('button')]
      buttons.find(button => button.textContent === t('calendar.batch.apply_move'))!.click()
      buttons.find(button => button.textContent === t('calendar.batch.apply_color'))!.click()
    })
    expect(onMove).toHaveBeenCalledWith('2026-12-02', '11:30')
    expect(onColor).toHaveBeenCalledWith('#e5484d')
  })

  it('shows an error instead of moving when the time is invalid', async () => {
    const onMove = vi.fn()
    const dialog = await open([event('a'), event('b')], onMove, vi.fn())
    const time = [...dialog.querySelectorAll('input')][1]!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(time, '99:99')
      time.dispatchEvent(new Event('input', { bubbles: true }))
      const buttons = [...dialog.querySelectorAll('button')]
      buttons.find(button => button.textContent === t('calendar.batch.apply_move'))!.click()
    })
    expect(onMove).not.toHaveBeenCalled()
    expect(dialog.textContent).toContain(t('calendar.batch.invalid_move'))
  })
})

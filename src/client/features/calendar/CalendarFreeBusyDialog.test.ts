import { act, createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { CalendarDto } from '@shared/calendar/model'
import { initI18n } from '../../lib/i18n'
import { renderElement } from '../../lib/test-render'
import { CalendarFreeBusyDialog } from './CalendarFreeBusyDialog'

const { getFreeBusy } = vi.hoisted(() => ({ getFreeBusy: vi.fn(async () => ({ busy: [], truncated: false })) }))
vi.mock('./api', () => ({ getFreeBusy }))

describe('CalendarFreeBusyDialog', () => {
  it('uses the calendar timezone and configured working hours', async () => {
    await initI18n()
    renderElement(createElement(CalendarFreeBusyDialog, {
      open: true,
      calendars: [{ id: 'calendar-1', name: 'Work', color: '#112233', isVisible: true }] as CalendarDto[],
      timeZone: 'Asia/Shanghai',
      workingHours: { enabled: true, startHour: 9, endHour: 18 },
      initialDate: new Date('2026-11-25T23:30:00Z'),
      onClose: () => {},
    }))
    await act(async () => { for (let index = 0; index < 6; index++) await Promise.resolve() })
    expect(getFreeBusy).toHaveBeenCalledWith(expect.objectContaining({
      from: Date.parse('2026-11-25T16:00:00Z'),
      to: Date.parse('2026-12-02T16:00:00Z'),
    }))
    expect(document.body.textContent).toContain('09:00')
  })
})

import { act, createElement } from 'react'
import { Temporal } from 'temporal-polyfill'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, setLocale, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { CalendarAlmanacDialog } from './CalendarAlmanacDialog'
import { loadAlmanacDetail } from './huangli'

vi.mock('./huangli', () => ({
  loadAlmanacDetail: vi.fn(async () => null),
  auspiciousHours: vi.fn(() => []),
}))

vi.mock('./linked', () => ({
  todosDueOn: vi.fn(async () => []),
  renewalsOn: vi.fn(async () => []),
}))

vi.mock('../todos/open-task', () => ({
  openTaskInTodo: vi.fn(),
}))

let view: RenderedElement | null = null

beforeAll(async () => {
  await initI18n()
  await setLocale('en-US', false)
})

afterEach(() => {
  view?.unmount()
  view = null
  vi.mocked(loadAlmanacDetail).mockResolvedValue(null)
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

async function open(dateKey: string): Promise<string> {
  view = renderElement(createElement(CalendarAlmanacDialog, {
    open: true,
    dateKey,
    countdowns: [],
    onClose: () => {},
    onJump: () => {},
  }))
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!dialog) throw new Error('the almanac dialog did not render')
  return dialog.textContent ?? ''
}

describe('CalendarAlmanacDialog holiday source', () => {
  it('shows the published notice for a holiday', async () => {
    const text = await open('2026-02-15')
    expect(text).toContain(t('calendar.almanac.holiday_off'))
    expect(text).toContain(t('calendar.almanac.source', { source: t('calendar.holidays.notice_2026') }))
    expect(text).not.toContain(t('calendar.almanac.source_none', { year: 2026 }))
    expect(text).not.toContain(t('calendar.almanac.source_ordinary', { year: 2026 }))
  })

  it('identifies an ordinary day in a published year without claiming the notice is missing', async () => {
    const text = await open('2026-11-04')
    expect(text).toContain(Temporal.PlainDate.from('2026-11-04').toLocaleString('en-US', { dateStyle: 'full' }))
    expect(text).not.toContain('Almanac · 2026-11-04')
    expect(text).toContain(t('calendar.almanac.source_ordinary', { year: 2026 }))
    expect(text).not.toContain(t('calendar.almanac.source_none', { year: 2026 }))
    expect(text).not.toContain(t('calendar.almanac.source', { source: t('calendar.holidays.notice_2026') }))
  })

  it('shows a visible failure when the almanac rule chunk cannot load', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    vi.mocked(loadAlmanacDetail).mockRejectedValueOnce(new Error('chunk unavailable'))
    const text = await open('2026-11-04')
    expect(text).toContain(t('calendar.almanac.detail_failed'))
  })

  it('states that an unpublished year is not inferred', async () => {
    const text = await open('2027-10-01')
    expect(text).toContain(t('calendar.almanac.source_none', { year: 2027 }))
    expect(text).not.toContain(t('calendar.almanac.source_ordinary', { year: 2027 }))
    expect(text).not.toContain(t('calendar.almanac.holiday_off'))
  })
})

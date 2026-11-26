import { act, createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { CalendarDto } from '@shared/calendar/model'
import { initI18n } from '../../lib/i18n'
import { renderElement } from '../../lib/test-render'
import { DeleteCalendarDialog } from './CalendarDialogs'

vi.mock('./api', () => ({ deleteCalendar: vi.fn(async () => {}) }))

function calendar(id: string, name: string, readOnly = false): CalendarDto {
  return { id, name, readOnly, rev: 1 } as CalendarDto
}

describe('DeleteCalendarDialog', () => {
  it('defaults to delete and offers only writable owned merge targets', async () => {
    await initI18n()
    const source = calendar('source', 'Source')
    renderElement(createElement(DeleteCalendarDialog, {
      open: true, calendar: source,
      calendars: [source, calendar('writable', 'Writable'), calendar('readonly', 'Read only', true), calendar('shared:owner:row', 'Shared')],
      onClose: () => {}, onSaved: () => {},
    }))
    const checked = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find(button => button.getAttribute('aria-checked') === 'true')
    expect(checked?.textContent).toContain('Delete')
    const merge = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find(button => button.textContent?.includes('Merge'))
    expect(merge).toBeTruthy()
    await act(async () => { merge!.click() })
    const options = [...document.querySelectorAll<HTMLSelectElement>('select option')].map(option => option.value)
    expect(options).toEqual(['writable'])
  })
})

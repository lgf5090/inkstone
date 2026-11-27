import { act, createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultCalendarPreferences } from '@shared/calendar/model'
import { initI18n } from '../../lib/i18n'
import { renderElement } from '../../lib/test-render'
import { CalendarSettings } from './CalendarSettings'

const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }))
vi.mock('../../components/overlay', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../components/overlay')>(),
  confirm: confirmMock,
}))

beforeEach(() => {
  confirmMock.mockReset()
})

describe('CalendarSettings', () => {
  it('asks before opening connections with an unsaved draft', async () => {
    await initI18n()
    const onOpenConnections = vi.fn()
    const preferences = defaultCalendarPreferences()
    renderElement(createElement(CalendarSettings, {
      open: true,
      preferences,
      onClose: () => {},
      onSave: vi.fn(async () => {}),
      onOpenConnections,
    }))
    const view = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find(button => button.textContent === 'Month')
    expect(view).toBeTruthy()
    await act(async () => { view!.click() })
    const add = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find(button => button.textContent === 'Add a connection')
    expect(add).toBeTruthy()

    confirmMock.mockResolvedValueOnce(false)
    await act(async () => { add!.click() })
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ tone: 'danger' }))
    expect(onOpenConnections).not.toHaveBeenCalled()

    confirmMock.mockResolvedValueOnce(true)
    await act(async () => { add!.click() })
    expect(onOpenConnections).toHaveBeenCalledTimes(1)
  })
})

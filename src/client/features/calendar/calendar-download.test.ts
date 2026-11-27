import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadCalendarText } from './calendar-download'

const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate)
  else Reflect.deleteProperty(URL, 'createObjectURL')
  if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke)
  else Reflect.deleteProperty(URL, 'revokeObjectURL')
})

describe('calendar downloads', () => {
  it('leaves the object URL alive until the browser has started the download', () => {
    vi.useFakeTimers()
    const create = vi.fn(() => 'blob:calendar')
    const revoke = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    downloadCalendarText('Week / plan', 'BEGIN:VCALENDAR', 'ics')

    expect(click).toHaveBeenCalledOnce()
    expect(revoke).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(revoke).toHaveBeenCalledWith('blob:calendar')
    expect(document.querySelector('a[download]')).toBeNull()
  })
})

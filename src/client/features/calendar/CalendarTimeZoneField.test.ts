import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderElement } from '../../lib/test-render'
import { CalendarTimeZoneField } from './CalendarTimeZoneField'

afterEach(() => vi.useRealTimers())

describe('CalendarTimeZoneField', () => {
  it('commits a valid zone once after typing pauses', async () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    renderElement(createElement(CalendarTimeZoneField, { value: 'UTC', label: 'Time zone', onChange }))
    const input = document.querySelector<HTMLInputElement>('input')!
    const set = (value: string) => {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    set('Asia/')
    set('Asia/Shanghai')
    expect(onChange).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('Asia/Shanghai')
  })
})

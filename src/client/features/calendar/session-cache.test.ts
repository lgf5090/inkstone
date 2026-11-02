// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { clearCalendarSessionCaches } from './session-cache'

beforeEach(() => localStorage.clear())

describe('calendar session cache cleanup', () => {
  it('removes only calendar snapshots and leaves other account data alone', () => {
    localStorage.setItem('inkstone.calendar.first-paint.v1:alice', '{}')
    localStorage.setItem('inkstone.calendar.range.v1:alice', '{}')
    localStorage.setItem('inkstone.ui', '{}')
    localStorage.setItem('inkstone.music.floating', '1')

    clearCalendarSessionCaches()

    expect(localStorage.getItem('inkstone.calendar.first-paint.v1:alice')).toBeNull()
    expect(localStorage.getItem('inkstone.calendar.range.v1:alice')).toBeNull()
    expect(localStorage.getItem('inkstone.ui')).toBe('{}')
    expect(localStorage.getItem('inkstone.music.floating')).toBe('1')
  })

  it('does nothing when storage is unavailable', () => {
    expect(() => clearCalendarSessionCaches(null)).not.toThrow()
  })
})

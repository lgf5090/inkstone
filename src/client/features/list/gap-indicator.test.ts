import { describe, expect, it } from 'vitest'
import { latestEditOutsideWindow } from './gap-indicator'

describe('latestEditOutsideWindow', () => {
  const window = { start: '2026-08-24', end: '2026-09-02' }

  it('is null when the newest edit is inside the window or inputs are empty', () => {
    expect(latestEditOutsideWindow(window, '2026-08-30')).toBeNull()
    expect(latestEditOutsideWindow(window, '2026-08-24')).toBeNull()
    expect(latestEditOutsideWindow(window, '2026-09-02')).toBeNull()
    expect(latestEditOutsideWindow(window, null)).toBeNull()
    expect(latestEditOutsideWindow(null, '2026-08-01')).toBeNull()
  })

  it('flags an edit that lags before the window start with its day count', () => {
    expect(latestEditOutsideWindow(window, '2026-08-12')).toEqual({ key: '2026-08-12', days: 12, ahead: false })
  })

  it('flags an edit ahead of the window end (clock skew / restored sync) with its day count', () => {
    expect(latestEditOutsideWindow(window, '2026-09-08')).toEqual({ key: '2026-09-08', days: 6, ahead: true })
  })
})

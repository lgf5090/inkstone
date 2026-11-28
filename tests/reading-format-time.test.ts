import { describe, expect, it } from 'vitest'
import { formatSyncTime } from '../src/client/features/reading/format-time'

describe('formatSyncTime', () => {
  it('shows the time for a sync from today', () => {
    const now = new Date(2026, 10, 25, 18, 30)
    expect(formatSyncTime(new Date(2026, 10, 25, 13, 5).getTime(), now.getTime())).toMatch(/\d{1,2}:\d{2}/)
  })

  it('includes the date for an older sync', () => {
    const now = new Date(2026, 10, 25, 18, 30)
    const formatted = formatSyncTime(new Date(2026, 10, 24, 13, 5).getTime(), now.getTime())
    expect(formatted).toMatch(/\d{1,2}:\d{2}/)
    expect(formatted).not.toBe(formatSyncTime(new Date(2026, 10, 25, 13, 5).getTime(), now.getTime()))
  })
})

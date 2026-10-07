import { describe, expect, it } from 'vitest'
import { computeLatestEditKey, latestEditOutsideWindow } from './gap-indicator'

describe('computeLatestEditKey', () => {
  const stamp = (iso: string) => new Date(iso).getTime()
  const note = (updatedAt: number, deletedAt: number | null = null, isArchived = false) => ({ updatedAt, deletedAt, isArchived })

  it('is null when there are no notes', () => {
    expect(computeLatestEditKey({})).toBeNull()
  })

  it('tracks the newest edit and skips deleted notes', () => {
    const notes = {
      a: note(stamp('2026-09-01T10:00:00.000Z')),
      b: note(stamp('2026-09-03T08:00:00.000Z')),
      c: note(stamp('2026-09-02T12:00:00.000Z'), stamp('2026-09-02T13:00:00.000Z')),
      d: note(stamp('2026-09-02T15:00:00.000Z')),
    }
    expect(computeLatestEditKey(notes)).toBe('2026-09-03')
  })

  it('ignores only-deleted collections', () => {
    expect(computeLatestEditKey({ a: note(stamp('2026-09-01T10:00:00.000Z'), stamp('2026-09-01T11:00:00.000Z')) })).toBeNull()
  })

  it('skips archived notes so the banner never points at an empty list', () => {
    const notes = {
      live: note(stamp('2026-09-01T10:00:00.000Z')),
      filed: note(stamp('2026-09-04T08:00:00.000Z'), null, true),
    }
    expect(computeLatestEditKey(notes)).toBe('2026-09-01')
    expect(computeLatestEditKey({ filed: notes.filed })).toBeNull()
  })
})

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

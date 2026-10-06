import { beforeEach, describe, expect, it } from 'vitest'
import { CALENDAR_PERSIST_KEY, loadCalendarPersist, saveCalendarPersist } from './calendar-persist'

describe('calendar persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to an expanded month view when nothing is stored', () => {
    expect(loadCalendarPersist(localStorage)).toEqual({ collapsed: false, view: 'month' })
  })

  it('round-trips collapsed and view state', () => {
    saveCalendarPersist({ collapsed: true, view: 'weeks' }, localStorage)
    expect(loadCalendarPersist(localStorage)).toEqual({ collapsed: true, view: 'weeks' })
    saveCalendarPersist({ collapsed: false, view: 'year' }, localStorage)
    expect(loadCalendarPersist(localStorage)).toEqual({ collapsed: false, view: 'year' })
  })

  it('falls back safely on corrupt JSON', () => {
    localStorage.setItem(CALENDAR_PERSIST_KEY, '{not json')
    expect(loadCalendarPersist(localStorage)).toEqual({ collapsed: false, view: 'month' })
  })

  it('rejects unknown view values', () => {
    localStorage.setItem(CALENDAR_PERSIST_KEY, JSON.stringify({ collapsed: true, view: 'grid' }))
    expect(loadCalendarPersist(localStorage)).toEqual({ collapsed: true, view: 'month' })
  })

  it('tolerates a missing storage object', () => {
    expect(loadCalendarPersist(null)).toEqual({ collapsed: false, view: 'month' })
    expect(() => saveCalendarPersist({ collapsed: true, view: 'weeks' }, null)).not.toThrow()
  })
})
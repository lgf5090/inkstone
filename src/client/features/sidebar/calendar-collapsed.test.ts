import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '@shared/types'
import { buildActivityProjectionCached } from '../../lib/calendar-activity'
import { renderElement, stubBreakpoint, type RenderedElement } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { SidebarCalendar } from './sidebar-calendar'

vi.mock('../../lib/calendar-activity', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/calendar-activity')>()
  return { ...real, buildActivityProjectionCached: vi.fn((notes: Record<string, NoteSummary>) => real.buildActivityProjectionCached(notes)) }
})

const summary = (id: string, updatedAt: number): NoteSummary => ({
  id, title: id, excerpt: '', folderId: null, tags: [], isPinned: false, isStarred: false,
  isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: 0, createdAt: updatedAt, updatedAt, deletedAt: null,
})

describe('a collapsed calendar block builds nothing', () => {
  const originalNotes = useNotes.getState()
  const originalUi = useUi.getState()
  let rendered: RenderedElement
  let container: HTMLElement
  let calls: () => number

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    stubBreakpoint(true)
    localStorage.clear()
    const module = await import('../../lib/calendar-activity')
    calls = () => vi.mocked(module.buildActivityProjectionCached).mock.calls.length
    vi.mocked(module.buildActivityProjectionCached).mockClear()
    useNotes.setState({ ...originalNotes, notes: { a: summary('a', new Date(2026, 9, 3, 12).getTime()) }, folders: [], tags: [] })
    useUi.setState({ ...originalUi, view: 'all', folderId: null, dateFilter: null, calendarJump: null, toasts: [] })
    rendered = renderElement(createElement(SidebarCalendar))
    container = rendered.container
  })

  afterEach(() => {
    rendered.unmount()
    useNotes.setState(originalNotes, true)
    useUi.setState(originalUi, true)
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  const toggle = () => container.querySelector<HTMLElement>('section [aria-expanded]')!

  it('walks the vault only while the grid is on screen', () => {
    expect(calls()).toBeGreaterThan(0)
    const commit = (id: string) => act(() => {
      useNotes.setState({ ...useNotes.getState(), notes: { ...useNotes.getState().notes, [id]: summary(id, new Date(2026, 9, 4, 12).getTime()) } })
    })
    const before = calls()
    commit('b')
    expect(calls()).toBeGreaterThan(before)

    act(() => { toggle().click() })
    expect(container.querySelectorAll('[data-day-key]').length).toBe(0)
    const whileClosed = calls()
    commit('c')
    commit('d')
    expect(calls()).toBe(whileClosed)

    act(() => { toggle().click() })
    expect(calls()).toBeGreaterThan(whileClosed)
    expect(container.querySelectorAll('[data-day-key]').length).toBeGreaterThan(0)
    expect(buildActivityProjectionCached(useNotes.getState().notes).counts.size).toBeGreaterThan(0)
  })
})

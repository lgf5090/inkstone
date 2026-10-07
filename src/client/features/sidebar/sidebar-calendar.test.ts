import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '@shared/types'
import { setLocaleAsync, t } from '../../lib/i18n'
import { renderElement, stubBreakpoint, type RenderedElement } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { CALENDAR_PERSIST_KEY } from './calendar-persist'
import { SidebarCalendar } from './sidebar-calendar'

const stamp = (year: number, month: number, day: number) => new Date(year, month - 1, day, 12).getTime()

const summary = (id: string, updatedAt: number): NoteSummary => ({
  id, title: id, excerpt: '', folderId: null, tags: [], isPinned: false, isStarred: false,
  isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: 0,
  createdAt: updatedAt, updatedAt, deletedAt: null,
})

const NOTES = {
  a: summary('a', stamp(2026, 10, 3)),
  b: summary('b', stamp(2026, 10, 4)),
  c: summary('c', stamp(2026, 10, 4)),
}

describe('the sidebar calendar block', () => {
  const originalNotes = useNotes.getState()
  const originalUi = useUi.getState()
  let rendered: RenderedElement
  let container: HTMLElement

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    stubBreakpoint(true)
    localStorage.clear()
    await setLocaleAsync('zh-CN')
    useNotes.setState({
      ...originalNotes,
      notes: NOTES,
      folders: [],
      tags: [],
      createNote: vi.fn(async () => 'created-id'),
      openNote: vi.fn(async () => undefined),
    })
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

  const dayButton = (key: string) => container.querySelector<HTMLButtonElement>(`[data-day-key="${key}"]`)

  it('draws the month grid for the cursor month with the legend', () => {
    expect(container.querySelector('section')).toBeTruthy()
    const switcher = container.querySelector<HTMLElement>(`[role="group"][aria-label="${t('sidebar.calendar_view')}"]`)
    expect([...(switcher?.querySelectorAll('button') ?? [])].map((b) => b.textContent?.trim())).toEqual([t('sidebar.calendar_month_view'), t('sidebar.calendar_week_view'), t('sidebar.calendar_year_view')])
    expect(container.textContent).toContain(t('sidebar.calendar_less'))
    expect(container.textContent).toContain(t('sidebar.calendar_more'))
  })

  it('filters the note list to the clicked day and files a diary note for it', () => {
    const key = '2026-10-04'
    act(() => { dayButton(key)?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(useUi.getState().dateFilter).toEqual({ start: key, end: key })
    const create = vi.mocked(useNotes.getState().createNote)
    expect(create).toHaveBeenCalledTimes(1)
    const input = create.mock.calls[0]?.[0]
    expect(input?.title).toContain(key)
    expect(input?.content).toContain(t('sidebar.diary_tag'))
  })

  it('moves the filter to a plain day, then clears it when that day is clicked again', () => {
    act(() => { useUi.getState().setDateFilter({ start: '2026-10-01', end: '2026-10-03' }) })
    act(() => { dayButton('2026-10-03')?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(useUi.getState().dateFilter).toEqual({ start: '2026-10-03', end: '2026-10-03' })
    act(() => { dayButton('2026-10-03')?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(useUi.getState().dateFilter).toBeNull()
  })

  it('routes the flagged latest-edit day to the gap jump instead of the diary flow', () => {
    const create = vi.mocked(useNotes.getState().createNote)
    act(() => { useUi.getState().setDateFilter({ start: '2026-10-01', end: '2026-10-03' }) })
    act(() => { dayButton('2026-10-04')?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(useUi.getState().dateFilter).toEqual({ start: '2026-10-04', end: '2026-10-04' })
    expect(create).not.toHaveBeenCalled()
  })

  it('switches to the year view and paints twelve month cards', () => {
    const switcher = container.querySelector<HTMLElement>(`[role="group"][aria-label="${t('sidebar.calendar_view')}"]`)
    const tabs = [...(switcher?.querySelectorAll('button') ?? [])]
    expect(tabs.length).toBe(3)
    act(() => { tabs[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.querySelectorAll('[data-month-card]').length).toBe(12)
    expect(container.querySelectorAll('[data-day-key]').length).toBe(0)
  })

  it('jumps to the month the settings preview asks for and persists the chosen view', () => {
    act(() => { useUi.setState({ calendarJump: { year: 2026, month: 6, nonce: 1 } }) })
    expect(dayButton('2026-07-15')).toBeTruthy()
    expect(useUi.getState().dateFilter).toBeNull()
    const stored = JSON.parse(localStorage.getItem(CALENDAR_PERSIST_KEY) ?? '{}') as { view?: string }
    expect(stored.view).toBe('month')
  })

  // Collapsing the block hides the heatmap but used to leave the whole-vault
  // projection attached to the notes map, so typing kept paying for a picture
  // nobody was looking at. Counting `updatedAt` reads is how this says "no scan"
  // without a wall-clock budget; the expanded arm above keeps the case honest by
  // proving the same commit does read the vault when the block is open.
  describe('the collapsed arm of C-28', () => {
    const counting = (id: string, updatedAt: number, counter: { reads: number }): NoteSummary => Object.defineProperty(
      summary(id, 0),
      'updatedAt',
      { enumerable: true, configurable: true, get: () => { counter.reads++; return updatedAt } },
    )

    const commitOneEdit = (counter: { reads: number }) => {
      const before = counter.reads
      act(() => {
        useNotes.setState({
          notes: { ...NOTES, b: counting('b', stamp(2026, 10, 5), counter) },
        })
      })
      return counter.reads - before
    }

    const toggle = () => container.querySelector<HTMLElement>('section > div > button[aria-expanded]')

    it('reads the vault for a commit while the block is open', () => {
      const counter = { reads: 0 }
      expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
      expect(commitOneEdit(counter)).toBeGreaterThan(0)
    })

    it('reads nothing for the same commit once the block is collapsed', () => {
      const counter = { reads: 0 }
      act(() => { toggle()?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
      expect(container.querySelectorAll('[data-day-key]').length).toBe(0)
      expect(commitOneEdit(counter)).toBe(0)
      expect(container.querySelector('section')).toBeTruthy()
    })
  })
})

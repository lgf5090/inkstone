// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ICalendarApp } from '@dayflow/react'
import { attachCalendarChrome } from './calendar-chrome'
import { narrowWeekdayLabels } from '../../lib/time'

function fakeApp(events: Array<{ id: string; meta?: Record<string, unknown> }> = []) {
  return {
    selectEvent: vi.fn(),
    highlightEvent: vi.fn(),
    onEventDetailToggle: vi.fn(),
    getEvents: vi.fn(() => events),
    getCurrentDate: vi.fn(() => new Date('2026-11-27T12:00:00Z')),
  } as unknown as ICalendarApp
}

function mount(): { root: HTMLElement; event: HTMLElement } {
  document.body.innerHTML = `
    <div id="root">
      <button id="dayflow-add-event-btn" title="创建新日历">
        <svg aria-hidden="true"></svg>
      </button>
      <div class="df-compact-header-labels">
        ${Array.from({ length: 7 }, () => '<span class="df-compact-header-label">周</span>').join('')}
      </div>
      <div class="df-event" data-event-id="event-1" data-all-day="false">
        <div class="df-event-title">Review</div>
        <div class="df-event-time">10:00</div>
      </div>
    </div>`
  return {
    root: document.getElementById('root')!,
    event: document.querySelector<HTMLElement>('.df-event')!,
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('calendar chrome bridge', () => {
  it('selects on click, opens the editor on double click, and labels the add button', () => {
    const { root, event } = mount()
    const app = fakeApp()
    const onAdd = vi.fn()
    const onRecurring = vi.fn()
    const onSelect = vi.fn()
    const onOpenDetail = vi.fn()
    const cleanup = attachCalendarChrome({
      root,
      app,
      locale: 'zh-CN',
      weekStart: 1,
      detailTrigger: 'dbClick',
      addLabel: '新建日程',
      untitledLabel: '未命名',
      allDayLabel: '全天',
      interceptEvents: true,
      onAdd,
      onRecurring,
      onSelect,
      onOpenDetail,
    })

    expect(event.tabIndex).toBe(0)
    expect(event.getAttribute('role')).toBe('button')
    expect(event.getAttribute('aria-label')).toBe('Review 10:00')
    expect(root.querySelector('#dayflow-add-event-btn')?.getAttribute('title')).toBe('新建日程')
    expect(root.querySelector('#dayflow-add-event-btn')?.getAttribute('aria-label')).toBe('新建日程')
    expect([...root.querySelectorAll('.df-compact-header-label')].map(node => node.textContent))
      .toEqual(narrowWeekdayLabels('zh-CN', 1))

    event.click()
    expect(app.selectEvent).toHaveBeenCalledWith('event-1')
    expect(app.highlightEvent).toHaveBeenCalledWith('event-1')
    expect(onSelect).toHaveBeenCalledWith('event-1')
    expect(onOpenDetail).not.toHaveBeenCalled()

    event.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(onOpenDetail).toHaveBeenCalledWith('event-1')

    root.querySelector<HTMLElement>('#dayflow-add-event-btn')!.click()
    expect(onAdd).toHaveBeenCalledTimes(1)

    event.focus()
    event.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onOpenDetail).toHaveBeenCalledTimes(2)
    expect(onRecurring).not.toHaveBeenCalled()

    cleanup()
    vi.mocked(app.selectEvent).mockClear()
    event.click()
    expect(app.selectEvent).not.toHaveBeenCalled()
  })

  it('refuses a recurrence occurrence instead of selecting a row that does not exist', () => {
    const { root, event } = mount()
    event.setAttribute('data-event-id', 'master::repeat-0')
    const app = fakeApp()
    const onRecurring = vi.fn()
    const cleanup = attachCalendarChrome({
      root,
      app,
      locale: 'en-US',
      weekStart: 0,
      detailTrigger: 'click',
      addLabel: 'New event',
      untitledLabel: 'Untitled',
      allDayLabel: 'All day',
      interceptEvents: true,
      onAdd: vi.fn(),
      onRecurring,
      onSelect: vi.fn(),
      onOpenDetail: vi.fn(),
    })
    event.click()
    expect(onRecurring).toHaveBeenCalledTimes(1)
    expect(app.selectEvent).not.toHaveBeenCalled()
    cleanup()
  })

  it('leaves the library paint on an event that has no colour of its own', () => {
    const { root, event } = mount()
    event.style.backgroundColor = 'rgb(59, 130, 246)'
    const cleanup = attachCalendarChrome({
      root,
      app: fakeApp([{ id: 'event-1' }]),
      locale: 'zh-CN',
      weekStart: 1,
      detailTrigger: 'dbClick',
      addLabel: '新建日程',
      untitledLabel: '未命名',
      allDayLabel: '全天',
      interceptEvents: true,
      onAdd: vi.fn(),
      onRecurring: vi.fn(),
      onSelect: vi.fn(),
      onOpenDetail: vi.fn(),
    })
    expect(event.style.backgroundColor).toBe('rgb(59, 130, 246)')
    cleanup()
  })

  it('paints a per-event colour and removes only the colour it applied', async () => {
    const { root, event } = mount()
    const events: Array<{ id: string; meta?: Record<string, unknown> }> = [
      { id: 'event-1', meta: { color: '#e5484d' } },
    ]
    const cleanup = attachCalendarChrome({
      root,
      app: fakeApp(events),
      locale: 'zh-CN',
      weekStart: 1,
      detailTrigger: 'dbClick',
      addLabel: '新建日程',
      untitledLabel: '未命名',
      allDayLabel: '全天',
      interceptEvents: true,
      onAdd: vi.fn(),
      onRecurring: vi.fn(),
      onSelect: vi.fn(),
      onOpenDetail: vi.fn(),
    })
    expect(event.style.backgroundColor).not.toBe('')
    events[0]!.meta = {}
    root.append(document.createElement('span'))
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(event.style.backgroundColor).toBe('')
    cleanup()
  })

  it('skips compact header layout reads when its cache key is unchanged', async () => {
    document.body.innerHTML = `<div id="root">
      <div class="df-compact-header">
        <div class="df-compact-header-labels">${Array.from({ length: 7 }, () => '<span class="df-compact-header-label-cell"><span class="df-compact-header-label">M</span></span>').join('')}</div>
        <div class="df-compact-header-dates">${Array.from({ length: 7 }, () => '<button class="df-compact-header-date-button"><span class="df-compact-header-date-pill">1</span></button>').join('')}</div>
      </div>
      <div class="df-week-time-grid-content"><div class="df-time-grid-row">${Array.from({ length: 7 }, () => '<div class="df-week-time-grid-cell"></div>').join('')}</div></div>
      <div class="df-week-time-grid-time-column"></div>
    </div>`
    const root = document.getElementById('root')!
    const header = root.querySelector<HTMLElement>('.df-compact-header')!
    const content = root.querySelector<HTMLElement>('.df-week-time-grid-content')!
    const timeColumn = root.querySelector<HTMLElement>('.df-week-time-grid-time-column')!
    const headerLayout = vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 700 } as DOMRect)
    const contentLayout = vi.spyOn(content, 'getBoundingClientRect').mockReturnValue({ left: 40, width: 700 } as DOMRect)
    const timeLayout = vi.spyOn(timeColumn, 'getBoundingClientRect').mockReturnValue({ width: 40 } as DOMRect)
    const cleanup = attachCalendarChrome({
      root, app: fakeApp(), locale: 'en-US', weekStart: 0, detailTrigger: 'click',
      addLabel: 'New event', untitledLabel: 'Untitled', allDayLabel: 'All day',
      interceptEvents: true, onAdd: vi.fn(), onRecurring: vi.fn(), onSelect: vi.fn(), onOpenDetail: vi.fn(),
    })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(headerLayout).toHaveBeenCalled()
    headerLayout.mockClear()
    contentLayout.mockClear()
    timeLayout.mockClear()
    root.append(document.createElement('span'))
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(headerLayout).not.toHaveBeenCalled()
    expect(contentLayout).not.toHaveBeenCalled()
    expect(timeLayout).not.toHaveBeenCalled()
    cleanup()
  })

  it('reads the event registry once per pass instead of once per block', () => {
    const blocks = Array.from({ length: 20 }, (_, index) => `
      <div class="df-event" data-event-id="event-${index}" data-all-day="false">
        <div class="df-event-title">Event ${index}</div>
        <div class="df-event-time">10:00</div>
      </div>`).join('')
    document.body.innerHTML = `<div id="root">${blocks}</div>`
    const root = document.getElementById('root')!
    const events = Array.from({ length: 20 }, (_, index) => ({ id: `event-${index}` }))
    const app = fakeApp(events)
    const cleanup = attachCalendarChrome({
      root,
      app,
      locale: 'zh-CN',
      weekStart: 1,
      detailTrigger: 'dbClick',
      addLabel: '新建日程',
      untitledLabel: '未命名',
      allDayLabel: '全天',
      interceptEvents: true,
      onAdd: vi.fn(),
      onRecurring: vi.fn(),
      onSelect: vi.fn(),
      onOpenDetail: vi.fn(),
    })
    expect(vi.mocked(app.getEvents).mock.calls.length).toBeLessThanOrEqual(2)
    cleanup()
  })
})

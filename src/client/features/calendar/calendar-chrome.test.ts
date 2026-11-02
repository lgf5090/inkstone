// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ICalendarApp } from '@dayflow/react'
import { attachCalendarChrome } from './calendar-chrome'
import { narrowWeekdayLabels } from '../../lib/time'

function fakeApp() {
  return {
    selectEvent: vi.fn(),
    highlightEvent: vi.fn(),
    onEventDetailToggle: vi.fn(),
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
})

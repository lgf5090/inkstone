import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memo, MemoStats } from '@shared/memos/types'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { MemoCalendarPage } from './MemoCalendarPage'

const api = vi.hoisted(() => ({
  list: vi.fn(),
  stats: {
    get: vi.fn(),
  },
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, memosApi: api }
})

const CREATED_AT = Math.floor(new Date(2026, 2, 5, 12, 0, 0).getTime() / 1000)

function memo(id: string, content: string, createdAt: number): Memo {
  return {
    id,
    content,
    title: '',
    snippet: content,
    tags: [],
    visibility: 'private',
    state: 'normal',
    pinned: false,
    spaceId: null,
    parentId: null,
    location: null,
    properties: {
      hasLink: false,
      hasCode: false,
      hasTaskList: false,
      hasIncompleteTasks: false,
      hasLocation: false,
    },
    attachments: [],
    reactions: [],
    relations: [],
    commentCount: 0,
    rev: 0,
    createdAt,
    updatedAt: createdAt,
  }
}

const STATS: MemoStats = {
  total: 3,
  archived: 1,
  comments: 0,
  attachmentBytes: 0,
  tagCounts: {},
  typeCounts: { link: 0, code: 0, todo: 0, undo: 0 },
  dayCounts: {},
}

let view: RenderedElement | null = null

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function setUrl(path: string): void {
  window.history.replaceState(null, '', path)
}

function dayButton(container: HTMLElement, key: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`[data-memo-calendar-day="${key}"]`)
  if (!button) throw new Error(`no day ${key}`)
  return button
}

function press(button: HTMLButtonElement, key: string): void {
  act(() => {
    button.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  vi.clearAllMocks()
  setUrl('/memos/calendar/2026/3/5')
  api.list.mockResolvedValue({
    items: [memo('memo-1', 'March memo', CREATED_AT)],
    nextCursor: null,
  })
  api.stats.get.mockResolvedValue(STATS)
})

afterEach(() => {
  view?.unmount()
  view = null
  window.history.replaceState(null, '', '/')
})

describe('memo calendar page', () => {
  it('marks the day named by the address and lists that day without its own request', async () => {
    view = renderElement(createElement(MemoCalendarPage))
    await flush()
    const container = view.container

    expect(dayButton(container, '2026-03-05').parentElement?.getAttribute('aria-selected')).toBe('true')
    expect(dayButton(container, '2026-03-06').parentElement?.getAttribute('aria-selected')).toBe('false')
    expect(container.textContent).toContain('March memo')
    expect(container.textContent).toContain(t('memos.calendar.day_count_one'))
    expect(api.list).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 100,
        orderBy: 'created',
        order: 'asc',
      }),
      expect.any(AbortSignal),
    )
    expect(api.stats.get).toHaveBeenCalledWith(
      expect.objectContaining({ timeBasis: 'created' }),
      expect.any(AbortSignal),
    )
  })

  it('moves the selected day and the address with the arrow, Home and End keys', async () => {
    view = renderElement(createElement(MemoCalendarPage))
    await flush()
    const container = view.container

    press(dayButton(container, '2026-03-05'), 'ArrowRight')
    expect(window.location.pathname).toBe('/memos/calendar/2026/3/6')
    await flush()
    expect(dayButton(container, '2026-03-06').parentElement?.getAttribute('aria-selected')).toBe('true')

    press(dayButton(container, '2026-03-06'), 'End')
    expect(window.location.pathname).toBe('/memos/calendar/2026/3/31')
    await flush()

    press(dayButton(container, '2026-03-31'), 'Home')
    expect(window.location.pathname).toBe('/memos/calendar/2026/3/1')
    await flush()

    press(dayButton(container, '2026-03-01'), 'ArrowUp')
    expect(window.location.pathname).toBe('/memos/calendar/2026/2/22')
    await flush()
    expect(dayButton(container, '2026-02-22').parentElement?.getAttribute('aria-selected')).toBe('true')
  })

  it('opens a memo through the callback when its day row is pressed', async () => {
    const onOpenMemo = vi.fn()
    view = renderElement(createElement(MemoCalendarPage, { onOpenMemo }))
    await flush()
    const link = view.container.querySelector<HTMLAnchorElement>('a[href="/memos/m/memo-1"]')
    expect(link).not.toBeNull()
    act(() => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    })
    expect(onOpenMemo).toHaveBeenCalledWith('memo-1')
    expect(window.location.pathname).toBe('/memos/calendar/2026/3/5')
  })
})

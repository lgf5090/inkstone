import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoStats } from '@shared/memos/types'
import { initI18n, t } from '../../../lib/i18n'
import { formatDateKey } from '../../../lib/time'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { StatsSection } from './StatsSection'

const api = vi.hoisted(() => ({
  stats: {
    get: vi.fn(),
  },
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, memosApi: api }
})

const STATS: MemoStats = {
  total: 12,
  archived: 2,
  comments: 3,
  attachmentBytes: 1024,
  tagCounts: { work: 2 },
  typeCounts: { link: 1, code: 2, todo: 3, undo: 4 },
  dayCounts: { '2026-03-05': 3, '2026-03-06': 1 },
}

let view: RenderedElement | null = null

function renderStats(): HTMLElement {
  view = renderElement(createElement(StatsSection))
  return view.container
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function setUrl(path: string): void {
  window.history.replaceState(null, '', path)
}

function valueOf(container: HTMLElement, label: string): string | null {
  const term = [...container.querySelectorAll('dt')].find((node) => node.textContent === label)
  return term?.nextElementSibling?.textContent ?? null
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.includes(text))
  if (!button) throw new Error(`no button containing ${text}`)
  return button
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  vi.clearAllMocks()
  setUrl('/memos/spaces/team/calendar/2026/3')
  api.stats.get.mockResolvedValue(STATS)
})

afterEach(() => {
  view?.unmount()
  view = null
  window.history.replaceState(null, '', '/')
})

describe('sidebar stats section', () => {
  it('shows totals, type counts and the selected month heat strip', async () => {
    const container = renderStats()
    await flush()

    expect(valueOf(container, t('memos.stats.total'))).toBe('12')
    expect(valueOf(container, t('memos.stats.archived'))).toBe('2')
    expect(valueOf(container, t('memos.stats.comments'))).toBe('3')
    expect(valueOf(container, t('memos.stats.links'))).toBe('1')
    expect(valueOf(container, t('memos.stats.code'))).toBe('2')
    expect(valueOf(container, t('memos.stats.tasks'))).toBe('3')
    expect(valueOf(container, t('memos.stats.open_tasks'))).toBe('4')

    const day = container.querySelector('[data-memo-stats-day="2026-03-05"]')
    expect(day).not.toBeNull()
    expect(day?.getAttribute('title')).toBe(t('memos.stats.day_count', {
      date: formatDateKey('2026-03-05'),
      count: 3,
    }))
    expect(container.querySelector('[data-memo-stats-day="2026-03-04"]')).not.toBeNull()
    expect(container.querySelector('[data-memo-stats-day="2026-04-01"]')).toBeNull()
    expect(container.textContent).toContain(t('memos.stats.month_total', { count: 4 }))

    expect(api.stats.get).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: 'team',
        timeBasis: 'created',
      }),
      expect.any(AbortSignal),
    )
    expect(container.textContent).not.toContain(t('memos.sidebar.stats_placeholder'))
  })

  it('links to the calendar of the space and month it is describing', async () => {
    const container = renderStats()
    await flush()
    const link = container.querySelector<HTMLAnchorElement>(
      'a[href="/memos/spaces/team/calendar/2026/3"]',
    )
    expect(link).not.toBeNull()
    expect(link?.textContent).toContain(t('memos.stats.open_calendar'))
    act(() => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    })
    expect(window.location.pathname).toBe('/memos/spaces/team/calendar/2026/3')
  })

  it('offers a retry after a failed load', async () => {
    api.stats.get.mockRejectedValueOnce(new Error('offline'))
    const container = renderStats()
    await flush()
    expect(container.textContent).toContain(t('memos.stats.error'))
    const retry = buttonWithText(container, t('memos.common.retry'))
    act(() => {
      retry.click()
    })
    await flush()
    expect(valueOf(container, t('memos.stats.total'))).toBe('12')
    expect(container.textContent).not.toContain(t('memos.stats.error'))
  })
})

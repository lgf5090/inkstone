// @vitest-environment jsdom
/**
 * One link's own reading: what it asks the hub for, and how much of the answer it prints.
 *
 * The two failures ported here are both about honesty of the number on screen. The reference sliced each
 * breakdown to five rows under a heading that named the whole set, so a country that was sixth was not
 * reported anywhere; and its traffic filters were a separate invention from the log's, which is how a
 * dashboard and a log came to disagree about what "real visitors" meant. The assertions below pin both:
 * every row the API answered is drawn, and the default reading asks the same question the log's `real`
 * filter asks.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShareNoteAnalytics, ShareVisitLog } from '@shared/share-hub'
import { visitMatchesLogFilter, visitMatchesTraffic } from '@shared/share-selection'
import { initI18n, t } from '../../../lib/i18n'
import { installTestGlobals } from '../../../lib/test-render'
import { REAL_VISITOR_TOGGLES, trafficParams } from './share-readings'
import { ShareNoteAnalyticsModal } from './note-analytics-modal'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))

vi.mock('../../../lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(readonly status = 500, readonly code = 'error', message = 'failed') {
      super(message)
    }
  },
  request,
}))

const NOTE_ID = 'note-one'

let calls: string[]
let reading: ShareNoteAnalytics
let root: Root
let host: HTMLElement

function visit(overrides: Partial<ShareVisitLog> & { id: number }): ShareVisitLog {
  return {
    noteId: NOTE_ID,
    noteTitle: 'Planning',
    slug: 'abc',
    visitedAt: 1_700_000_000_000,
    country: 'DE',
    region: null,
    city: null,
    referrer: null,
    referrerHost: null,
    deviceType: 'desktop',
    os: 'Linux',
    browser: 'Firefox',
    isBot: false,
    channel: null,
    visitorFp: 'deadbeefcafe1234',
    ...overrides,
  }
}

function baseReading(): ShareNoteAnalytics {
  return {
    range: '30d',
    noteId: NOTE_ID,
    noteTitle: 'Planning',
    slug: 'abc',
    url: 'https://notes.test/s/abc',
    createdAt: 1_700_000_000_000,
    expiresAt: null,
    hasPassword: false,
    isEnabled: true,
    totalViews: 340,
    totalVisitors: 120,
    timeline: [
      { label: 'Mon', timestamp: 1, views: 4, visitors: 3 },
      { label: 'Tue', timestamp: 2, views: 9, visitors: 5 },
    ],
    topCountries: [
      { name: 'DE', count: 7, percentage: 7 },
      { name: 'FR', count: 6, percentage: 6 },
      { name: 'BR', count: 5, percentage: 5 },
      { name: 'JP', count: 4, percentage: 4 },
      { name: 'AU', count: 3, percentage: 3 },
      { name: 'CA', count: 2, percentage: 2 },
      // A geo answer that is not a region code at all: printed as it arrived, not swallowed.
      { name: 'n/a', count: 1, percentage: 1 },
    ],
    topReferrers: [{ name: 'newsletter.example', count: 12, percentage: 40 }],
    devices: [{ name: 'desktop', count: 20, percentage: 60 }],
    osList: [{ name: 'Linux', count: 8, percentage: 24 }],
    browsers: [{ name: 'Firefox', count: 8, percentage: 24 }],
    channels: [
      { name: '__unmarked__', count: 5, percentage: 10 },
      { name: '__unrecognized__', count: 2, percentage: 4 },
      { name: 'collection-abc', count: 9, percentage: 18, label: 'Field notes' },
    ],
    recentVisits: [visit({ id: 1 }), visit({ id: 2, isBot: true, botName: 'Googlebot' })],
  }
}

function byText(text: string): HTMLElement | null {
  return [...document.body.querySelectorAll<HTMLElement>('button, [role="radio"]')].find((node) => node.textContent?.trim() === text) ?? null
}

async function show(): Promise<void> {
  await act(async () => {
    root.render(createElement(ShareNoteAnalyticsModal, { noteId: NOTE_ID, noteTitle: 'Planning', onClose: () => {} }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(node: HTMLElement | null): Promise<void> {
  await act(async () => {
    node?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function noteCall(): string {
  return calls.filter((path) => path.includes('/api/share/analytics/note/')).at(-1) ?? ''
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  calls = []
  reading = baseReading()
  request.mockImplementation((path: string) => {
    calls.push(path)
    if (path.includes('/api/share/analytics/note/')) return Promise.resolve(reading)
    if (path.includes('/api/share/audit/')) {
      return Promise.resolve({ entries: [], total: 0, page: 1, limit: 100 })
    }
    return Promise.resolve({})
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('what the reading asks for', () => {
  it('opens on real visitors, the same set the log selects with its `real` filter', async () => {
    await show()
    const call = noteCall()
    expect(call).toContain('range=30d')
    expect(call).toContain('excludeBots=true')
    expect(call).toContain('excludeSelf=true')
    expect(call).toContain('excludeOwner=true')
    // One rule, two surfaces: the toggles the readings send are the three the log's filter is written as.
    const toggles = trafficParams(REAL_VISITOR_TOGGLES)
    for (const subject of [{}, { isBot: true }, { isOwner: true }, { isSelfReferrer: true }]) {
      expect(visitMatchesLogFilter(subject, 'real'))
        .toBe(visitMatchesTraffic(subject, { excludeBots: toggles.excludeBots, excludeSelfReferrers: toggles.excludeSelf, excludeOwner: toggles.excludeOwner }))
    }
  })

  it('re-reads the moment one exclusion is turned off', async () => {
    await show()
    await click(byText(t('share.reading_exclude_bots')))
    expect(noteCall()).toContain('excludeBots=false')
    expect(noteCall()).toContain('excludeOwner=true')
    expect(document.body.textContent).toContain(t('share.reading_traffic_custom'))
  })

  it('re-reads on another window without losing the exclusions it holds', async () => {
    await show()
    await click(byText(t('share.reading_range_7d')))
    expect(noteCall()).toContain('range=7d')
    expect(noteCall()).toContain('excludeBots=true')
  })
})

describe('what the reading prints', () => {
  it('draws every breakdown row the API answered, not the first five', async () => {
    await show()
    expect(document.body.textContent).toContain(t('share.top_countries_title'))
    // Seven countries came back; a card sliced to five would leave two rows unmentioned on the screen.
    expect(document.body.querySelectorAll('thead th[scope="col"]').length).toBeGreaterThan(0)
    for (const name of ['Germany', 'France', 'Brazil', 'Japan', 'Australia', 'Canada', 'n/a']) {
      expect(document.body.textContent, `${name} was dropped from the country card`).toContain(name)
    }
  })

  it('keeps unmarked and refused visits as two separate channel rows', async () => {
    await show()
    const text = document.body.textContent ?? ''
    expect(text).toContain(t('share.channel_unmarked'))
    expect(text).toContain(t('share.channel_unrecognized'))
    // A directory the worker could name is printed by its title, not by its token.
    expect(text).toContain('Field notes')
  })

  it('prints the visitor column as the label the server truncated, never more', async () => {
    reading.recentVisits = [visit({ id: 1, visitorFp: '0123456789abcdef0123456789abcdef' })]
    await show()
    const cells = [...document.body.querySelectorAll('tbody tr td:last-child')].map((cell) => cell.textContent?.trim() ?? '')
    expect(cells).toContain('01234567')
    expect(cells.some((cell) => cell.length > 8)).toBe(false)
  })

  it('names the chart, and says so when there is nothing to draw', async () => {
    await show()
    const canvas = document.body.querySelector('canvas[role="img"]')
    // The label carries the numbers the picture stands for: a reader who cannot see it gets the same
    // reading, and the sum is the plotted window rather than the all-time counter.
    expect(canvas?.getAttribute('aria-label')).toContain(t('share.metric_pv'))
    expect(canvas?.getAttribute('aria-label')).toContain('13')
    expect(canvas?.getAttribute('aria-label')).toContain('9')
    reading = { ...baseReading(), timeline: [], totalViews: 0, totalVisitors: 0 }
    await click(byText(t('common.refresh')))
    expect(document.body.querySelector('canvas[role="img"]')).toBeNull()
    expect(document.body.textContent).toContain(t('share.no_data_yet'))
  })

  it('is a table with a header cell per column and a row header per visit', async () => {
    await show()
    expect(document.body.querySelectorAll('thead th[scope="col"]').length).toBe(5)
    expect(document.body.querySelectorAll('tbody th[scope="row"]').length).toBe(2)
  })

  it('reports a failed reading instead of an empty one', async () => {
    request.mockImplementation((path: string) => {
      calls.push(path)
      if (path.includes('/api/share/analytics/note/')) return Promise.reject(new Error('boom'))
      return Promise.resolve({ entries: [], total: 0, page: 1, limit: 100 })
    })
    await show()
    expect(document.body.textContent).toContain(t('share.analytics_load_failed'))
    expect(byText(t('common.retry'))).toBeTruthy()
  })

  it('carries the link history beside the numbers', async () => {
    await show()
    expect(document.body.textContent).toContain(t('share.audit_history_title'))
    expect(calls.some((path) => path.includes(`/api/share/audit/${NOTE_ID}`))).toBe(true)
  })
})

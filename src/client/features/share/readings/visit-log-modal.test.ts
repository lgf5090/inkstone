// @vitest-environment jsdom
/**
 * The visit log's own three promises: a page count that is the server's, a channel drill-down that
 * refuses rather than widens, and a row that says no more about a visitor than eight characters.
 *
 * Each of them is a failure the reference shipped: a footer that showed one page size while the route
 * answered with another, a drill-down that folded "no marker" and "refused marker" into a single row, and
 * a table that would have printed whatever the API put in the visitor column. The assertions below are
 * written against the wire and the rendered text, because a component that computes its own ceiling is
 * exactly the kind of thing that passes a test of the computation and lies to the reader.
 */
import { act, createElement, Fragment, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { visitMatchesLogFilter, visitMatchesTraffic, type VisitTrafficSubject } from '@shared/share-selection'
import type { ShareNoteAnalytics, ShareVisitLog, ShareVisitsResponse } from '@shared/share-hub'
import { ConfirmHost } from '../../../components/overlay'
import { Toaster } from '../../../components/feedback'
import { initI18n, t } from '../../../lib/i18n'
import { installTestGlobals } from '../../../lib/test-render'
import { REAL_VISITOR_TOGGLES, trafficParams } from './share-readings'
import { ShareVisitLogModal } from './visit-log-modal'

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
const CHANNELS = [
  { name: '__unmarked__', count: 5 },
  { name: '__unrecognized__', count: 2 },
  { name: 'newsletter-may', count: 9 },
  // A name the column could never hold, which is what the drill-down has to refuse.
  { name: 'Bad Marker!', count: 1 },
]

let calls: string[]
let deletes: string[]
let bodies: Array<Record<string, unknown>>
let root: Root
let host: HTMLElement
let visits: ShareVisitsResponse

function row(overrides: Partial<ShareVisitLog> & { id: number }): ShareVisitLog {
  return {
    noteId: NOTE_ID,
    noteTitle: 'Planning',
    slug: 'abc',
    visitedAt: 1_700_000_000_000,
    country: 'DE',
    region: null,
    city: null,
    referrer: 'https://newsletter.example/story',
    referrerHost: 'newsletter.example',
    deviceType: 'desktop',
    os: 'Linux',
    browser: 'Firefox',
    isBot: false,
    channel: 'newsletter-may',
    visitorFp: 'deadbeefcafe1234',
    ...overrides,
  }
}

/** A page of the shape the route answers with: `totalPages` is the server's arithmetic, not ours. */
function pageOf(count: number, page: number, totalPages: number): ShareVisitsResponse {
  return {
    visits: Array.from({ length: count }, (_, index) => row({ id: page * 100 + index })),
    total: count * totalPages,
    page,
    limit: count,
    totalPages,
  }
}

function noteAnalytics(): ShareNoteAnalytics {
  return {
    range: 'all',
    noteId: NOTE_ID,
    noteTitle: 'Planning',
    slug: 'abc',
    url: `https://notes.test/s/abc`,
    createdAt: 1,
    expiresAt: null,
    hasPassword: false,
    isEnabled: true,
    totalViews: 20,
    totalVisitors: 12,
    timeline: [],
    topCountries: [],
    topReferrers: [],
    devices: [],
    osList: [],
    browsers: [],
    channels: CHANNELS,
    recentVisits: [],
  }
}

function route(path: string, init: { method?: string, body?: unknown }): Promise<unknown> {
  calls.push(path)
  if (init.method === 'DELETE') {
    deletes.push(path)
    return Promise.resolve({ ok: true, deleted: 4_210 })
  }
  if (init.body && typeof init.body === 'object') bodies.push(init.body as Record<string, unknown>)
  if (path.startsWith('/api/share/visits')) return Promise.resolve(visits)
  if (path.startsWith('/api/share/analytics/')) return Promise.resolve(noteAnalytics())
  return Promise.resolve({})
}

function byText(text: string): HTMLElement | null {
  return [...document.body.querySelectorAll<HTMLElement>('button, [role="radio"]')].find((node) => node.textContent?.trim() === text) ?? null
}

function channelSelect(): HTMLSelectElement | null {
  return document.body.querySelector<HTMLSelectElement>(`select[aria-label="${t('share.log_channel_label')}"]`)
}

function rowsRendered(): number {
  return document.body.querySelectorAll('tbody tr').length
}

async function show(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(node)
    await Promise.resolve()
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  calls = []
  deletes = []
  bodies = []
  visits = pageOf(3, 1, 7)
  request.mockImplementation((path: string, init: { method?: string, body?: unknown } = {}) => route(path, init))
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

describe('the visit log’s paging', () => {
  it('shows the page count the server answered with, not one it computed itself', async () => {
    await show(createElement(ShareVisitLogModal, { noteId: NOTE_ID, onClose: () => {} }))
    const footer = document.body.textContent ?? ''
    expect(footer).toContain(t('share.reading_page_info', { page: 1, totalPages: 7 }))
    // 3 rows a page, 21 pages' worth of rows: a footer drawn from a guessed page size would say 3.
    expect(footer).toContain(t('share.log_rows_shown', { from: 1, to: 3, total: '21' }))
  })

  it('walks to the next page through the route', async () => {
    await show(createElement(ShareVisitLogModal, { noteId: NOTE_ID, onClose: () => {} }))
    const next = byText(t('share.reading_next_page'))
    expect(next?.hasAttribute('disabled')).toBe(false)
    await act(async () => {
      next?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(calls.filter((path) => path.includes('/api/share/visits')).at(-1)).toContain('page=2')
  })

  it('stops on the last page the server named', async () => {
    visits = pageOf(3, 7, 7)
    await show(createElement(ShareVisitLogModal, { noteId: NOTE_ID, onClose: () => {} }))
    expect(document.body.textContent).toContain(t('share.reading_page_info', { page: 7, totalPages: 7 }))
    expect(byText(t('share.reading_next_page'))?.hasAttribute('disabled')).toBe(true)
    expect(byText(t('share.reading_prev_page'))?.hasAttribute('disabled')).toBe(false)
  })
})

describe('the visit log’s traffic filter', () => {
  it('sends the single-choice filter and asks no further traffic question', async () => {
    await show(createElement(ShareVisitLogModal, { noteId: NOTE_ID, onClose: () => {} }))
    const real = byText(t('share.log_filter_real'))
    await act(async () => {
      real?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    const logCall = calls.find((path) => path.includes('/api/share/visits')) ?? ''
    expect(logCall).toContain('filter=real')
    // The log's `WHERE` reads one filter value; toggles sent beside it would be a question the route
    // does not answer, so the surface must not imply it asked one.
    expect(logCall).not.toContain('excludeBots')
  })

  it('selects the same rows as the readings’ real-visitor toggles', () => {
    const fixtures: VisitTrafficSubject[] = [
      {},
      { isBot: true },
      { isOwner: true },
      { isSelfReferrer: true },
      { isBot: true, isOwner: true },
      { isBot: false, isOwner: false, isSelfReferrer: false },
    ]
    const toggles = trafficParams(REAL_VISITOR_TOGGLES)
    for (const subject of fixtures) {
      expect(visitMatchesLogFilter(subject, 'real'))
        .toBe(visitMatchesTraffic(subject, { excludeBots: toggles.excludeBots, excludeSelfReferrers: toggles.excludeSelf, excludeOwner: toggles.excludeOwner }))
    }
  })

  it('keeps the five classes of row it can name', async () => {
    await show(createElement(ShareVisitLogModal, { noteId: NOTE_ID, onClose: () => {} }))
    for (const label of ['share.log_filter_all', 'share.log_filter_real', 'share.log_filter_bot', 'share.log_filter_owner', 'share.log_filter_self']) {
      expect(byText(t(label as Parameters<typeof t>[0])), label).toBeTruthy()
    }
  })
})

describe('the visit log’s channel drill-down', () => {
  it('refuses a marker the column cannot hold instead of showing every row', async () => {
    await show(createElement(ShareVisitLogModal, { noteId: NOTE_ID, onClose: () => {} }))
    await settle()
    const before = calls.filter((path) => path.includes('/api/share/visits')).length
    expect(rowsRendered()).toBe(3)
    const select = channelSelect()
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(select, 'Bad Marker!')
      select?.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain(t('share.log_channel_refused', { channel: 'Bad Marker!' }).slice(0, 24))
    expect(calls.filter((path) => path.includes('/api/share/visits')).length).toBe(before)
    // The rows on screen are still the unrefused reading — not nothing, and not everything.
    expect(rowsRendered()).toBe(3)
  })

  it('keeps "no marker" and "marker refused" as two options and two rows', async () => {
    visits = {
      ...pageOf(2, 1, 1),
      visits: [row({ id: 1, channel: null }), row({ id: 2, channel: '' })],
    }
    await show(createElement(ShareVisitLogModal, { noteId: NOTE_ID, onClose: () => {} }))
    await settle()
    const select = channelSelect()
    const values = [...(select?.querySelectorAll('option') ?? [])].map((option) => option.value)
    expect(values).toContain('__unmarked__')
    expect(values).toContain('__unrecognized__')
    const named = [...(select?.querySelectorAll('option') ?? [])].map((option) => option.textContent ?? '')
    expect(named.filter((text) => text.includes(t('share.channel_unmarked')))).toHaveLength(1)
    expect(named.filter((text) => text.includes(t('share.channel_unrecognized')))).toHaveLength(1)
    const cells = [...document.body.querySelectorAll('tbody tr')].map((tr) => tr.textContent ?? '')
    expect(cells[0]).toContain(t('share.channel_unmarked'))
    expect(cells[0]).not.toContain(t('share.channel_unrecognized'))
    expect(cells[1]).toContain(t('share.channel_unrecognized'))
    expect(cells[1]).not.toContain(t('share.channel_unmarked'))
  })

  it('asks for the reserved name as a filter rather than a widened reading', async () => {
    await show(createElement(ShareVisitLogModal, { noteId: NOTE_ID, onClose: () => {} }))
    await settle()
    const select = channelSelect()
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(select, '__unrecognized__')
      select?.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    const last = calls.filter((path) => path.includes('/api/share/visits')).at(-1) ?? ''
    expect(last).toContain('channel=__unrecognized__')
  })
})

describe('what a visit row may say', () => {
  it('prints at most the eight-character visitor label', async () => {
    visits = { ...pageOf(1, 1, 1), visits: [row({ id: 1, visitorFp: '0123456789abcdef0123456789abcdef' })] }
    await show(createElement(ShareVisitLogModal, { noteId: NOTE_ID, onClose: () => {} }))
    const cell = document.body.querySelector('tbody tr')?.lastElementChild?.textContent ?? ''
    expect(cell.trim()).toBe('01234567')
  })

  it('names a deleted note instead of leaving the column blank', async () => {
    visits = { ...pageOf(1, 1, 1), visits: [row({ id: 1, noteTitle: null })] }
    await show(createElement(ShareVisitLogModal, { onClose: () => {} }))
    expect(document.body.textContent).toContain(t('share.log_note_deleted'))
  })

  it('is a table with column headers and a row header per visit', async () => {
    await show(createElement(ShareVisitLogModal, { onClose: () => {} }))
    expect(document.body.querySelectorAll('thead th[scope="col"]').length).toBeGreaterThanOrEqual(7)
    expect(document.body.querySelectorAll('tbody th[scope="row"]').length).toBe(3)
  })
})

describe('clearing the log', () => {
  it('confirms first and reports how many rows actually went', async () => {
    await show(createElement(Fragment, null,
      createElement(ConfirmHost),
      createElement(Toaster),
      createElement(ShareVisitLogModal, { noteId: NOTE_ID, onClose: () => {} }),
    ))
    const clear = byText(t('share.log_clear_btn'))
    await act(async () => {
      clear?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    // Nothing was deleted: the confirmation is on screen and the destructive call has not been made.
    expect(deletes).toHaveLength(0)
    expect(document.body.textContent).toContain(t('share.log_clear_confirm_title'))

    const confirmButton = [...document.body.querySelectorAll('button')].find((node) => node.textContent?.trim() === t('share.log_clear_confirm_action'))
    expect(confirmButton, 'the confirmation offers no way through').toBeTruthy()
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(deletes).toEqual(['/api/share/visits'])
    expect(document.body.textContent).toContain(t('share.log_cleared', { count: '4,210' }))
  })
})

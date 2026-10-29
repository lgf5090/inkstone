// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_NAV_SETTINGS,
  type NavBootstrap,
  type NavCategory,
  type NavCheckResult,
  type NavLink,
} from '../src/shared/nav/model'
import { useNavStore } from '../src/client/features/nav/nav-store'
import { useSession } from '../src/client/store/session'
import { useUi } from '../src/client/store/ui'
import { navApi } from '../src/client/features/nav/api'
import { LinkCheckerModal } from '../src/client/features/nav/NavChecker'
import { ConfirmHost } from '../src/client/components/overlay'
import { initI18n, t } from '../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../src/client/lib/test-render'

const CATEGORY = makeCategory({ id: 'cat-tools', name: 'Tools' })
const BROKEN = makeLink({ id: 'link-broken', title: 'Broken site', url: 'https://broken.example/' })
const WARNING = makeLink({ id: 'link-warning', title: 'Warning site', url: 'https://warning.example/' })
const OK = makeLink({ id: 'link-ok', title: 'Okay site', url: 'https://ok.example/' })
const SKIPPED = makeLink({ id: 'link-skipped', title: 'Private site', url: 'https://private.example/' })

const RESULTS = new Map<string, NavCheckResult>([
  [BROKEN.url, { url: BROKEN.url, status: 404, ok: false, level: 'broken', durationMs: 42, errorCode: 'http_error' }],
  [WARNING.url, { url: WARNING.url, status: 403, ok: false, level: 'warning', durationMs: 31 }],
  [OK.url, { url: OK.url, status: 200, ok: true, level: 'ok', durationMs: 18 }],
  [SKIPPED.url, { url: SKIPPED.url, status: null, ok: false, level: 'skipped', durationMs: 1, errorCode: 'blocked_target' }],
])

const BOOTSTRAP: NavBootstrap = {
  categories: [],
  links: [],
  visits: {},
  settings: DEFAULT_NAV_SETTINGS,
  webdav: { url: '', username: '', hasPassword: false },
  counts: { total: 0, byCategory: {} },
  serverTime: 1,
}

function makeCategory(overrides: { id: string; name: string } & Partial<NavCategory>): NavCategory {
  return {
    icon: 'folder',
    parentId: null,
    hasPassword: false,
    passwordMode: 'none',
    sortOrder: 0,
    createdAt: 1,
    ...overrides,
  }
}

function makeLink(overrides: { id: string; title: string; url: string } & Partial<NavLink>): NavLink {
  return {
    icon: null,
    description: null,
    categoryId: CATEGORY.id,
    pinned: false,
    pinnedOrder: 0,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function seed(links: NavLink[]): void {
  useNavStore.setState({
    status: 'ready',
    error: null,
    categories: [CATEGORY],
    links,
    visits: {},
    counts: { total: links.length, byCategory: { [CATEGORY.id]: links.length } },
    settings: DEFAULT_NAV_SETTINGS,
    webdav: { url: '', username: '', hasPassword: false },
    sync: 'idle',
    unlockTokens: {},
    selectedCategory: null,
    selectedSubcategory: null,
    query: '',
  })
}

let checkSpy: ReturnType<typeof vi.spyOn>
let batchSpy: ReturnType<typeof vi.spyOn>
let bootstrapSpy: ReturnType<typeof vi.spyOn>
let rendered: RenderedElement | null = null

function click(element: Element): void {
  act(() => {
    ;(element as HTMLElement).click()
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function buttonByText(text: string, root: Element | Document = document): HTMLButtonElement {
  const match = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text,
  )
  if (!match) throw new Error(`No button labelled "${text}"`)
  return match
}

function buttonByLabel(label: string, root: Element | Document = document): HTMLButtonElement {
  const match = [...root.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find(
    (button) => button.getAttribute('aria-label') === label,
  )
  if (!match) throw new Error(`No button named "${label}"`)
  return match
}

function lastDialog(): HTMLElement {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
  const dialog = dialogs.at(-1)
  if (!dialog) throw new Error('No dialog is open')
  return dialog
}

function mount(): { onClose: ReturnType<typeof vi.fn>; onEditLink: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn()
  const onEditLink = vi.fn()
  rendered = renderElement(
    <>
      <LinkCheckerModal open onClose={onClose} onEditLink={onEditLink} />
      <ConfirmHost />
    </>,
  )
  return { onClose, onEditLink }
}

function cacheRow(level: NavCheckResult['level'], checkedAt: number): Record<string, unknown> {
  return { status: 404, ok: false, level, durationMs: 12, errorCode: 'http_error', checkedAt }
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
  useSession.setState({ user: { id: 'user-1' } as never })
  useUi.setState({ toasts: [] })
  checkSpy = vi.spyOn(navApi, 'check').mockImplementation(async (urls: string[]) => ({
    results: urls.map((url) => RESULTS.get(url) ?? { url, status: 200, ok: true, level: 'ok', durationMs: 10 }),
  }))
  batchSpy = vi.spyOn(navApi, 'batch').mockResolvedValue({})
  bootstrapSpy = vi.spyOn(navApi, 'bootstrap').mockResolvedValue(BOOTSTRAP)
  seed([BROKEN, WARNING, OK, SKIPPED])
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  vi.restoreAllMocks()
})

describe('LinkCheckerModal', () => {
  it('scans every http link in one batch and writes the per-user cache', async () => {
    let release: (() => void) | null = null
    checkSpy.mockImplementation((urls: string[]) => new Promise((resolve) => {
      release = () => resolve({
        results: urls.map((url) => RESULTS.get(url) ?? { url, status: 200, ok: true, level: 'ok', durationMs: 10 }),
      })
    }))

    mount()

    click(buttonByText(t('nav.checker.start')))
    await flush()

    expect(checkSpy).toHaveBeenCalledTimes(1)
    expect(checkSpy.mock.calls[0]?.[0]).toEqual([BROKEN.url, WARNING.url, OK.url, SKIPPED.url])
    expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0')
    expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuemax')).toBe('4')

    act(() => release?.())
    await flush()
    await flush()

    expect(document.querySelector('[role="progressbar"]')).toBeNull()
    expect(document.body.textContent).toContain(`${t('nav.checker.ok')} 1`)
    expect(document.body.textContent).toContain(`${t('nav.checker.warning')} 1`)
    expect(document.body.textContent).toContain(`${t('nav.checker.broken')} 1`)
    expect(document.body.textContent).toContain(t('nav.checker.error.http_error'))
    expect(buttonByText(t('nav.checker.restart'))).toBeTruthy()

    const cached = JSON.parse(window.localStorage.getItem('inkstone.nav.linkCheck.user-1') ?? '{}') as Record<string, { level: string }>
    expect(Object.keys(cached)).toHaveLength(4)
    expect(cached[BROKEN.id]?.level).toBe('broken')
    expect(cached[SKIPPED.id]?.level).toBe('skipped')
  })

  it('filters rows and selects the visible or broken ones', async () => {
    window.localStorage.setItem('inkstone.nav.linkCheck.user-1', JSON.stringify({
      [BROKEN.id]: cacheRow('broken', Date.now()),
      [WARNING.id]: cacheRow('warning', Date.now()),
      [OK.id]: cacheRow('ok', Date.now()),
    }))
    const { onEditLink } = mount()
    await flush()

    expect(document.querySelectorAll('tbody tr')).toHaveLength(4)
    const brokenFilter = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find(
      (radio) => radio.textContent?.trim() === `${t('nav.checker.broken')} (1)`,
    )
    if (!brokenFilter) throw new Error('No broken filter')
    click(brokenFilter)
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(document.querySelector('tbody')?.textContent).toContain(BROKEN.title)

    click(buttonByText(t('nav.checker.select_current')))
    expect(document.body.textContent).toContain(t('nav.checker.selected', { count: 1 }))

    click(buttonByText(t('nav.checker.select_broken')))
    expect(document.body.textContent).toContain(t('nav.checker.selected', { count: 1 }))

    click(buttonByLabel(`${t('nav.edit')} ${BROKEN.title}`))
    expect(onEditLink).toHaveBeenCalledWith(expect.objectContaining({ id: BROKEN.id }))

    click(buttonByText(t('nav.checker.clear_selection')))
    expect(document.body.textContent).not.toContain(t('nav.checker.selected', { count: 1 }))
  })

  it('deletes the broken selection through the batch endpoint after confirmation', async () => {
    window.localStorage.setItem('inkstone.nav.linkCheck.user-1', JSON.stringify({
      [BROKEN.id]: cacheRow('broken', Date.now()),
      [WARNING.id]: cacheRow('warning', Date.now()),
    }))
    mount()
    await flush()

    click(buttonByText(t('nav.checker.select_broken')))
    click(buttonByText(t('nav.checker.batch_delete')))
    click(buttonByText(t('nav.delete'), lastDialog()))
    await flush()

    expect(batchSpy).toHaveBeenCalledWith({ action: 'delete', ids: [BROKEN.id] })
    expect(bootstrapSpy).toHaveBeenCalled()
  })

  it('ignores cached results older than the 24 hour window', async () => {
    window.localStorage.setItem('inkstone.nav.linkCheck.user-1', JSON.stringify({
      [BROKEN.id]: cacheRow('broken', Date.now() - 25 * 60 * 60 * 1000),
    }))
    mount()
    await flush()

    const brokenFilter = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find(
      (radio) => radio.textContent?.trim() === `${t('nav.checker.broken')} (0)`,
    )
    expect(brokenFilter).toBeTruthy()
    expect(document.querySelectorAll('tbody tr')).toHaveLength(4)
  })

  it('renders no rows while closed', () => {
    seed(Array.from({ length: 250 }, (_, index) => makeLink({ id: `closed-${index}`, title: `Closed ${index}`, url: `https://closed-${index}.example/` })))
    rendered = renderElement(<LinkCheckerModal open={false} onClose={() => {}} onEditLink={() => {}} />)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelectorAll('tbody tr')).toHaveLength(0)
  })

  it('renders one page of rows and loads the rest on request', async () => {
    const links = Array.from({ length: 250 }, (_, index) => makeLink({ id: `page-${index}`, title: `Page ${index}`, url: `https://page-${index}.example/` }))
    seed(links)
    mount()
    await flush()

    expect(document.querySelectorAll('tbody tr')).toHaveLength(200)
    click(buttonByText(t('nav.load_more', { shown: 200, total: 250 })))
    await flush()
    expect(document.querySelectorAll('tbody tr')).toHaveLength(250)
    expect([...document.querySelectorAll('button')].some((button) => button.textContent?.includes(t('nav.load_more', { shown: 200, total: 250 })))).toBe(false)
  })

  it('chunks bulk actions over the request limit', async () => {
    const links = Array.from({ length: 600 }, (_, index) => makeLink({ id: `bulk-${index}`, title: `Bulk ${index}`, url: `https://bulk-${index}.example/` }))
    seed(links)
    mount()
    await flush()

    click(buttonByText(t('nav.checker.select_current')))
    click(buttonByText(t('nav.checker.batch_delete')))
    click(buttonByText(t('nav.delete'), lastDialog()))
    await flush()

    const calls = (batchSpy.mock.calls as Array<[{ ids: string[] }]>).map(([body]) => body.ids.length)
    expect(calls).toEqual([500, 100])
  })
})

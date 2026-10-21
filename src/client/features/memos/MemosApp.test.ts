// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memo, MemoListResponse, MemoSpace, MemoView } from '@shared/memos/types'
import { navigateToPath } from '../../lib/app-history'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, stubBreakpoint } from '../../lib/test-render'
import { MemosApp } from './MemosApp'
import { useMemos } from './state'

const api = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  patch: vi.fn(),
  remove: vi.fn(),
  restore: vi.fn(),
  comments: { list: vi.fn(), create: vi.fn() },
  relations: { get: vi.fn(), put: vi.fn() },
  reactions: { list: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
  views: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), validate: vi.fn() },
  preferences: { get: vi.fn(), patch: vi.fn() },
  spaces: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  attachments: { list: vi.fn(), upload: vi.fn(), delete: vi.fn(), batchDelete: vi.fn(), prune: vi.fn() },
}))

vi.mock('./api', () => ({ memosApi: api }))

function memo(overrides: Partial<Memo> = {}): Memo {
  return {
    id: 'memo-1',
    content: 'first memo',
    title: '',
    snippet: '',
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
    rev: 1,
    createdAt: Math.floor(Date.now() / 1000) - 3600,
    updatedAt: Math.floor(Date.now() / 1000) - 3600,
    ...overrides,
  }
}

function emptyList(): MemoListResponse {
  return { items: [], nextCursor: null }
}

function link(host: HTMLElement, text: string): HTMLAnchorElement {
  const found = [...host.querySelectorAll('a')].find((anchor) => anchor.textContent?.includes(text))
  if (!found) throw new Error(`no link named ${text}`)
  return found
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

let root: Root | null = null

beforeEach(async () => {
  installTestGlobals()
  stubBreakpoint(true)
  await initI18n()
  window.history.replaceState(null, '', '/memos')
  localStorage.clear()
  useMemos.getState().reset()
  vi.clearAllMocks()
  api.list.mockResolvedValue(emptyList())
  api.spaces.list.mockResolvedValue({ spaces: [] })
  api.views.list.mockResolvedValue({ views: [] })
  api.comments.list.mockResolvedValue(emptyList())
  api.relations.get.mockResolvedValue({ outgoing: [], incoming: [] })
  api.get.mockResolvedValue(memo())
})

afterEach(() => {
  act(() => { root?.unmount() })
  root = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function mount(): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root?.render(createElement(MemosApp)) })
  return host
}

describe('the memos container', () => {
  it('draws the home feed and marks Home as the current page', async () => {
    const host = mount()
    await flush()
    expect(host.querySelector('[data-memos-page="home"]')).not.toBeNull()
    expect(host.querySelector('[data-memos-feed="home"]')).not.toBeNull()
    const home = link(host, t('memos.nav.home'))
    expect(home.getAttribute('aria-current')).toBe('page')
    expect(host.querySelector('textarea')).not.toBeNull()
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.list.mock.calls[0]?.[0]).toMatchObject({ state: 'normal', orderBy: 'created', order: 'desc' })
  })

  it('switches pages from the address and keeps the sidebar in step', async () => {
    const host = mount()
    await flush()
    act(() => navigateToPath('/memos/archived'))
    await flush()
    expect(host.querySelector('[data-memos-page="archived"]')).not.toBeNull()
    expect(host.querySelector('[data-memos-feed="archived"]')).not.toBeNull()
    expect(link(host, t('memos.nav.archived')).getAttribute('aria-current')).toBe('page')
    expect(api.list.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'archived' })

    act(() => navigateToPath('/memos/calendar'))
    await flush()
    expect(host.querySelector('[data-memos-page="calendar"]')).not.toBeNull()
    expect(host.textContent).toContain(t('memos.placeholder.calendar_description'))

    act(() => navigateToPath('/memos/not-a-page'))
    await flush()
    expect(host.querySelector('[data-memos-page="notFound"]')).not.toBeNull()
    expect(host.textContent).toContain(t('memos.placeholder.not_found_title'))
  })

  it('shows a memo detail panel on a wide screen when the address names a memo', async () => {
    const item = memo({ content: 'detail body', tags: ['work'] })
    api.list.mockResolvedValue({ items: [item], nextCursor: null })
    api.get.mockResolvedValue(item)
    const host = mount()
    await flush()
    act(() => navigateToPath('/memos/m/memo-1'))
    await flush()
    const panel = host.querySelector('[data-memos-detail-panel]')
    expect(panel).not.toBeNull()
    expect(panel?.textContent).toContain('detail body')
    expect(host.querySelector('[data-memos-page="memo"]')).not.toBeNull()
  })

  it('renders fetched memos with their body, tags and comment count', async () => {
    const item = memo({
      id: 'memo-a',
      content: '# hello\n\n<script>alert(1)</script>',
      tags: ['work'],
      commentCount: 3,
    })
    api.list.mockResolvedValue({ items: [item, memo({ id: 'memo-b', content: 'second' })], nextCursor: null })
    const host = mount()
    await flush()
    expect(host.querySelector('[data-memo-id="memo-a"]')).not.toBeNull()
    expect(host.textContent).toContain('hello')
    expect(host.querySelector('script')).toBeNull()
    expect(host.textContent).toContain('work')
    expect(host.textContent).toContain(t('memos.feed.count', { count: 2 }))
  })

  it('shows the empty state when the list has nothing', async () => {
    const host = mount()
    await flush()
    expect(host.textContent).toContain(t('memos.feed.empty_title'))
  })

  it('shows the error state and retries the request', async () => {
    api.list.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(emptyList())
    const host = mount()
    await flush()
    expect(host.textContent).toContain(t('memos.feed.error_title'))
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(t('memos.common.retry')))
    expect(retry).toBeDefined()
    click(retry!)
    await flush()
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain(t('memos.feed.empty_title'))
  })

  it('persists a display choice and sorts by the chosen time basis', async () => {
    api.list.mockResolvedValue({ items: [memo({ id: 'memo-a' })], nextCursor: null })
    const host = mount()
    await flush()
    const displayTrigger = [...host.querySelectorAll('button')]
      .find((button) => button.getAttribute('aria-label') === t('memos.feed.display'))
    expect(displayTrigger).toBeDefined()
    click(displayTrigger!)
    const twoColumns = [...document.querySelectorAll('[role^="menuitem"]')]
      .find((item) => item.textContent?.includes(t('memos.feed.columns_2')))
    expect(twoColumns).toBeDefined()
    click(twoColumns!)
    await flush()
    expect(JSON.parse(localStorage.getItem('inkstone.memos.display') ?? '{}').columns).toBe(2)
    expect(window.location.search).toContain('display=2')
    expect(host.querySelector('[data-memos-feed] .grid')?.className).toContain('md:grid-cols-2')

    const sortTrigger = [...host.querySelectorAll('button')]
      .find((button) => button.getAttribute('aria-label') === t('memos.feed.sort'))
    click(sortTrigger!)
    const recentlyUpdated = [...document.querySelectorAll('[role^="menuitem"]')]
      .find((item) => item.textContent?.includes(t('memos.feed.sort_updated_desc')))
    expect(recentlyUpdated).toBeDefined()
    click(recentlyUpdated!)
    await flush()
    expect(window.location.search).toContain('sort=updated-desc')
    expect(api.list.mock.calls.at(-1)?.[0]).toMatchObject({ orderBy: 'updated', order: 'desc' })
  })

  it('follows spaces and saved views from the sidebar', async () => {
    const space: MemoSpace = {
      id: 'space-1',
      title: 'Research',
      description: '',
      icon: '',
      memoCount: 2,
      createdAt: 1,
      updatedAt: 1,
    }
    const view: MemoView = { id: 'view-1', title: 'Pinned', filter: 'pinned', icon: '', createdAt: 1, updatedAt: 1 }
    api.spaces.list.mockResolvedValue({ spaces: [space] })
    api.views.list.mockResolvedValue({ views: [view] })
    const host = mount()
    await flush()
    const spaceLink = link(host, 'Research')
    expect(spaceLink.getAttribute('href')).toBe('/memos/spaces/space-1')
    click(spaceLink)
    await flush()
    expect(host.querySelector('[data-memos-page="space"]')).not.toBeNull()
    expect(host.textContent).toContain('Research')
    expect(api.list.mock.calls.at(-1)?.[0]).toMatchObject({ spaceId: 'space-1', state: 'normal' })
    expect(link(host, 'Research').getAttribute('aria-current')).toBe('page')

    click(link(host, 'Pinned'))
    await flush()
    expect(host.querySelector('[data-memos-page="home"]')).not.toBeNull()
    expect(host.textContent).toContain('pinned')
    expect(api.list.mock.calls.at(-1)?.[0]).toMatchObject({ filter: '(pinned)' })
  })
})

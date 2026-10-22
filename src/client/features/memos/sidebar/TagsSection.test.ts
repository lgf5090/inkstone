// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoStats } from '@shared/memos/types'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { TagsSection } from './TagsSection'
import { MEMO_TAG_BROWSER_STORAGE_KEY } from './tag-browser'

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
  stats: { get: vi.fn() },
}))

vi.mock('../api', () => ({ memosApi: api }))

function stats(tagCounts: Record<string, number>): MemoStats {
  return {
    total: 3,
    archived: 0,
    comments: 0,
    attachmentBytes: 0,
    tagCounts,
    typeCounts: { link: 0, code: 0, todo: 0, undo: 0 },
    dayCounts: {},
  }
}

let view: RenderedElement | null = null

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

function render(): HTMLElement {
  view = renderElement(createElement(TagsSection))
  return view.container
}

function tagButtons(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('[data-memo-tag-path]')]
}

function namedButton(host: HTMLElement, name: string): HTMLButtonElement {
  const found = tagButtons(host).find((button) => button.dataset.memoTagPath === name)
  if (!found) throw new Error(`no tag button named ${name}`)
  return found
}

function hasButton(host: HTMLElement, name: string): boolean {
  return tagButtons(host).some((button) => button.dataset.memoTagPath === name)
}

beforeEach(async () => {
  await initI18n()
  localStorage.clear()
  window.history.replaceState(null, '', '/memos')
  vi.clearAllMocks()
  api.stats.get.mockResolvedValue(stats({ work: 2, 'work/meeting': 1, personal: 1 }))
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('the memo tag section', () => {
  it('draws a tree with counts and folds child tags', async () => {
    const host = render()
    await flush()
    expect(host.querySelector('[role="tree"]')?.getAttribute('aria-label')).toBe(t('memos.tags.tree_label'))
    expect(namedButton(host, 'work').closest('[role="treeitem"]')?.textContent).toContain('2')
    expect(namedButton(host, 'personal').closest('[role="treeitem"]')?.textContent).toContain('1')
    expect(hasButton(host, 'work/meeting')).toBe(false)

    const workItem = namedButton(host, 'work').closest('[role="treeitem"]')
    const toggle = workItem?.querySelector<HTMLButtonElement>('[data-tree-toggle]')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    click(toggle!)
    await flush()
    expect(hasButton(host, 'work/meeting')).toBe(true)
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(JSON.parse(localStorage.getItem(MEMO_TAG_BROWSER_STORAGE_KEY) ?? '{}').expanded).toEqual(['work'])
  })

  it('walks the tree with the arrow keys', async () => {
    const host = render()
    await flush()
    const work = namedButton(host, 'work')
    act(() => { work.focus() })
    act(() => {
      work.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    })
    await flush()
    expect(hasButton(host, 'work/meeting')).toBe(true)
    act(() => {
      work.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    })
    expect(document.activeElement?.getAttribute('data-memo-tag-path')).toBe('work/meeting')
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
      )
    })
    expect(document.activeElement?.getAttribute('data-memo-tag-path')).toBe('work')
  })

  it('keeps the expanded branch after a remount', async () => {
    const host = render()
    await flush()
    const toggle = namedButton(host, 'work').closest('[role="treeitem"]')?.querySelector('[data-tree-toggle]')
    click(toggle!)
    await flush()
    act(() => { view?.unmount() })
    view = null
    const again = render()
    await flush()
    expect(hasButton(again, 'work/meeting')).toBe(true)
  })

  it('switches to a flat list of full paths', async () => {
    const host = render()
    await flush()
    const flat = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.getAttribute('aria-label') === t('memos.tags.flat_mode'))
    expect(flat?.getAttribute('aria-pressed')).toBe('false')
    click(flat!)
    await flush()
    expect(flat?.getAttribute('aria-pressed')).toBe('true')
    expect(namedButton(host, 'work/meeting')).not.toBeNull()
    expect(namedButton(host, 'personal')).not.toBeNull()
    expect(JSON.parse(localStorage.getItem(MEMO_TAG_BROWSER_STORAGE_KEY) ?? '{}').mode).toBe('flat')
  })

  it('marks the active tag and reveals its ancestors', async () => {
    window.history.replaceState(null, '', '/memos?tag=work%2Fmeeting')
    const host = render()
    await flush()
    const meeting = namedButton(host, 'work/meeting')
    expect(meeting.getAttribute('aria-current')).toBe('page')
    const workItem = namedButton(host, 'work').closest('[role="treeitem"]')
    expect(workItem?.getAttribute('aria-expanded')).toBe('true')
  })

  it('filters by a tag and keeps the current display and order', async () => {
    window.history.replaceState(null, '', '/memos?sort=updated-asc&display=compact')
    const host = render()
    await flush()
    click(namedButton(host, 'personal'))
    await flush()
    const params = new URLSearchParams(window.location.search)
    expect(window.location.pathname).toBe('/memos')
    expect(params.get('tag')).toBe('personal')
    expect(params.get('sort')).toBe('updated-asc')
    expect(params.get('display')).toBe('compact')
  })

  it('scopes counts to the current space and keeps the space on navigation', async () => {
    window.history.replaceState(null, '', '/memos/spaces/space-1')
    const host = render()
    await flush()
    expect(api.stats.get).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: 'space-1', tz: expect.any(String) }),
      expect.anything(),
    )
    click(namedButton(host, 'work'))
    await flush()
    expect(window.location.pathname).toBe('/memos/spaces/space-1')
    expect(new URLSearchParams(window.location.search).get('tag')).toBe('work')
  })

  it('reloads the counts when the window regains focus', async () => {
    render()
    await flush()
    expect(api.stats.get).toHaveBeenCalledTimes(1)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(api.stats.get).toHaveBeenCalledTimes(2)
  })

  it('shows the empty, error and loading states', async () => {
    api.stats.get.mockResolvedValueOnce(stats({}))
    const empty = render()
    await flush()
    expect(empty.textContent).toContain(t('memos.tags.empty'))
    expect(empty.textContent).not.toContain(t('memos.sidebar.tags_placeholder'))
    act(() => { view?.unmount() })
    view = null

    api.stats.get.mockRejectedValueOnce(new Error('offline'))
    const failed = render()
    await flush()
    expect(failed.textContent).toContain(t('api.error.unknown'))
    const retry = [...failed.querySelectorAll('button')]
      .find((button) => button.textContent?.includes(t('memos.common.retry')))
    click(retry!)
    await flush()
    expect(hasButton(failed, 'work')).toBe(true)
    act(() => { view?.unmount() })
    view = null

    api.stats.get.mockImplementation(() => new Promise(() => {}))
    const loading = render()
    await flush()
    expect(loading.querySelectorAll('.skeleton').length).toBeGreaterThan(0)
  })
})

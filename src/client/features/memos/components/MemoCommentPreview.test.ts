// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memo } from '@shared/memos/types'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { MemoCommentPreview } from './MemoCommentPreview'

const api = vi.hoisted(() => ({
  comments: { list: vi.fn(), create: vi.fn() },
}))

vi.mock('../api', () => ({ memosApi: api }))

class VisibleIntersectionObserver {
  readonly root = null
  readonly rootMargin = ''
  readonly thresholds: readonly number[] = []
  private readonly callback: IntersectionObserverCallback

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
  }

  observe(target: Element): void {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }

  unobserve(): void {}

  disconnect(): void {}

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

function comment(id: string, content: string, snippet = ''): Memo {
  return {
    id,
    content,
    title: '',
    snippet,
    tags: [],
    visibility: 'private',
    state: 'normal',
    pinned: false,
    spaceId: null,
    parentId: 'memo-1',
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
    createdAt: 1,
    updatedAt: 1,
  }
}

let view: RenderedElement | null = null

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function renderStandalone(node: ReactNode): RenderedElement {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(node) })
  return {
    container,
    rerender: (next: ReactNode) => { act(() => { root.render(next) }) },
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

beforeEach(async () => {
  await initI18n()
  vi.clearAllMocks()
  vi.stubGlobal('IntersectionObserver', VisibleIntersectionObserver)
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('the memo comment preview', () => {
  it('renders nothing and asks for nothing when the memo has no comments', async () => {
    view = renderElement(createElement(MemoCommentPreview, { memoId: 'memo-1', commentCount: 0 }))
    await flush()
    expect(view.container.querySelector('[data-memo-comments-preview]')).toBeNull()
    expect(api.comments.list).not.toHaveBeenCalled()
  })

  it('shows at most three comment rows and links them to the comment anchor', async () => {
    api.comments.list.mockResolvedValue({
      items: [
        comment('c1', 'first\nline'),
        comment('c2', '', 'second snippet'),
        comment('c3', 'third'),
        comment('c4', 'fourth'),
      ],
      nextCursor: null,
    })
    view = renderElement(createElement(MemoCommentPreview, { memoId: 'memo-1', commentCount: 4 }))
    await flush()

    expect(api.comments.list).toHaveBeenCalledWith('memo-1', { limit: 3 }, expect.any(AbortSignal))
    const rows = [...view.container.querySelectorAll<HTMLAnchorElement>('[data-memo-comments-preview] ul a')]
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.textContent)).toEqual(['first line', 'second snippet', 'third'])
    for (const row of rows) expect(row.getAttribute('href')).toBe('/memos/m/memo-1#memos-comments')
  })

  it('reports a failed load in one row and retries it in place', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    api.comments.list
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [comment('c1', 'back online')], nextCursor: null })
    view = renderElement(createElement(MemoCommentPreview, { memoId: 'memo-1', commentCount: 1 }))
    await flush()

    expect(view.container.textContent).toContain(t('memos.card.comments_preview_failed'))
    const retry = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes(t('memos.common.retry')))
    expect(retry).toBeDefined()
    act(() => {
      retry!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    })
    await flush()

    expect(api.comments.list).toHaveBeenCalledTimes(2)
    expect(view.container.textContent).toContain('back online')
    expect(view.container.textContent).not.toContain(t('memos.card.comments_preview_failed'))
    warn.mockRestore()
  })

  it('loads immediately when the browser has no IntersectionObserver', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    api.comments.list.mockResolvedValue({ items: [comment('c1', 'loaded at once')], nextCursor: null })
    view = renderStandalone(createElement(MemoCommentPreview, { memoId: 'memo-1', commentCount: 1 }))
    await flush()

    expect(api.comments.list).toHaveBeenCalledWith('memo-1', { limit: 3 }, expect.any(AbortSignal))
    expect(view.container.textContent).toContain('loaded at once')
  })

  it('reloads when the comment count changes and resets when the memo changes', async () => {
    api.comments.list.mockResolvedValue({ items: [comment('c1', 'first pass')], nextCursor: null })
    view = renderElement(createElement(MemoCommentPreview, { memoId: 'memo-1', commentCount: 1 }))
    await flush()
    expect(view.container.textContent).toContain('first pass')

    api.comments.list.mockResolvedValue({ items: [comment('c2', 'second pass')], nextCursor: null })
    view.rerender(createElement(MemoCommentPreview, { memoId: 'memo-1', commentCount: 2 }))
    await flush()
    expect(api.comments.list).toHaveBeenCalledTimes(2)
    expect(view.container.textContent).toContain('second pass')

    api.comments.list.mockResolvedValue({ items: [comment('c3', 'other memo')], nextCursor: null })
    view.rerender(createElement(MemoCommentPreview, { memoId: 'memo-2', commentCount: 1 }))
    await flush()
    expect(api.comments.list).toHaveBeenLastCalledWith('memo-2', { limit: 3 }, expect.any(AbortSignal))
    expect(view.container.textContent).toContain('other memo')
  })
})

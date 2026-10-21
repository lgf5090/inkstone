import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memo, MemoListResponse } from '@shared/memos/types'
import { ApiError } from '../../lib/api'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../lib/test-render'
import { MemosPublicApp } from './MemosPublicApp'
import type { MemoPublicView } from './public-route'

const api = vi.hoisted(() => ({
  publicMemos: {
    explore: vi.fn(),
    userMemos: vi.fn(),
    userMemo: vi.fn(),
    share: vi.fn(),
  },
}))

vi.mock('./api', () => ({ memosApi: api }))

function memo(overrides: Partial<Memo> = {}): Memo {
  return {
    id: 'memo-1',
    content: 'public body',
    title: '',
    snippet: '',
    tags: [],
    visibility: 'public',
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
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    creator: {
      id: 'user-1',
      login: 'alice',
      username: 'alice',
      name: 'Alice',
      avatarUrl: '',
      role: 'member',
      createdAt: 1_600_000_000,
    },
    ...overrides,
  }
}

function page(items: Memo[], nextCursor: string | null = null): MemoListResponse {
  return { items, nextCursor }
}

let view: RenderedElement | null = null

function render(route: MemoPublicView): HTMLElement {
  view = renderElement(createElement(MemosPublicApp, { route }))
  return view.container
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

function buttonByText(host: ParentNode, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(text))
  if (!found) throw new Error(`no button named ${text}`)
  return found
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('the public memo surface', () => {
  it('renders a shared memo with the token carried on its attachments', async () => {
    api.publicMemos.share.mockResolvedValue(memo({
      content: 'shared **body**',
      tags: ['work'],
      attachments: [
        {
          id: 'att-1',
          filename: 'photo.png',
          mime: 'image/png',
          size: 120,
          width: 10,
          height: 10,
          url: '/api/memos/files/att-1',
          thumbnailUrl: '/api/memos/files/att-1?thumb=1',
          motion: null,
          mediaMetadata: null,
          createdAt: 1,
        },
        {
          id: 'doc-1',
          filename: 'notes.pdf',
          mime: 'application/pdf',
          size: 240,
          width: null,
          height: null,
          url: '/api/memos/files/doc-1',
          thumbnailUrl: null,
          motion: null,
          mediaMetadata: null,
          createdAt: 1,
        },
      ],
    }))
    const host = render({ kind: 'share', token: 'tok-1' })
    await flush()

    expect(api.publicMemos.share).toHaveBeenCalledWith('tok-1', expect.any(AbortSignal))
    expect(host.textContent).toContain('shared')
    expect(host.textContent).toContain('body')
    expect(host.textContent).toContain('work')
    const image = host.querySelector('img')
    expect(image?.getAttribute('src')).toBe('/api/memos/files/att-1?thumb=1&share=tok-1')
    const documentLink = host.querySelector('a[href="/api/memos/files/doc-1?share=tok-1"]')
    expect(documentLink).not.toBeNull()
    expect(host.querySelector('[aria-haspopup="menu"]')).toBeNull()
    expect(host.querySelector('textarea')).toBeNull()
    expect(host.textContent).not.toContain(t('memos.card.actions'))
    expect(host.textContent).not.toContain(t('memos.comments.placeholder'))
  })

  it('shows the not-found state for a share that no longer resolves', async () => {
    api.publicMemos.share.mockRejectedValue(new ApiError(404, 'memo_share_not_found', 'Share not found'))
    const host = render({ kind: 'share', token: 'expired-token' })
    await flush()
    expect(host.textContent).toContain(t('memos.public.not_found_title'))
    expect(host.textContent).toContain(t('memos.public.not_found_description'))
    expect(host.textContent).not.toContain('expired-token')
  })

  it('renders a profile with its creator header and read-only cards', async () => {
    api.publicMemos.userMemos.mockResolvedValue(page([
      memo({ id: 'memo-a', content: 'first profile memo' }),
      memo({ id: 'memo-b', content: 'second profile memo' }),
    ]))
    const host = render({ kind: 'profile', username: 'alice' })
    await flush()

    expect(api.publicMemos.userMemos).toHaveBeenCalledWith('alice', {}, expect.any(AbortSignal))
    expect(host.textContent).toContain('Alice')
    expect(host.textContent).toContain(t('memos.public.handle', { username: 'alice' }))
    expect(host.textContent).toContain('first profile memo')
    expect(host.textContent).toContain('second profile memo')
    expect(host.querySelectorAll('[data-public-memo-id]')).toHaveLength(2)
    const open = [...host.querySelectorAll('a')].find((anchor) => anchor.textContent?.includes(t('memos.public.open_memo')))
    expect(open?.getAttribute('href')).toBe('/memos/u/alice/m/memo-a')
    expect(host.querySelector('[aria-haspopup="menu"]')).toBeNull()
    expect(host.querySelector('textarea')).toBeNull()
  })

  it('loads the next profile page from the cursor', async () => {
    api.publicMemos.userMemos
      .mockResolvedValueOnce(page([memo({ id: 'memo-a', content: 'first page' })], 'cursor-1'))
      .mockResolvedValueOnce(page([memo({ id: 'memo-b', content: 'second page' })], null))
    const host = render({ kind: 'profile', username: 'alice' })
    await flush()
    expect(api.publicMemos.userMemos).toHaveBeenCalledTimes(1)

    click(buttonByText(host, t('memos.public.load_more')))
    await flush()

    expect(api.publicMemos.userMemos).toHaveBeenCalledTimes(2)
    expect(api.publicMemos.userMemos.mock.calls[1]?.[1]).toEqual({ cursor: 'cursor-1' })
    expect(host.textContent).toContain('first page')
    expect(host.textContent).toContain('second page')
  })

  it('renders explore cards and its empty state', async () => {
    api.publicMemos.explore.mockResolvedValue(page([
      memo({ id: 'memo-a', content: 'explore one' }),
      memo({ id: 'memo-b', content: 'explore two' }),
    ]))
    const host = render({ kind: 'explore' })
    await flush()

    expect(api.publicMemos.explore).toHaveBeenCalledWith({}, expect.any(AbortSignal))
    expect(host.textContent).toContain(t('memos.public.explore_description'))
    expect(host.textContent).toContain('explore one')
    expect(host.textContent).toContain('explore two')
    expect(host.querySelectorAll('[data-public-memo-id]')).toHaveLength(2)
    expect(host.querySelector('[aria-haspopup="menu"]')).toBeNull()
    expect(host.querySelector('textarea')).toBeNull()

    act(() => { view?.unmount() })
    view = null
    document.body.innerHTML = ''
    api.publicMemos.explore.mockResolvedValue(page([]))
    const emptyHost = render({ kind: 'explore' })
    await flush()
    expect(emptyHost.textContent).toContain(t('memos.public.empty_title'))
  })

  it('renders a public memo by author and returns to the profile', async () => {
    api.publicMemos.userMemo.mockResolvedValue(memo({ id: 'memo-a', content: 'single public memo' }))
    const host = render({ kind: 'profileMemo', username: 'alice', id: 'memo-a' })
    await flush()

    expect(api.publicMemos.userMemo).toHaveBeenCalledWith('alice', 'memo-a', expect.any(AbortSignal))
    expect(host.textContent).toContain('single public memo')
    const back = [...host.querySelectorAll('a')].find((anchor) => anchor.textContent?.includes(t('memos.public.back_to_profile')))
    expect(back?.getAttribute('href')).toBe('/memos/u/alice')
    expect(host.querySelector('[aria-haspopup="menu"]')).toBeNull()
    expect(host.querySelector('textarea')).toBeNull()
  })

  it('offers a retry when the public request fails', async () => {
    api.publicMemos.explore
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page([memo({ content: 'recovered memo' })]))
    const host = render({ kind: 'explore' })
    await flush()
    expect(host.textContent).toContain(t('memos.public.error_title'))

    click(buttonByText(host, t('memos.common.retry')))
    await flush()
    expect(api.publicMemos.explore).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('recovered memo')
  })
})

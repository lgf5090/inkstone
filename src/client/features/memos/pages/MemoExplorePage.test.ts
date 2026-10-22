// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memo } from '@shared/memos/types'
import type { PublicUser } from '@shared/types'
import { initI18n, t } from '../../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../../lib/test-render'
import { MemoExplorePage } from './MemoExplorePage'

const api = vi.hoisted(() => ({
  publicMemos: {
    explore: vi.fn(),
    userMemos: vi.fn(),
    userMemo: vi.fn(),
    share: vi.fn(),
  },
}))

vi.mock('../api', () => ({ memosApi: api }))

const CREATOR: PublicUser = {
  id: 'user-1',
  login: 'alice',
  name: 'Alice',
  avatarUrl: '',
  role: 'member',
  createdAt: 1,
  username: 'alice',
}

function memo(id: string, content: string): Memo {
  return {
    id,
    content,
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
    creator: CREATOR,
    createdAt: 1,
    updatedAt: 1,
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
})

describe('the explore page', () => {
  it('loads public memos and appends the next page', async () => {
    api.publicMemos.explore
      .mockResolvedValueOnce({ items: [memo('memo-a', 'first public')], nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ items: [memo('memo-b', 'second public')], nextCursor: null })
    view = renderElement(createElement(MemoExplorePage))
    expect(view.container.textContent).toContain(t('memos.common.loading'))
    await flush()
    expect(view.container.textContent).toContain('first public')
    expect(view.container.textContent).toContain(t('memos.public.handle', { username: 'alice' }))
    expect(view.container.querySelector('a[href="/memos/u/alice/m/memo-a"]')).not.toBeNull()

    click(buttonByText(view.container, t('memos.public.load_more')))
    await flush()
    expect(api.publicMemos.explore).toHaveBeenLastCalledWith({ cursor: 'cursor-1' }, expect.any(AbortSignal))
    expect(view.container.textContent).toContain('second public')
  })

  it('shows the empty state', async () => {
    api.publicMemos.explore.mockResolvedValue({ items: [], nextCursor: null })
    view = renderElement(createElement(MemoExplorePage))
    await flush()
    expect(view.container.textContent).toContain(t('memos.public.empty_title'))
  })

  it('retries after a failed load', async () => {
    api.publicMemos.explore
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [memo('memo-a', 'back online')], nextCursor: null })
    view = renderElement(createElement(MemoExplorePage))
    await flush()
    expect(view.container.textContent).toContain(t('memos.public.error_title'))

    click(buttonByText(view.container, t('memos.common.retry')))
    await flush()
    expect(api.publicMemos.explore).toHaveBeenCalledTimes(2)
    expect(view.container.textContent).toContain('back online')
  })
})

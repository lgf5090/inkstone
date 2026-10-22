// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memo } from '@shared/memos/types'
import { ApiError } from '../../../lib/api'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { MemoParentLink } from './MemoParentLink'

const api = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('../api', () => ({ memosApi: api }))

function memo(overrides: Partial<Memo> = {}): Memo {
  return {
    id: 'parent-1',
    content: 'parent body',
    title: 'Parent title',
    snippet: 'Parent snippet',
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
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
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

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('the parent memo link', () => {
  it('loads the parent and opens it as a link', async () => {
    api.get.mockResolvedValue(memo())
    const onOpen = vi.fn()
    view = renderElement(createElement(MemoParentLink, { parentId: 'parent-1', onOpen }))
    await flush()

    expect(view.container.textContent).toContain(t('memos.parent.label'))
    expect(view.container.textContent).toContain('Parent title')
    const link = view.container.querySelector<HTMLAnchorElement>('a[href="/memos/m/parent-1"]')
    expect(link).not.toBeNull()
    click(link!)
    expect(onOpen).toHaveBeenCalledWith('parent-1')
  })

  it('reports a missing parent neutrally', async () => {
    api.get.mockRejectedValue(new ApiError(404, 'memo_not_found', 'Not found'))
    view = renderElement(createElement(MemoParentLink, { parentId: 'parent-1', onOpen: vi.fn() }))
    await flush()

    expect(view.container.textContent).toContain(t('memos.parent.unavailable'))
    expect(view.container.querySelector('[role="alert"]')).toBeNull()
  })

  it('retries a failed parent load', async () => {
    api.get
      .mockRejectedValueOnce(new ApiError(500, 'internal', 'The parent failed.'))
      .mockResolvedValueOnce(memo())
    view = renderElement(createElement(MemoParentLink, { parentId: 'parent-1', onOpen: vi.fn() }))
    await flush()

    expect(view.container.textContent).toContain('The parent failed.')
    const retry = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === t('memos.common.retry'))
    click(retry!)
    await flush()
    expect(view.container.textContent).toContain('Parent title')
  })
})

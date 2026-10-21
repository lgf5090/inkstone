// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memo } from '@shared/memos/types'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { useUi } from '../../../store/ui'
import { MEMO_QUERY_DEFAULTS, useMemos } from '../state'
import { MemoComments } from './MemoComments'
import { MemoComposer } from './MemoComposer'
import { MemoReactions } from './MemoReactions'

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

vi.mock('../api', () => ({ memosApi: api }))

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
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  }
}

let view: RenderedElement | null = null

function setFieldValue(field: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
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

beforeEach(async () => {
  await initI18n()
  useMemos.getState().reset()
  useMemos.setState({ items: [], status: 'ready', query: { ...MEMO_QUERY_DEFAULTS } })
  useUi.setState({ toasts: [] })
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('the memo composer', () => {
  it('creates a memo through the store', async () => {
    const saved = memo({ id: 'new-memo', content: 'hello' })
    api.create.mockResolvedValue(saved)
    const onSaved = vi.fn()
    view = renderElement(createElement(MemoComposer, { spaceId: 'space-1', onSaved }))
    const field = view.container.querySelector('textarea')
    expect(field).not.toBeNull()
    setFieldValue(field!, 'hello')
    const submit = [...view.container.querySelectorAll('button')].find((button) => button.textContent?.includes(t('memos.composer.save')))
    expect(submit).toBeDefined()
    click(submit!)
    await flush()
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ content: 'hello', visibility: 'private', spaceId: 'space-1' }))
    expect(onSaved).toHaveBeenCalledWith(saved)
    expect(view.container.querySelector('textarea')?.value).toBe('')
  })
})

describe('the comment section', () => {
  it('loads comments and posts a new one', async () => {
    api.comments.list.mockResolvedValue({
      items: [memo({ id: 'comment-1', content: 'first comment', parentId: 'memo-1' })],
      nextCursor: null,
    })
    api.comments.create.mockResolvedValue(memo({ id: 'comment-2', content: 'second comment', parentId: 'memo-1' }))
    view = renderElement(createElement(MemoComments, { memoId: 'memo-1', initialCount: 1 }))
    await flush()
    expect(view.container.textContent).toContain('first comment')
    const field = view.container.querySelector('textarea')
    setFieldValue(field!, 'second comment')
    const submit = [...view.container.querySelectorAll('button')].find((button) => button.textContent?.includes(t('memos.comments.submit')))
    click(submit!)
    await flush()
    expect(api.comments.create).toHaveBeenCalledWith('memo-1', { content: 'second comment' })
    expect(view.container.textContent).toContain('second comment')
    expect(view.container.textContent).toContain(t('memos.comments.count', { count: 2 }))
  })

  it('closes comments on an archived memo', async () => {
    api.comments.list.mockResolvedValue({ items: [], nextCursor: null })
    view = renderElement(createElement(MemoComments, { memoId: 'memo-1', initialCount: 0, disabled: true }))
    await flush()
    expect(view.container.querySelector('textarea')).toBeNull()
    expect(view.container.textContent).toContain(t('memos.comments.disabled'))
  })
})

describe('the reaction bar', () => {
  it('upserts a reaction through the api', async () => {
    const item = memo({ reactions: [{ type: '👍', count: 1, reacted: false }] })
    api.reactions.upsert.mockResolvedValue({ reactions: [{ type: '👍', count: 2, reacted: true }] })
    view = renderElement(createElement(MemoReactions, { memo: item }))
    const chip = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.getAttribute('aria-label') === t('memos.reactions.react_with', { emoji: '👍' }))
    expect(chip).not.toBeNull()
    click(chip!)
    await flush()
    expect(api.reactions.upsert).toHaveBeenCalledWith(item.id, { type: '👍' })
    expect(chip!.getAttribute('aria-pressed')).toBe('true')
    expect(chip!.textContent).toContain('2')
  })

  it('draws reactions read-only on an archived memo', () => {
    const item = memo({ state: 'archived', reactions: [{ type: '👍', count: 3, reacted: true }] })
    view = renderElement(createElement(MemoReactions, { memo: item, readOnly: true }))
    expect(view.container.querySelector(`button[aria-label="${t('memos.reactions.add')}"]`)).toBeNull()
    expect(view.container.textContent).toContain('3')
  })
})

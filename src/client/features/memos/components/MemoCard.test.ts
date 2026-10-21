// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memo } from '@shared/memos/types'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { useUi } from '../../../store/ui'
import { MEMO_QUERY_DEFAULTS, useMemos } from '../state'
import { MemoCard } from './MemoCard'

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

interface CardProps {
  memo: Memo
  editing?: boolean
  onOpen?: (id: string) => void
  onStartEdit?: () => void
  onEndEdit?: () => void
  onTagPress?: (tag: string) => void
}

let view: RenderedElement | null = null

function render(props: CardProps): RenderedElement {
  view = renderElement(createElement(MemoCard, {
    spaceName: null,
    isNew: false,
    compact: false,
    timeBasis: 'created',
    onOpen: () => {},
    onStartEdit: () => {},
    onEndEdit: () => {},
    onTagPress: () => {},
    ...props,
    editing: props.editing ?? false,
  }))
  return view
}

function menuTrigger(): HTMLButtonElement {
  const trigger = document.querySelector<HTMLButtonElement>(`button[aria-label="${t('memos.card.actions')}"]`)
  if (!trigger) throw new Error('no memo actions trigger')
  return trigger
}

function menuItem(text: string): HTMLButtonElement {
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent?.includes(text))
  if (!item) throw new Error(`no menu item ${text}`)
  return item
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
  useMemos.setState({ items: [memo()], status: 'ready', query: { ...MEMO_QUERY_DEFAULTS } })
  useUi.setState({ toasts: [] })
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
})

describe('the memo card', () => {
  it('renders the sanitized body, its tags and its comment count', () => {
    const item = memo({ content: '# hello\n\n<script>alert(1)</script>', tags: ['work'], commentCount: 3 })
    const rendered = render({ memo: item })
    expect(rendered.container.textContent).toContain('hello')
    expect(rendered.container.querySelector('script')).toBeNull()
    const comment = rendered.container.querySelector(`a[aria-label="${t('memos.card.comments', { count: 3 })}"]`)
    expect(comment).not.toBeNull()
  })

  it('reports a tag press to the caller', () => {
    const pressed: string[] = []
    render({ memo: memo({ tags: ['work'] }), onTagPress: (tag) => pressed.push(tag) })
    const chip = document.querySelector<HTMLButtonElement>(`button[aria-label="${t('memos.card.filter_tag', { tag: 'work' })}"]`)
    expect(chip).not.toBeNull()
    click(chip!)
    expect(pressed).toEqual(['work'])
  })

  it('pins through the store', async () => {
    const item = memo()
    api.patch.mockResolvedValue({ ...item, pinned: true, rev: 2 })
    render({ memo: item })
    click(menuTrigger())
    click(menuItem(t('memos.card.pin')))
    await flush()
    expect(api.patch).toHaveBeenCalledWith(item.id, { rev: 1, pinned: true })
    expect(useMemos.getState().items[0]?.pinned).toBe(true)
  })

  it('copies the memo link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render({ memo: memo({ id: 'memo-copy' }) })
    click(menuTrigger())
    click(menuItem(t('memos.card.copy_link')))
    await flush()
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/memos/m/memo-copy`)
    expect(useUi.getState().toasts.some((toast) => toast.title === t('memos.card.link_copied'))).toBe(true)
  })

  it('offers restore instead of edit on an archived memo', async () => {
    const item = memo({ state: 'archived' })
    api.restore.mockResolvedValue({ ...item, state: 'normal', rev: 2 })
    render({ memo: item })
    click(menuTrigger())
    expect(document.body.textContent).not.toContain(t('memos.card.edit'))
    expect(document.body.textContent).toContain(t('memos.card.restore'))
    click(menuItem(t('memos.card.restore')))
    await flush()
    expect(api.restore).toHaveBeenCalledWith(item.id)
  })

  it('opens the basic editor in place', () => {
    const rendered = render({ memo: memo({ content: 'edit me' }), editing: true })
    const field = rendered.container.querySelector('textarea')
    expect(field?.value).toBe('edit me')
    expect(rendered.container.textContent).toContain(t('memos.composer.save'))
  })
})

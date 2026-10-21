// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memo, MemoTagRule } from '@shared/memos/types'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { useUi } from '../../../store/ui'
import { MEMO_QUERY_DEFAULTS, useMemos } from '../state'
import { MemoBody } from './MemoBody'
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
  shares: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
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
  tagRules?: readonly MemoTagRule[]
  reactionOptions?: readonly string[]
  doubleClickEdit?: boolean
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
  localStorage.clear()
  useMemos.getState().reset()
  useMemos.setState({ items: [memo()], status: 'ready', query: { ...MEMO_QUERY_DEFAULTS } })
  useUi.setState({ toasts: [] })
  vi.clearAllMocks()
  api.spaces.list.mockResolvedValue({ spaces: [] })
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

  it('opens the share dialog from the actions menu', async () => {
    api.shares.list.mockResolvedValue({ shares: [] })
    render({ memo: memo({ id: 'memo-share' }) })
    click(menuTrigger())
    click(menuItem(t('memos.share.card_action')))
    await flush()
    expect(api.shares.list).toHaveBeenCalledWith('memo-share', expect.any(AbortSignal))
    expect(document.body.textContent).toContain(t('memos.share.title'))
  })

  it('offers restore instead of edit on an archived memo', async () => {
    const item = memo({ state: 'archived' })
    api.restore.mockResolvedValue({ ...item, state: 'normal', rev: 2 })
    render({ memo: item })
    click(menuTrigger())
    expect(document.body.textContent).not.toContain(t('memos.card.edit'))
    expect(document.body.textContent).not.toContain(t('memos.share.card_action'))
    expect(document.body.textContent).toContain(t('memos.card.restore'))
    click(menuItem(t('memos.card.restore')))
    await flush()
    expect(api.restore).toHaveBeenCalledWith(item.id)
  })

  it('ticks a task through the store', async () => {
    const item = memo({ content: '- [ ] ship it' })
    api.patch.mockResolvedValue({ ...item, content: '- [x] ship it', rev: 2 })
    const rendered = render({ memo: item })
    const checkbox = rendered.container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(checkbox).not.toBeNull()
    expect(checkbox?.disabled).toBe(false)
    click(checkbox!)
    await flush()
    expect(api.patch).toHaveBeenCalledWith('memo-1', { rev: 1, content: '- [x] ship it' })
    expect(useMemos.getState().items[0]?.content).toBe('- [x] ship it')
  })

  it('reports a failed task tick and keeps the stored content', async () => {
    const item = memo({ content: '- [ ] ship it' })
    useMemos.setState({ items: [item] })
    api.patch.mockRejectedValue(new Error('offline'))
    const rendered = render({ memo: item })
    click(rendered.container.querySelector('input[type="checkbox"]')!)
    await flush()
    expect(useMemos.getState().items[0]?.content).toBe('- [ ] ship it')
    expect(useUi.getState().toasts.some((toast) => toast.title === t('memos.card.task_failed'))).toBe(true)
  })

  it('links mentions and leaves code alone', () => {
    const rendered = render({
      memo: memo({ content: 'Hi @alice\n\n`@bob`\n\n```\n@carol\n```' }),
    })
    const links = [...rendered.container.querySelectorAll<HTMLAnchorElement>('a[data-mention]')]
    expect(links.map((anchor) => anchor.dataset.mention)).toEqual(['alice'])
    expect(links[0]?.getAttribute('href')).toBe('/memos/u/alice')
  })

  it('keeps tasks read-only when no toggle handler is passed', () => {
    const rendered = renderElement(createElement(MemoBody, { content: '- [ ] ship it' }))
    view = rendered
    expect(rendered.container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true)
  })

  it('opens the basic editor in place', async () => {
    const rendered = render({ memo: memo({ content: 'edit me' }), editing: true })
    await flush()
    const editor = rendered.container.querySelector('.cm-content')
    expect(editor?.textContent).toBe('edit me')
    expect(rendered.container.textContent).toContain(t('memos.composer.save'))
  })

  it('colors matching tag chips and blurs content until it is revealed', () => {
    const item = memo({ content: 'the secret #secret', tags: ['secret'] })
    const rule: MemoTagRule = {
      pattern: 'secret',
      mode: 'exact',
      backgroundColor: '#ff0000',
      blurContent: true,
    }
    const rendered = render({ memo: item, tagRules: [rule] })
    const chip = rendered.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('memos.card.filter_tag', { tag: 'secret' })}"]`,
    )
    expect(chip).not.toBeNull()
    expect((chip!.querySelector('span') as HTMLElement | null)?.style.backgroundColor).toBe('rgb(255, 0, 0)')
    const body = rendered.container.querySelector('[data-memo-blurred="true"]')
    expect(body).not.toBeNull()
    const hidden = body!.querySelector('[data-memo-mask="hidden"]')
    expect(hidden).not.toBeNull()
    expect(hidden?.getAttribute('aria-hidden')).toBe('true')
    expect(hidden?.hasAttribute('inert')).toBe(true)
    const inlineDot = rendered.container.querySelector('[data-memo-tag-dot]')
    expect(inlineDot).not.toBeNull()
    expect((inlineDot as HTMLElement).style.backgroundColor).toBe('rgb(255, 0, 0)')

    const reveal = [...rendered.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes(t('memos.blur.reveal')))
    expect(reveal).not.toBeUndefined()
    click(reveal!)
    expect(rendered.container.querySelector('[data-memo-mask="hidden"]')).toBeNull()
    expect(rendered.container.querySelector('[data-memo-mask="revealed"]')?.hasAttribute('aria-hidden')).toBe(false)
  })

  it('starts editing on a double click only when the preference allows it', () => {
    const starts: number[] = []
    const rendered = render({ memo: memo(), onStartEdit: () => starts.push(1) })
    const article = rendered.container.querySelector('article')!
    expect(article).not.toBeNull()
    act(() => {
      article.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    })
    expect(starts).toEqual([])

    rendered.rerender(createElement(MemoCard, {
      memo: memo(),
      spaceName: null,
      isNew: false,
      compact: false,
      timeBasis: 'created',
      editing: false,
      doubleClickEdit: true,
      onOpen: () => {},
      onStartEdit: () => starts.push(1),
      onEndEdit: () => {},
      onTagPress: () => {},
    }))
    act(() => {
      rendered.container.querySelector('article')!.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
      )
    })
    expect(starts).toEqual([1])

    act(() => {
      menuTrigger().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    })
    expect(starts).toEqual([1])
  })

  it('offers the configured reactions in the picker', () => {
    const rendered = render({ memo: memo(), reactionOptions: ['🔥'] })
    const add = rendered.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('memos.reactions.add')}"]`,
    )
    expect(add).not.toBeNull()
    click(add!)
    const labels = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .map((item) => item.textContent ?? '')
    expect(labels.some((label) => label.includes(t('memos.reactions.react_with', { emoji: '🔥' })))).toBe(true)
    expect(labels.some((label) => label.includes(t('memos.reactions.react_with', { emoji: '👍' })))).toBe(false)
  })
})

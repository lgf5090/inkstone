// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memo, MemoRelation } from '@shared/memos/types'
import { ApiError } from '../../../lib/api'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { ConfirmHost } from '../../../components/overlay'
import { MemoRelations } from './MemoRelations'

const api = vi.hoisted(() => ({
  list: vi.fn(),
  relations: { get: vi.fn(), put: vi.fn() },
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

function relation(relatedMemoId: string, snippet: string): MemoRelation {
  return { memoId: 'memo-1', relatedMemoId, relatedSnippet: snippet, createdAt: 100 }
}

let view: RenderedElement | null = null

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

async function flush(delay = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, delay))
  })
}

function buttonNamed(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === text)
  if (!found) throw new Error(`no button named ${text}`)
  return found
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]')
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('the memo relations section', () => {
  it('adds a relation chosen in the picker and hides the memo itself', async () => {
    api.relations.get.mockResolvedValue({
      outgoing: [relation('m-4', 'Existing reference')],
      incoming: [],
    })
    api.list.mockResolvedValue({
      items: [
        memo({ id: 'm-2', title: 'Second memo', snippet: 'A candidate' }),
        memo({ id: 'memo-1', title: 'This memo' }),
        memo({ id: 'm-4', title: 'Existing reference' }),
      ],
      nextCursor: null,
    })
    const added = relation('m-2', 'Second memo')
    api.relations.put.mockResolvedValue({
      outgoing: [relation('m-4', 'Existing reference'), added],
      incoming: [],
    })
    view = renderElement(createElement(MemoRelations, { memo: memo(), onOpen: vi.fn() }))
    await flush()

    click(buttonNamed(t('memos.relations.add')))
    await flush(300)
    const panel = dialog()
    expect(panel).not.toBeNull()
    expect(panel!.textContent).toContain('Second memo')
    expect(panel!.textContent).not.toContain('This memo')
    expect(panel!.textContent).not.toContain('Existing reference')

    const checkbox = [...panel!.querySelectorAll<HTMLElement>('[role="checkbox"]')]
      .find((candidate) => candidate.textContent?.includes('Second memo'))
    expect(checkbox).not.toBeNull()
    click(checkbox!)
    click(buttonNamed(t('memos.common.save')))
    await flush()

    expect(api.relations.put).toHaveBeenCalledWith('memo-1', ['m-4', 'm-2'])
    expect(dialog()).toBeNull()
    expect(view.container.textContent).toContain('Second memo')
  })

  it('removes an outgoing relation after confirmation', async () => {
    api.relations.get.mockResolvedValue({
      outgoing: [relation('m-4', 'Old reference')],
      incoming: [],
    })
    api.relations.put.mockResolvedValue({ outgoing: [], incoming: [] })
    view = renderElement(createElement('div', null,
      createElement(MemoRelations, { memo: memo(), onOpen: vi.fn() }),
      createElement(ConfirmHost),
    ))
    await flush()

    const remove = view.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('memos.relations.remove', { name: 'Old reference' })}"]`,
    )
    expect(remove).not.toBeNull()
    click(remove!)
    await flush()
    click(buttonNamed(t('memos.relations.remove_confirm')))
    await flush()

    expect(api.relations.put).toHaveBeenCalledWith('memo-1', [])
    expect(view.container.textContent).not.toContain('Old reference')
  })

  it('keeps incoming references read-only and explains an empty search', async () => {
    api.relations.get.mockResolvedValue({
      outgoing: [],
      incoming: [relation('m-9', 'Referenced by memo')],
    })
    api.list.mockResolvedValue({ items: [], nextCursor: null })
    view = renderElement(createElement(MemoRelations, { memo: memo(), onOpen: vi.fn() }))
    await flush()

    expect(view.container.textContent).toContain('Referenced by memo')
    expect(view.container.querySelector('button[aria-label*="Referenced by memo"]')).toBeNull()

    click(buttonNamed(t('memos.relations.add')))
    const search = dialog()!.querySelector<HTMLInputElement>('input[type="search"]')
    expect(search).not.toBeNull()
    setInputValue(search!, 'nothing')
    await flush(300)
    expect(dialog()!.textContent).toContain(t('memos.relations.no_results'))
  })

  it('reports a failed save and keeps the picker open', async () => {
    api.relations.get.mockResolvedValue({ outgoing: [], incoming: [] })
    api.list.mockResolvedValue({
      items: [memo({ id: 'm-2', title: 'Second memo' })],
      nextCursor: null,
    })
    api.relations.put.mockRejectedValue(new ApiError(500, 'internal', 'The server refused.'))
    view = renderElement(createElement(MemoRelations, { memo: memo(), onOpen: vi.fn() }))
    await flush()

    click(buttonNamed(t('memos.relations.add')))
    await flush(300)
    const panel = dialog()!
    const checkbox = panel.querySelector<HTMLElement>('[role="checkbox"]')
    click(checkbox!)
    click(buttonNamed(t('memos.common.save')))
    await flush()

    expect(dialog()).not.toBeNull()
    expect(dialog()!.textContent).toContain('The server refused.')
  })

  it('opens a referenced memo', async () => {
    api.relations.get.mockResolvedValue({
      outgoing: [relation('m-4', 'Existing reference')],
      incoming: [],
    })
    const onOpen = vi.fn()
    view = renderElement(createElement(MemoRelations, { memo: memo(), onOpen }))
    await flush()

    const row = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Existing reference'))
    click(row!)
    expect(onOpen).toHaveBeenCalledWith('m-4')
  })
})

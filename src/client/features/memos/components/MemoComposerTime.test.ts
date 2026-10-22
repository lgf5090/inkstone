// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memo, MemoLocation } from '@shared/memos/types'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { useUi } from '../../../store/ui'
import { MEMO_QUERY_DEFAULTS, saveMemoDraft, useMemos } from '../state'
import { MemoComposer, memoComposerDraftScope } from './MemoComposer'

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

const BASE = Math.floor(new Date(2026, 0, 15, 12, 0, 0).getTime() / 1000)

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
    createdAt: BASE,
    updatedAt: BASE,
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

function buttonNamed(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === text)
  if (!found) throw new Error(`no button named ${text}`)
  return found
}

function buttonLabelled(container: HTMLElement, label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!found) throw new Error(`no button labelled ${label}`)
  return found
}

function timeFieldTrigger(container: HTMLElement, index: number): HTMLButtonElement {
  const fields = container.querySelectorAll<HTMLSpanElement>('span.w-24')
  const trigger = fields[index]?.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')
  if (!trigger) throw new Error(`no time field ${index}`)
  return trigger
}

function spin(trigger: HTMLButtonElement, direction: 'increase' | 'decrease', unit: string): void {
  const panel = trigger.parentElement?.querySelector<HTMLElement>('[role="dialog"]')
  const label = t(direction === 'increase' ? 'common.time_increase' : 'common.time_decrease', { unit })
  const button = panel?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!button) throw new Error(`no ${label} control`)
  click(button)
}

function openTimeEditor(container: HTMLElement): void {
  click(buttonLabelled(container, t('memos.composer.edit_time')))
}

beforeEach(async () => {
  await initI18n()
  localStorage.clear()
  useMemos.getState().reset()
  useMemos.setState({ items: [], status: 'ready', query: { ...MEMO_QUERY_DEFAULTS } })
  useUi.setState({ toasts: [] })
  vi.clearAllMocks()
  api.spaces.list.mockResolvedValue({ spaces: [] })
  api.preferences.get.mockResolvedValue({
    defaultVisibility: 'private',
    enableDoubleClickEdit: true,
    saveMediaMetadata: true,
    reactions: [],
    tagRules: [],
    enableLinkPreview: true,
    enableReverseGeocoding: false,
    transcriptionProviderId: null,
    transcriptionModel: null,
    transcriptionLanguage: '',
    transcriptionPrompt: '',
  })
  api.create.mockResolvedValue(memo({ id: 'new-memo', content: 'hello' }))
  api.patch.mockResolvedValue(memo())
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('the memo composer times', () => {
  it('creates a memo with both times, syncing updatedAt until it is edited directly', async () => {
    saveMemoDraft('guest', memoComposerDraftScope(null), { content: 'hello', visibility: 'private' })
    view = renderElement(createElement(MemoComposer, { initialCreatedAt: BASE }))
    await flush()

    openTimeEditor(view.container)
    const created = timeFieldTrigger(view.container, 0)
    click(created)
    spin(created, 'increase', t('common.time_hour'))
    click(created)

    const updated = timeFieldTrigger(view.container, 1)
    click(updated)
    spin(updated, 'increase', t('common.time_minute'))
    click(updated)

    click(created)
    spin(created, 'increase', t('common.time_hour'))
    click(created)

    click(buttonNamed(t('memos.composer.save')))
    await flush()

    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({
      content: 'hello',
      createdAt: BASE + 2 * 3600,
      updatedAt: BASE + 3600 + 60,
    }))
  })

  it('patches an edited memo updatedAt without touching createdAt', async () => {
    view = renderElement(createElement(MemoComposer, { memo: memo() }))
    await flush()

    openTimeEditor(view.container)
    const updated = timeFieldTrigger(view.container, 1)
    click(updated)
    spin(updated, 'increase', t('common.time_hour'))
    click(updated)
    click(buttonNamed(t('memos.composer.save')))
    await flush()

    expect(api.patch).toHaveBeenCalledWith('memo-1', expect.objectContaining({
      rev: 1,
      content: 'first memo',
      updatedAt: BASE + 3600,
    }))
    const input = api.patch.mock.calls[0]![1] as Record<string, unknown>
    expect(input).not.toHaveProperty('createdAt')
  })

  it('does not sync updatedAt when editing an existing memo createdAt', async () => {
    view = renderElement(createElement(MemoComposer, { memo: memo() }))
    await flush()

    openTimeEditor(view.container)
    const created = timeFieldTrigger(view.container, 0)
    click(created)
    spin(created, 'increase', t('common.time_hour'))
    click(created)
    click(buttonNamed(t('memos.composer.save')))
    await flush()

    expect(api.patch).toHaveBeenCalledWith('memo-1', expect.objectContaining({
      rev: 1,
      createdAt: BASE + 3600,
    }))
    const input = api.patch.mock.calls[0]![1] as Record<string, unknown>
    expect(input).not.toHaveProperty('updatedAt')
  })

  it('prefers initialLocation over the restored draft location', async () => {
    const draftLocation: MemoLocation = { placeholder: 'Draft place', latitude: 1, longitude: 2 }
    const initialLocation: MemoLocation = { placeholder: 'Map place', latitude: 3, longitude: 4 }
    saveMemoDraft('guest', memoComposerDraftScope(null), {
      content: 'hello',
      visibility: 'private',
      location: draftLocation,
    })
    view = renderElement(createElement(MemoComposer, { initialLocation }))
    await flush()

    click(buttonNamed(t('memos.composer.save')))
    await flush()

    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({
      content: 'hello',
      location: initialLocation,
    }))
  })
})

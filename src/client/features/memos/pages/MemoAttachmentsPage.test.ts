// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MEMO_MAX_PAGE_SIZE } from '@shared/memos/constants'
import type { MemoAttachment } from '@shared/memos/types'
import { ConfirmHost } from '../../../components/overlay'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { useUi } from '../../../store/ui'
import type { MemoAttachmentQuery } from '../api'
import type { MemoAttachmentWithSource } from '../attachment-groups'
import { MemoAttachmentsPage } from './MemoAttachmentsPage'

const api = vi.hoisted(() => ({
  attachments: {
    list: vi.fn(),
    delete: vi.fn(),
    batchDelete: vi.fn(),
    prune: vi.fn(),
  },
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, memosApi: api }
})

const MAY = Math.floor(new Date(2024, 4, 12, 12).getTime() / 1000)
const APRIL = Math.floor(new Date(2024, 3, 4, 12).getTime() / 1000)
const SOURCE_MEMO = { id: 'memo-1', title: 'May trip', snippet: '' }

function attachment(id: string, overrides: Partial<MemoAttachmentWithSource> = {}): MemoAttachmentWithSource {
  return {
    id,
    filename: `${id}.jpg`,
    mime: 'image/jpeg',
    size: 1000,
    width: 1200,
    height: 800,
    url: `/api/memos/files/${id}`,
    thumbnailUrl: null,
    motion: null,
    mediaMetadata: null,
    createdAt: MAY,
    memoId: 'memo-1',
    memo: SOURCE_MEMO,
    ...overrides,
  }
}

const BASE_ITEMS: MemoAttachmentWithSource[] = [
  attachment('photo-may', { size: 1000 }),
  attachment('voice-may', { filename: 'voice-may.mp3', mime: 'audio/mpeg', size: 2000 }),
  attachment('notes-april', {
    filename: 'notes-april.pdf',
    mime: 'application/pdf',
    size: 3000,
    createdAt: APRIL,
  }),
  attachment('unused-may', {
    filename: 'unused-may.jpg',
    size: 4000,
    memoId: null,
    memo: null,
  }),
  attachment('unused-april', {
    filename: 'unused-april.png',
    mime: 'image/png',
    size: 5000,
    createdAt: APRIL,
    memoId: null,
    memo: null,
  }),
]

const SPACE_ITEMS: Record<string, MemoAttachmentWithSource[]> = {
  'space-1': [
    attachment('space-one-photo', { size: 1000 }),
    attachment('space-one-voice', { filename: 'space-one-voice.mp3', mime: 'audio/mpeg', size: 2000 }),
  ],
  'space-2': [
    attachment('space-two-doc', { filename: 'space-two-doc.pdf', mime: 'application/pdf', size: 3000 }),
  ],
}

let items: MemoAttachmentWithSource[] = []
let spaceItems: Record<string, MemoAttachmentWithSource[]> = {}
let deleted: Set<string> = new Set()
let view: RenderedElement | null = null

function scopeItems(scope: string | undefined, spaceId?: string | null): MemoAttachment[] {
  const source = spaceId ? spaceItems[spaceId] ?? [] : items
  const visible = source.filter((item) => !deleted.has(item.id))
  if (!scope || scope === 'all') return visible
  if (scope === 'media') {
    return visible.filter((item) => item.mime.startsWith('image/') || item.mime.startsWith('video/'))
  }
  if (scope === 'audio') return visible.filter((item) => item.mime.startsWith('audio/'))
  if (scope === 'documents') {
    return visible.filter((item) => (
      !item.mime.startsWith('image/')
      && !item.mime.startsWith('video/')
      && !item.mime.startsWith('audio/')
    ))
  }
  if (scope === 'unused') return visible.filter((item) => item.memoId === null)
  return visible
}

function renderPage(props: { onOpenMemo?: (id: string) => void } = {}): RenderedElement {
  view = renderElement(createElement(
    Fragment,
    null,
    createElement(MemoAttachmentsPage, props),
    createElement(ConfirmHost),
  ))
  return view
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function setUrl(path: string): void {
  window.history.replaceState(null, '', path)
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

function press(key: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

function radio(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    .find((candidate) => candidate.textContent?.trim().startsWith(label))
  if (!button) throw new Error(`no scope ${label}`)
  return button
}

function buttonWithText(text: string, root: ParentNode = document): HTMLButtonElement {
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.includes(text))
  if (!button) throw new Error(`no button containing ${text}`)
  return button
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]')
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  setUrl('/memos/attachments')
  useUi.setState({ toasts: [] })
  vi.clearAllMocks()
  items = BASE_ITEMS.map((item) => ({ ...item }))
  spaceItems = {}
  for (const [spaceId, entries] of Object.entries(SPACE_ITEMS)) {
    spaceItems[spaceId] = entries.map((item) => ({ ...item }))
  }
  deleted = new Set()
  api.attachments.list.mockImplementation((query: MemoAttachmentQuery = {}) => Promise.resolve({
    items: scopeItems(query.scope, query.spaceId),
    nextCursor: null,
  }))
  api.attachments.delete.mockImplementation(async (id: string) => {
    deleted.add(id)
    return { ok: true }
  })
  api.attachments.prune.mockImplementation(async () => {
    const removed = items.filter((item) => item.memoId === null)
    items = items.filter((item) => item.memoId !== null)
    return {
      removed: removed.length,
      freedBytes: removed.reduce((sum, item) => sum + item.size, 0),
    }
  })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  setUrl('/memos/attachments')
})

describe('the attachment library', () => {
  it('shows a count for each scope and the account-wide usage', async () => {
    renderPage()
    await flush()
    expect(radio('All').textContent).toContain('5')
    expect(radio('Media').textContent).toContain('3')
    expect(radio('Audio').textContent).toContain('1')
    expect(radio('Documents').textContent).toContain('1')
    expect(radio('Unused').textContent).toContain('2')
    expect(document.querySelector('h2')?.parentElement?.textContent).toContain(
      t('memos.attachments.library.usage', { count: 5, size: '14.6 KB' }),
    )
  })

  it('groups media by month, links the source memo and previews images as a carousel', async () => {
    const opened: string[] = []
    const rendered = renderPage({ onOpenMemo: (id) => opened.push(id) })
    await flush()

    const months = [...rendered.container.querySelectorAll<HTMLElement>('[data-attachment-month]')]
    expect(months.map((month) => month.getAttribute('data-attachment-month'))).toEqual(['2024-05', '2024-04'])
    expect(months[0]?.textContent).toContain('voice-may.mp3')
    expect(months[1]?.textContent).toContain('notes-april.pdf')

    const source = rendered.container.querySelector<HTMLAnchorElement>('a[href="/memos/m/memo-1"]')
    expect(source).not.toBeNull()
    expect(source?.textContent).toContain(t('memos.attachments.library.source_memo', { title: 'May trip' }))
    click(source!)
    expect(opened).toEqual(['memo-1'])

    const photo = rendered.container.querySelector<HTMLButtonElement>('button[aria-label="Open image photo-may.jpg"]')
    expect(photo).not.toBeNull()
    click(photo!)
    expect(dialog()?.textContent).toContain(t('memos.media.counter', { index: 1, total: 3 }))
    press('ArrowRight')
    expect(dialog()?.textContent).toContain(t('memos.media.counter', { index: 2, total: 3 }))
    expect(dialog()?.textContent).toContain('unused-may.jpg')
    press('Escape')
    expect(dialog()).toBeNull()
  })

  it('switches scopes through the URL and filters the list', async () => {
    renderPage()
    await flush()
    click(radio('Documents'))
    await flush()
    expect(window.location.search).toBe('?scope=documents')
    expect(document.body.textContent).toContain('notes-april.pdf')
    expect(document.body.textContent).not.toContain('photo-may.jpg')
    expect(api.attachments.list).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'documents' }),
      expect.anything(),
    )
  })

  it('warns about unused attachments and deletes them only after confirmation', async () => {
    setUrl('/memos/attachments?scope=unused')
    renderPage()
    await flush()
    expect(document.body.textContent).toContain(
      t('memos.attachments.library.unused_warning', { size: '8.8 KB' }),
    )
    const prune = buttonWithText(t('memos.attachments.library.prune'))

    click(prune)
    await flush()
    const firstDialog = dialog()
    expect(firstDialog).not.toBeNull()
    expect(firstDialog?.textContent).toContain(t('memos.attachments.library.prune_confirm_title'))
    click(buttonWithText(t('common.cancel'), firstDialog!))
    await flush()
    expect(api.attachments.prune).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()

    click(prune)
    await flush()
    const secondDialog = dialog()
    expect(secondDialog).not.toBeNull()
    click(buttonWithText(t('memos.attachments.library.prune_confirm_label'), secondDialog!))
    await flush()
    expect(api.attachments.prune).toHaveBeenCalledTimes(1)
    expect(useUi.getState().toasts[0]?.title).toBe(t('memos.attachments.library.pruned'))
    expect(document.body.textContent).not.toContain('unused-may.jpg')
  })

  it('deletes a single attachment after confirmation', async () => {
    renderPage()
    await flush()
    const remove = document.querySelector<HTMLButtonElement>('button[aria-label="Delete photo-may.jpg"]')
    expect(remove).not.toBeNull()
    click(remove!)
    await flush()
    const panel = dialog()
    expect(panel).not.toBeNull()
    expect(panel?.textContent).toContain(t('memos.attachments.library.delete_confirm_title', { name: 'photo-may.jpg' }))
    click(buttonWithText(t('memos.attachments.library.delete_action'), panel!))
    await flush()
    expect(api.attachments.delete).toHaveBeenCalledWith('photo-may')
    expect(useUi.getState().toasts[0]?.title).toBe(t('memos.attachments.library.deleted'))
    expect(document.body.textContent).not.toContain('photo-may.jpg')
  })

  it('loads the next page when the cursor is present', async () => {
    api.attachments.list.mockImplementation((query: MemoAttachmentQuery = {}) => {
      if (!query.scope) {
        return Promise.resolve({ items: scopeItems('all'), nextCursor: null })
      }
      if (query.cursor === 'next-page') {
        return Promise.resolve({ items: scopeItems('all').slice(2), nextCursor: null })
      }
      return Promise.resolve({ items: scopeItems('all').slice(0, 2), nextCursor: 'next-page' })
    })
    renderPage()
    await flush()
    expect(document.body.textContent).not.toContain('notes-april.pdf')
    const more = buttonWithText(t('memos.feed.load_more'))
    click(more)
    await flush()
    expect(api.attachments.list).toHaveBeenCalledWith({
      scope: 'all',
      spaceId: null,
      cursor: 'next-page',
      limit: 24,
    })
    expect(document.body.textContent).toContain('notes-april.pdf')
    expect(document.body.textContent).not.toContain(t('memos.feed.load_more'))
  })

  it('renders a scope-specific empty state', async () => {
    setUrl('/memos/attachments?scope=audio')
    api.attachments.list.mockImplementation(() => Promise.resolve({
      items: [],
      nextCursor: null,
    }))
    renderPage()
    await flush()
    expect(document.body.textContent).toContain(t('memos.attachments.library.empty_audio_title'))
    expect(document.body.textContent).toContain(t('memos.attachments.library.empty_audio_description'))
  })

  it('renders an error with a retry, and keeps the counts failure separate', async () => {
    api.attachments.list.mockImplementation((query: MemoAttachmentQuery = {}) => (
      query.scope
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ items: [], nextCursor: null })
    ))
    renderPage()
    await flush()
    expect(document.body.textContent).toContain(t('memos.attachments.library.error_title'))
    expect(buttonWithText(t('memos.common.retry'))).not.toBeNull()

    api.attachments.list.mockImplementation((query: MemoAttachmentQuery = {}) => (
      query.scope
        ? Promise.resolve({ items: [], nextCursor: null })
        : Promise.reject(new Error('offline'))
    ))
    act(() => { view?.unmount() })
    view = null
    document.body.innerHTML = ''
    renderPage()
    await flush()
    expect(document.body.textContent).toContain(t('memos.attachments.library.counts_failed'))
    expect(buttonWithText(t('memos.common.retry'))).not.toBeNull()
  })

  it('shows the loading state while the first page is in flight', () => {
    api.attachments.list.mockReturnValue(new Promise(() => {}))
    renderPage()
    expect(document.body.textContent).toContain(t('memos.common.loading'))
    expect(document.querySelectorAll('.skeleton')).toHaveLength(8)
  })

  it('scopes the library and its counts to the space in the route', async () => {
    setUrl('/memos/spaces/space-1/attachments')
    renderPage()
    await flush()

    expect(api.attachments.list).toHaveBeenCalledWith(
      { scope: 'all', spaceId: 'space-1', limit: 24 },
      expect.anything(),
    )
    expect(api.attachments.list).toHaveBeenCalledWith(
      { spaceId: 'space-1', cursor: null, limit: MEMO_MAX_PAGE_SIZE },
      expect.anything(),
    )
    expect(radio('All').textContent).toContain('2')
    expect(radio('Media').textContent).toContain('1')
    expect(radio('Audio').textContent).toContain('1')
    expect(radio('Documents').textContent).toContain('0')
    expect(document.body.textContent).toContain(
      t('memos.attachments.library.usage', { count: 2, size: '2.9 KB' }),
    )
    expect(document.body.textContent).toContain('space-one-photo.jpg')
    expect(document.body.textContent).not.toContain('space-two-doc.pdf')
    expect(document.body.textContent).not.toContain('including files from other spaces')
  })

  it('reloads the library when the route switches to another space', async () => {
    setUrl('/memos/spaces/space-1/attachments')
    renderPage()
    await flush()
    expect(document.body.textContent).toContain('space-one-photo.jpg')

    act(() => {
      window.history.pushState(null, '', '/memos/spaces/space-2/attachments')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await flush()

    expect(api.attachments.list).toHaveBeenCalledWith(
      { scope: 'all', spaceId: 'space-2', limit: 24 },
      expect.anything(),
    )
    expect(api.attachments.list).toHaveBeenCalledWith(
      { spaceId: 'space-2', cursor: null, limit: MEMO_MAX_PAGE_SIZE },
      expect.anything(),
    )
    expect(radio('All').textContent).toContain('1')
    expect(document.body.textContent).toContain('space-two-doc.pdf')
    expect(document.body.textContent).not.toContain('space-one-photo.jpg')
  })

  it('keeps the space filter when the scope changes', async () => {
    setUrl('/memos/spaces/space-1/attachments')
    renderPage()
    await flush()
    click(radio('Audio'))
    await flush()

    expect(api.attachments.list).toHaveBeenCalledWith(
      { scope: 'audio', spaceId: 'space-1', limit: 24 },
      expect.anything(),
    )
    expect(document.body.textContent).toContain('space-one-voice.mp3')
    expect(document.body.textContent).not.toContain('space-one-photo.jpg')
  })
})

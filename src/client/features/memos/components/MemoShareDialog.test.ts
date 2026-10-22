import { act, createElement, Fragment, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memo, MemoShare } from '@shared/memos/types'
import { ConfirmHost } from '../../../components/overlay'
import { initI18n, t } from '../../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../../lib/test-render'
import { useUi } from '../../../store/ui'
import { MemoShareDialog } from './MemoShareDialog'

const api = vi.hoisted(() => ({
  shares: {
    list: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
}))

const image = vi.hoisted(() => ({
  collectDocumentCss: vi.fn(async () => 'body { color: red }'),
  renderElementPng: vi.fn(async (
    _element: HTMLElement,
    _geometry: { width: number; height: number },
    _css: string,
  ) => new Blob(['png'], { type: 'image/png' })),
  saveImage: vi.fn(),
}))

vi.mock('../api', () => ({ memosApi: api }))
vi.mock('../../../lib/element-image', () => image)

function memo(overrides: Partial<Memo> = {}): Memo {
  return {
    id: 'memo-1',
    content: 'share me',
    title: '',
    snippet: '',
    tags: ['work'],
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
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    ...overrides,
  }
}

function share(overrides: Partial<MemoShare> = {}): MemoShare {
  return {
    id: 'share-1',
    memoId: 'memo-1',
    expiresAt: null,
    createdAt: 1_700_000_000,
    ...overrides,
  }
}

let view: RenderedElement | null = null

function dialog(open: boolean, item: Memo | null = null): ReactElement {
  return createElement(
    Fragment,
    null,
    createElement(MemoShareDialog, { memoId: 'memo-1', memo: item, open, onClose: () => {} }),
    createElement(ConfirmHost),
  )
}

function render(open = true, item: Memo | null = null): HTMLElement {
  view = renderElement(dialog(open, item))
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

function stubNativeShare(canShare: (data?: ShareData) => boolean, share: (data?: ShareData) => Promise<void>): void {
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: canShare })
  Object.defineProperty(navigator, 'share', { configurable: true, value: share })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  vi.clearAllMocks()
  useUi.setState({ toasts: [] })
  api.shares.list.mockResolvedValue({ shares: [] })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  Reflect.deleteProperty(navigator, 'canShare')
  Reflect.deleteProperty(navigator, 'share')
  vi.unstubAllGlobals()
})

describe('the share dialog', () => {
  it('creates a link, shows its address once and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    api.shares.create
      .mockResolvedValueOnce(share({ id: 'share-a', url: '/memos/s/token-a' }))
      .mockResolvedValueOnce(share({ id: 'share-b', url: '/memos/s/token-b' }))
    render()
    await flush()
    expect(api.shares.list).toHaveBeenCalledWith('memo-1', expect.any(AbortSignal))

    click(buttonByText(document.body, t('memos.share.create')))
    await flush()
    expect(api.shares.create).toHaveBeenCalledWith('memo-1', { expiresAt: null })
    expect(document.querySelector<HTMLInputElement>('input[readonly]')?.value)
      .toBe(`${window.location.origin}/memos/s/token-a`)
    expect(document.body.textContent).toContain(t('memos.share.url_hint'))

    click(buttonByText(document.body, t('memos.share.copy')))
    await flush()
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/memos/s/token-a`)
    expect(document.body.textContent).toContain(t('memos.share.copied'))

    click(buttonByText(document.body, t('memos.share.create')))
    await flush()
    expect(document.querySelector<HTMLInputElement>('input[readonly]')?.value)
      .toBe(`${window.location.origin}/memos/s/token-b`)

    act(() => { view?.rerender(dialog(false)) })
    act(() => { view?.rerender(dialog(true)) })
    await flush()
    expect(document.querySelector('input[readonly]')).toBeNull()
  })

  it('sends the chosen expiry with the new link', async () => {
    api.shares.create.mockResolvedValue(share({ url: '/memos/s/token-week' }))
    render()
    await flush()
    const select = document.querySelector('select')
    expect(select).not.toBeNull()
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    act(() => {
      setValue?.call(select, '7')
      select?.dispatchEvent(new Event('change', { bubbles: true }))
    })
    click(buttonByText(document.body, t('memos.share.create')))
    await flush()
    const input = api.shares.create.mock.calls[0]?.[1] as { expiresAt: number | null }
    expect(input.expiresAt).not.toBeNull()
    const seconds = (input.expiresAt ?? 0) - Math.floor(Date.now() / 1000)
    expect(seconds).toBeGreaterThan(7 * 86_400 - 30)
    expect(seconds).toBeLessThan(7 * 86_400 + 30)
  })

  it('lists active and expired links and revokes one after a confirmation', async () => {
    api.shares.list.mockResolvedValue({
      shares: [
        share({ id: 'share-active' }),
        share({ id: 'share-expired', createdAt: 900, expiresAt: 1_000 }),
      ],
    })
    api.shares.delete.mockResolvedValue({ ok: true })
    render()
    await flush()

    expect(document.body.textContent).toContain(t('memos.share.never_expires'))
    expect(document.body.textContent).toContain(t('memos.share.expired'))
    expect(document.querySelectorAll('li')).toHaveLength(2)

    click(buttonByText(document.body, t('memos.share.revoke')))
    await flush()
    expect(document.body.textContent).toContain(t('memos.share.revoke_title'))
    click(buttonByText(document.body, t('memos.share.revoke_confirm')))
    await flush()

    expect(api.shares.delete).toHaveBeenCalledWith('memo-1', 'share-active')
    expect(document.querySelectorAll('li')).toHaveLength(1)
  })

  it('offers a retry when the link list fails', async () => {
    api.shares.list
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ shares: [share({ id: 'share-active' })] })
    render()
    await flush()
    expect(document.body.textContent).toContain(t('api.error.unknown'))

    click(buttonByText(document.body, t('memos.common.retry')))
    await flush()
    expect(api.shares.list).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain(t('memos.share.never_expires'))
  })

  it('exports the memo card as a png', async () => {
    render(true, memo())
    expect(document.body.textContent).toContain('share me')
    expect(document.body.textContent).toContain('#work')
    click(buttonByText(document.body, t('memos.share.image_action')))
    await flush()

    expect(image.collectDocumentCss).toHaveBeenCalledTimes(1)
    const [element, geometry, css] = image.renderElementPng.mock.calls[0]!
    expect(element.dataset.memoShareImage).toBe('')
    expect(geometry).toEqual({ width: 420, height: 240 })
    expect(css).toBe('body { color: red }')
    expect(image.saveImage).toHaveBeenCalledWith(expect.any(Blob), 'memo-memo-1.png')
    expect(useUi.getState().toasts.some((toast) => toast.title === t('memos.share.image_saved'))).toBe(true)
  })

  it('opens the system share sheet instead of downloading when the image can be shared', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    stubNativeShare(() => true, share)
    render(true, memo())
    click(buttonByText(document.body, t('memos.share.image_action')))
    await flush()

    expect(share).toHaveBeenCalledTimes(1)
    const data = share.mock.calls[0]![0] as ShareData
    expect(data.title).toBe(t('common.product_name'))
    expect(data.files).toHaveLength(1)
    expect(data.files?.[0]?.name).toBe('memo-memo-1.png')
    expect(data.files?.[0]?.type).toBe('image/png')
    expect(image.saveImage).not.toHaveBeenCalled()
    expect(useUi.getState().toasts.some((toast) => toast.title === t('memos.share.image_saved'))).toBe(false)
  })

  it('treats a cancelled system share as done rather than an error', async () => {
    const cancelled = Object.assign(new Error('cancelled'), { name: 'AbortError' })
    stubNativeShare(() => true, vi.fn().mockRejectedValue(cancelled))
    render(true, memo())
    click(buttonByText(document.body, t('memos.share.image_action')))
    await flush()

    expect(image.saveImage).not.toHaveBeenCalled()
    expect(useUi.getState().toasts.some((toast) => toast.title === t('memos.share.image_failed'))).toBe(false)
    expect(useUi.getState().toasts.some((toast) => toast.title === t('memos.share.image_saved'))).toBe(false)
  })

  it('downloads the image when the browser cannot share files', async () => {
    stubNativeShare(() => false, vi.fn().mockResolvedValue(undefined))
    render(true, memo())
    click(buttonByText(document.body, t('memos.share.image_action')))
    await flush()

    expect(image.saveImage).toHaveBeenCalledWith(expect.any(Blob), 'memo-memo-1.png')
    expect(useUi.getState().toasts.some((toast) => toast.title === t('memos.share.image_saved'))).toBe(true)
  })

  it('reports a failed image export', async () => {
    image.renderElementPng.mockRejectedValueOnce(new Error('canvas unavailable'))
    render(true, memo())
    click(buttonByText(document.body, t('memos.share.image_action')))
    await flush()
    expect(image.saveImage).not.toHaveBeenCalled()
    expect(useUi.getState().toasts.some((toast) => toast.title === t('memos.share.image_failed'))).toBe(true)
  })
})

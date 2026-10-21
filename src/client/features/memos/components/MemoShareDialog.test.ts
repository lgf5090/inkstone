import { act, createElement, Fragment, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoShare } from '@shared/memos/types'
import { ConfirmHost } from '../../../components/overlay'
import { initI18n, t } from '../../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../../lib/test-render'
import { MemoShareDialog } from './MemoShareDialog'

const api = vi.hoisted(() => ({
  shares: {
    list: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('../api', () => ({ memosApi: api }))

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

function dialog(open: boolean): ReactElement {
  return createElement(
    Fragment,
    null,
    createElement(MemoShareDialog, { memoId: 'memo-1', open, onClose: () => {} }),
    createElement(ConfirmHost),
  )
}

function render(open = true): HTMLElement {
  view = renderElement(dialog(open))
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
  api.shares.list.mockResolvedValue({ shares: [] })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
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
})

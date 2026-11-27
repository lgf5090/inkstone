import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RssSavedView } from '@shared/types'
import { initI18n, t } from '../../lib/i18n'
import { RssSavedViews } from './RssSavedViews'

const mocks = vi.hoisted(() => ({
  update: vi.fn(async () => {}),
  open: vi.fn(async () => {}),
  setQuery: vi.fn(),
  setSort: vi.fn(),
  saved: [] as RssSavedView[],
}))

vi.mock('../../store/session', () => ({
  useSession: (selector: (state: unknown) => unknown) => selector({
    settings: { rss: { savedViews: mocks.saved } },
    updateSettings: mocks.update,
  }),
}))

vi.mock('./store', () => ({
  useRss: (selector: (state: unknown) => unknown) => selector({
    channel: { kind: 'feed', feedId: 'f1' },
    view: () => ({ query: 'author:Rae is:unread', sort: 'oldest' }),
    open: mocks.open,
    setQuery: mocks.setQuery,
    setSort: mocks.setSort,
  }),
}))

let root: Root
let container: HTMLDivElement

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocks.saved = []
  mocks.update.mockClear()
  mocks.open.mockClear()
  mocks.setQuery.mockClear()
  mocks.setSort.mockClear()
  await initI18n()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root.render(createElement(RssSavedViews)); await Promise.resolve() })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function input(): HTMLInputElement {
  return container.querySelector('input')!
}

async function typeName(value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

describe('saved RSS views', () => {
  it('saves the current channel, advanced query and sort', async () => {
    await typeName('Unread AI')
    await act(async () => { container.querySelector('form')!.requestSubmit(); await Promise.resolve() })
    expect(mocks.update).toHaveBeenCalledWith({ rss: { savedViews: [expect.objectContaining({ name: 'Unread AI', channel: 'feed:f1', query: 'author:Rae is:unread', sort: 'oldest' })] } })
    expect(input().value).toBe('')
  })

  it('reopens a saved view and removes it through the account settings', async () => {
    mocks.saved = [{ id: 'view-1', name: 'Unread AI', channel: 'feed:f1', query: 'author:Rae', sort: 'oldest' }]
    await act(async () => { root.render(createElement(RssSavedViews)); await Promise.resolve() })
    const apply = [...container.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === t('rss.saved_views.apply', { name: 'Unread AI' }))!
    await act(async () => { apply.click(); await Promise.resolve() })
    expect(mocks.open).toHaveBeenCalledWith({ kind: 'feed', feedId: 'f1' })
    expect(mocks.setQuery).toHaveBeenCalledWith('author:Rae')
    expect(mocks.setSort).toHaveBeenCalledWith('oldest')
    const remove = [...container.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === t('rss.saved_views.delete', { name: 'Unread AI' }))!
    await act(async () => { remove.click(); await Promise.resolve() })
    expect(mocks.update).toHaveBeenCalledWith({ rss: { savedViews: [] } })
  })
})

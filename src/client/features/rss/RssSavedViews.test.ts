import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RssSavedView } from '@shared/types'
import { emptyLibrary, newFeed } from '@shared/rss/model'
import { initI18n, t } from '../../lib/i18n'
import { RssSavedViews } from './RssSavedViews'
import { useRss } from './store'

const mocks = vi.hoisted(() => ({
  update: vi.fn(async () => {}),
  saved: [] as RssSavedView[],
}))

vi.mock('../../store/session', () => ({
  useSession: (selector: (state: unknown) => unknown) => selector({
    settings: { rss: { savedViews: mocks.saved, sortOrder: 'newest' } },
    updateSettings: mocks.update,
  }),
}))

const feed = newFeed('f1', 'https://example.com/feed', 'Fixture', 0)
const initialRss = useRss.getState()
const open = vi.fn(async () => {})
const setQuery = vi.fn()
const setSort = vi.fn()

let root: Root
let container: HTMLDivElement

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocks.saved = []
  mocks.update.mockClear()
  await initI18n()
  open.mockClear()
  setQuery.mockClear()
  setSort.mockClear()
  useRss.setState({
    library: { ...emptyLibrary(), feeds: [feed] },
    channel: { kind: 'feed', feedId: 'f1' },
    views: { 'feed:f1': { entryId: '', filter: 'all', query: 'author:Rae is:unread', sort: 'oldest', version: 'original', platform: 'all', listTop: 0, readerTop: 0 } },
    open,
    setQuery,
    setSort,
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root.render(createElement(RssSavedViews)); await Promise.resolve() })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useRss.setState(initialRss)
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
  it('renders defaults without creating an unstable store snapshot', async () => {
    await act(async () => { useRss.setState({ views: {} }); root.render(createElement(RssSavedViews)); await Promise.resolve() })
    await typeName('Default view')
    await act(async () => { container.querySelector('form')!.requestSubmit(); await Promise.resolve() })
    expect(mocks.update).toHaveBeenCalledWith({ rss: { savedViews: [expect.objectContaining({ name: 'Default view', channel: 'feed:f1', query: '', sort: 'newest' })] } })
  })

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
    expect(open).toHaveBeenCalledWith({ kind: 'feed', feedId: 'f1' })
    expect(setQuery).toHaveBeenCalledWith('author:Rae')
    expect(setSort).toHaveBeenCalledWith('oldest')
    const remove = [...container.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === t('rss.saved_views.delete', { name: 'Unread AI' }))!
    await act(async () => { remove.click(); await Promise.resolve() })
    expect(mocks.update).toHaveBeenCalledWith({ rss: { savedViews: [] } })
  })
})

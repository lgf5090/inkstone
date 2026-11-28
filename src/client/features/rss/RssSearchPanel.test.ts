import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyLibrary, newFeed, type RssEntry } from '@shared/rss/model'
import { initI18n } from '../../lib/i18n'
import { RssSearchPanel } from './RssSearchPanel'

const entry: RssEntry = {
  id: 'e1', feedId: 'f1', title: 'Inkstone UI verification article', link: 'https://example.com/1',
  author: '', publishedTs: 1, summary: '', content: '', imageUrl: '', audioUrl: '',
}
const feed = newFeed('f1', 'https://example.com/feed', 'Fixture', 0)

vi.mock('./store', () => ({
  useRss: (selector: (state: unknown) => unknown) => selector({
    library: { ...emptyLibrary(), feeds: [feed] },
    allCached: [entry],
    loadAllCached: vi.fn(async () => []),
  }),
}))

vi.mock('../../lib/api', () => ({
  api: { rss: { search: vi.fn(async () => ({ articles: [], total: 0 })) } },
}))

let root: Root
let container: HTMLDivElement

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  await initI18n()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(RssSearchPanel, { open: true, onClose: vi.fn(), onPick: vi.fn() }))
    await Promise.resolve()
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('RSS advanced search panel', () => {
  it('treats a field-only query as a search and shows matching cached articles', async () => {
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, 'title:verification')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    await vi.waitFor(() => {
      expect(document.querySelector('[role="dialog"] li button')?.textContent).toContain('Inkstone UI verification article')
    })
  })
})

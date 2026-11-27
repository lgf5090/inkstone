import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyLibrary, newFeed, type RssEntry } from '@shared/rss/model'
import { mergeSettings } from '@shared/constants'
import { channelKey } from '@shared/rss/reading'
import { Modal } from '../../components/overlay'
import { initI18n, t } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useRss } from './store'
import { RssArticleList } from './RssArticleList'
import { RssKeys } from './RssKeys'

const feed = newFeed('feed-1', 'https://example.com/feed.xml', 'Example', 0)
const entry: RssEntry = {
  id: 'entry-1', feedId: feed.id, title: 'First article', link: 'https://example.com/1',
  author: '', publishedTs: 1_700_000_000_000, summary: 'Summary', content: '<p>Body</p>', imageUrl: '', audioUrl: '',
}
const channel = { kind: 'feed', feedId: feed.id } as const
let rendered: RenderedElement | null = null
const openEntry = vi.fn()
const onOpen = vi.fn()
const originalSession = useSession.getState()

function mount(withDialog = false): HTMLElement {
  rendered = renderElement(createElement('div', null,
    createElement(RssArticleList, { onOpen, onManage: vi.fn() }),
    withDialog ? createElement(Modal, { open: true, onClose: vi.fn(), ariaLabel: 'Test dialog', children: 'Dialog body' }) : null,
  ))
  return rendered.container
}

function press(target: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  act(() => { target.dispatchEvent(event) })
  return event
}

beforeAll(async () => { await initI18n() })

beforeEach(() => {
  useSession.setState({ settings: mergeSettings({}) })
  useRss.getState().reset()
  useRss.setState({
    status: 'ready',
    library: { ...emptyLibrary(), feeds: [feed], readIds: [entry.id] },
    articles: { [feed.id]: [entry] },
    fetchedAt: { [feed.id]: 1 },
    channel,
    views: { [channelKey(channel)]: { entryId: entry.id, filter: 'all', query: '', sort: 'newest', version: 'original', platform: 'all', listTop: 0, readerTop: 0 } },
    openEntry,
  })
  openEntry.mockClear()
  onOpen.mockClear()
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  useRss.getState().reset()
  useSession.setState(originalSession)
})

describe('RSS document shortcuts', () => {
  it('leaves Enter to a focused button instead of opening the selected article', () => {
    const container = mount()
    const button = container.querySelector<HTMLButtonElement>('button')
    if (!button) throw new Error('the list has no button')
    button.focus()
    const event = press(button, 'Enter')
    expect(event.defaultPrevented).toBe(false)
    expect(openEntry).not.toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('does not move the article selection while a dialog owns the keyboard', () => {
    mount(true)
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    if (!dialog) throw new Error('the dialog is not open')
    const event = press(dialog, 'j')
    expect(event.defaultPrevented).toBe(false)
    expect(openEntry).not.toHaveBeenCalled()
  })

  it('does not run character shortcuts after the reader turns them off', () => {
    useSession.setState({ settings: mergeSettings({ rss: { keyboardShortcuts: false } }) })
    const container = mount()
    const event = press(container, 'j')
    expect(event.defaultPrevented).toBe(false)
    expect(openEntry).not.toHaveBeenCalled()
  })

  it('tells the reader in the shortcut sheet when the keys are off', () => {
    rendered = renderElement(createElement(RssKeys, { open: true, onClose: vi.fn(), enabled: false }))
    expect(document.body.textContent).toContain(t('rss.keys_disabled'))
  })

  it('still walks the list from the reading surface', () => {
    const container = mount()
    press(container, 'j')
    expect(openEntry).toHaveBeenCalledWith(entry.id)
  })
})

/**
 * Two things the reader pane must do that only the rendered pane can say.
 *
 * The first is the attribution line a bridged WeChat article carries: `remoteContentKey` is tested
 * as a pure function, and the branch that uses it is JSX — an expression that never renders is
 * exactly as invisible as one that was never written.
 *
 * The second is an article that left the channel it was opened from. The list is a filter, so
 * marking the only unread item read takes its own row away; the page the reader is looking at must
 * not go blank with it.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyLibrary, type RssEntry, type RssFeed } from '@shared/rss/model'
import { channelKey, type RssChannel } from '@shared/rss/reading'
import { initI18n, t } from '../../lib/i18n'
import { useRss } from './store'
import { RssReader } from './RssReader'

const FEED_ID = 'feed-1'
const WX_LINK = 'https://mp.weixin.qq.com/s?__biz=MzA5NTg0Njc0Mw%3D%3D&mid=2650445123&idx=1&sn=6d2f0e1a'
const PLAIN_LINK = 'https://example.com/posts/onboarding'

const feed: RssFeed = {
  id: FEED_ID, url: 'https://rsshub.example.com/wechat/first', title: 'Bridged account',
  siteUrl: 'https://mp.weixin.qq.com', imageUrl: '', groupId: '', tags: [], order: 0,
  updatedAt: 1, lastAttemptAt: 1, error: '', errorCount: 0, lastErrorAt: 0, etag: '', lastModified: '', paused: false,
}

function entryFor(link: string, id: string): RssEntry {
  return {
    id, feedId: FEED_ID, title: 'An article that came through a bridge', link, author: 'Author',
    publishedTs: 1_700_000_000_000, summary: 'A summary', content: '<p>One paragraph of body.</p>', imageUrl: '', audioUrl: '',
  }
}

const original = useRss.getState()
let root: Root
let container: HTMLDivElement

async function mount(item: RssEntry, channel: RssChannel = { kind: 'feed', feedId: FEED_ID }, readIds: string[] = []): Promise<void> {
  useRss.setState({
    ...original,
    status: 'ready',
    library: { ...emptyLibrary(), feeds: [feed], readIds },
    articles: { [FEED_ID]: [item] },
    fetchedAt: { [FEED_ID]: Date.now() },
    channel,
    views: { [channelKey(channel)]: { entryId: item.id, filter: 'all', query: '', sort: 'newest', platform: 'all', listTop: 0, readerTop: 0 } },
  })
  await act(async () => { root.render(createElement(RssReader)) })
}

const anchors = (): HTMLAnchorElement[] => [...container.querySelectorAll<HTMLAnchorElement>('a')]
const toolbar = (label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find(node => node.getAttribute('aria-label') === label)

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  await initI18n()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useRss.setState(original)
})

describe('the WeChat attribution line', () => {
  it('is drawn for a bridged article, with the way back to the author', async () => {
    const item = entryFor(WX_LINK, 'wx-entry')
    await mount(item)
    expect(container.textContent).toContain(t('rss.wechat_notice'))
    const back = anchors().find(anchor => anchor.textContent === t('rss.wechat_original'))
    expect(back, 'the line carries a link to the original').toBeTruthy()
    expect(back?.getAttribute('href')).toBe(WX_LINK)
    expect(back?.getAttribute('rel')).toContain('noopener')
  })

  it('stays out of the way of an ordinary feed article', async () => {
    await mount(entryFor(PLAIN_LINK, 'plain-entry'))
    expect(container.textContent).not.toContain(t('rss.wechat_notice'))
    expect(anchors().some(anchor => anchor.textContent === t('rss.wechat_original'))).toBe(false)
  })
})

describe('an article that left its channel', () => {
  it('is still the page being read when the unread filter no longer holds it', async () => {
    const item = entryFor(PLAIN_LINK, 'gone-unread')
    await mount(item, { kind: 'unread' }, [item.id])
    expect(container.textContent).toContain(item.title)
    expect(toolbar(t('rss.save_note')), 'the one-article toolbar stays usable').toBeTruthy()
  })

  it('gives up the toolbar when no article on this device has that id', async () => {
    const item = entryFor(PLAIN_LINK, 'held-entry')
    await mount(item)
    expect(toolbar(t('rss.save_note'))).toBeTruthy()
    // The reader cleared its cache for this feed: the remembered article is gone, and the pane has
    // to say so rather than keep drawing a page out of nothing.
    await act(async () => { useRss.setState({ articles: {} }) })
    expect(container.textContent).not.toContain(item.title)
    expect(toolbar(t('rss.save_note'))).toBeUndefined()
  })
})

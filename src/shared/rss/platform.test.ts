/**
 * The platform table, on the addresses the reference reader's own library contains.
 *
 * The suffix rule is the one worth pinning: a host that ends in the string `youtube.com` without
 * being inside it is somebody else's page, and a badge that reads it as YouTube would be telling the
 * reader to trust an address that is pretending to be a known one.
 */
import { describe, expect, it } from 'vitest'
import type { RssEntry } from './model'
import { filterByPlatform, platformCounts, platformOf } from './platform'

function entry(link: string, id = link): RssEntry {
  return { id, feedId: 'f', title: 'T', link, author: '', publishedTs: null, summary: '', content: '', imageUrl: '', audioUrl: '' }
}

describe('platformOf', () => {
  it('reads the four platforms the library turns up', () => {
    expect(platformOf('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube')
    expect(platformOf('https://youtu.be/dQw4w9WgXcQ')).toBe('youtube')
    expect(platformOf('https://m.bilibili.com/video/BV1xx411c7mD')).toBe('bilibili')
    expect(platformOf('https://b23.tv/abc123')).toBe('bilibili')
    expect(platformOf('https://mp.weixin.qq.com/s?__biz=MzA5&mid=1&idx=1&sn=x')).toBe('wechat')
    expect(platformOf('https://blog.codingnow.com/2026/01/notes.html')).toBe('web')
  })

  it('refuses a host that only ends in the familiar name', () => {
    expect(platformOf('https://youtube.com.evil.test/watch')).toBe('web')
    expect(platformOf('https://not-mp.weixin.qq.com/s')).toBe('web')
    expect(platformOf('https://evil.test/?next=https://mp.weixin.qq.com/s')).toBe('web')
  })

  it('calls a missing or unreadable address an article rather than guessing', () => {
    for (const link of ['', null, undefined, 'javascript:alert(1)', 'not a url']) {
      expect(platformOf(link as string | null | undefined)).toBe('web')
    }
  })

  it('is case insensitive about the host', () => {
    expect(platformOf('https://WWW.YouTube.com/watch?v=1')).toBe('youtube')
  })
})

describe('the filter and its counts', () => {
  const list = [entry('https://youtu.be/a'), entry('https://mp.weixin.qq.com/s?x=1'), entry('https://blog.test/1'), entry('https://blog.test/2')]

  it('leaves the list alone for the whole channel', () => {
    expect(filterByPlatform(list, 'all')).toBe(list)
  })

  it('keeps one platform and counts every one', () => {
    expect(filterByPlatform(list, 'youtube').map(item => item.id)).toEqual(['https://youtu.be/a'])
    expect([...platformCounts(list).entries()]).toEqual([['youtube', 1], ['wechat', 1], ['web', 2]])
  })

  it('answers with nothing for a platform the channel does not carry', () => {
    expect(filterByPlatform(list, 'bilibili')).toEqual([])
  })
})

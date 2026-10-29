// @vitest-environment jsdom
/**
 * The detail panel as a reader meets it: the desktop empty state, the privacy-enhanced embed, and
 * the phone's way back. The comment request is mocked so the case never leaves the process.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { YouTubeVideo } from '@shared/youtube/model'
import { formatCount } from '@shared/youtube/model'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { VideoDetail } from './VideoDetail'

const api = vi.hoisted(() => ({
  fetchComments: vi.fn(),
}))

vi.mock('../api', () => ({ fetchComments: api.fetchComments }))

function video(overrides: Partial<YouTubeVideo> = {}): YouTubeVideo {
  return {
    id: 'abc123',
    title: 'A video about tunnels',
    description: 'First line\nSecond line',
    publishedAt: '2026-10-01T10:00:00.000Z',
    channelId: 'UCabc123',
    channelTitle: 'Tunnel Weekly',
    thumbnailUrl: '',
    thumbnailHighUrl: '',
    duration: 'PT4M5S',
    viewCount: 12_345,
    likeCount: 678,
    commentCount: 90,
    tags: ['tunnel', 'engineering'],
    categoryId: '28',
    isLive: false,
    ...overrides,
  }
}

let view: RenderedElement | null = null

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(async () => {
  await initI18n()
  vi.clearAllMocks()
  api.fetchComments.mockResolvedValue({ items: [], total: 0, nextPageToken: null })
})

afterEach(() => {
  act(() => {
    view?.unmount()
  })
  view = null
  document.body.innerHTML = ''
})

describe('VideoDetail', () => {
  it('centres the empty state when no video is selected', async () => {
    view = renderElement(createElement(VideoDetail, { video: null }))
    await flush()
    expect(view.container.textContent).toContain(t('youtube.detail.empty'))
  })

  it('embeds the video through the privacy-enhanced host', async () => {
    const subject = video()
    view = renderElement(createElement(VideoDetail, { video: subject }))
    await flush()

    const frame = view.container.querySelector('iframe')
    expect(frame).not.toBeNull()
    expect(frame?.getAttribute('src')).toBe(
      'https://www.youtube-nocookie.com/embed/abc123?rel=0',
    )
    expect(frame?.getAttribute('title')).toBe(subject.title)
    expect(frame?.getAttribute('allow')).toContain('encrypted-media')
    expect(frame?.allowFullscreen).toBe(true)
  })

  it('runs the mobile back button', async () => {
    const onBack = vi.fn()
    view = renderElement(createElement(VideoDetail, { video: video(), onBack }))
    await flush()

    const back = Array.from(view.container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === t('youtube.mobile.back'),
    )
    expect(back).toBeDefined()
    act(() => {
      back?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('links the channel, the statistics and the original video', async () => {
    const subject = video()
    view = renderElement(createElement(VideoDetail, { video: subject }))
    await flush()

    const channel = view.container.querySelector<HTMLAnchorElement>(
      `a[href="https://www.youtube.com/channel/${subject.channelId}"]`,
    )
    expect(channel?.target).toBe('_blank')
    expect(channel?.rel).toBe('noopener noreferrer')

    expect(view.container.textContent).toContain(formatCount(subject.viewCount))
    expect(view.container.textContent).toContain('4:05')
    expect(view.container.textContent).toContain('#tunnel')

    const open = Array.from(view.container.querySelectorAll('a')).find((link) =>
      link.textContent?.includes(t('youtube.detail.open')),
    )
    expect(open?.getAttribute('href')).toBe(`https://www.youtube.com/watch?v=${subject.id}`)
    expect(open?.getAttribute('rel')).toBe('noopener noreferrer')
  })
})

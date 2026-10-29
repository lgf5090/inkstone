import { act } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatCount, type YouTubeChannel, type YouTubePlaylist } from '@shared/youtube/model'
import { initI18n, t } from '../../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../../lib/test-render'
import { useYoutubeStore } from '../store'
import { AddChannelDialog } from './AddChannelDialog'
import { AddPlaylistDialog } from './AddPlaylistDialog'
import { fetchChannel, fetchChannelPlaylists, fetchPlaylist, putChannel, putPlaylist } from '../api'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    fetchChannel: vi.fn(),
    fetchChannelPlaylists: vi.fn(),
    fetchPlaylist: vi.fn(),
    putChannel: vi.fn(),
    putPlaylist: vi.fn(),
  }
})

const channel: YouTubeChannel = {
  id: 'UCabcdefghijklmnopqrstuv',
  title: 'A saved channel',
  description: '',
  customUrl: '@saved-channel',
  thumbnailUrl: 'https://example.test/channel.jpg',
  subscriberCount: 12345,
  videoCount: 678,
  uploadsPlaylistId: 'UUabcdefghijklmnopqrstuv',
  publishedAt: '2020-01-01T00:00:00.000Z',
}

function playlist(id: string, title: string, channelTitle = 'A channel'): YouTubePlaylist {
  return {
    id,
    title,
    description: '',
    channelId: channel.id,
    channelTitle,
    thumbnailUrl: `https://example.test/${id}.jpg`,
    itemCount: 12,
    publishedAt: '2021-01-01T00:00:00.000Z',
  }
}

let rendered: RenderedElement | null = null

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

beforeEach(() => {
  useYoutubeStore.setState({
    library: { tags: [], videos: [], channels: [], playlists: [], truncated: false },
    libraryStatus: 'ready',
    libraryError: null,
    pending: [],
  })
  vi.mocked(fetchChannel).mockReset()
  vi.mocked(fetchChannelPlaylists).mockReset()
  vi.mocked(fetchPlaylist).mockReset()
  vi.mocked(putChannel).mockReset()
  vi.mocked(putPlaylist).mockReset()
  vi.mocked(putChannel).mockImplementation(async (saved) => ({ channel: saved }))
  vi.mocked(putPlaylist).mockImplementation(async (saved) => ({ playlist: saved }))
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
})

function node<T extends Element>(value: T | null | undefined, name: string): T {
  expect(value, `${name} is not rendered`).toBeTruthy()
  return value as T
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === label,
  )
  return node(found, `button "${label}"`)
}

async function click(label: string): Promise<void> {
  const target = button(label)
  await act(async () => {
    target.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function type(field: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('AddChannelDialog', () => {
  it('previews the looked-up channel and subscribes through the store', async () => {
    vi.mocked(fetchChannel).mockResolvedValue({ channel })
    const onClose = vi.fn()
    rendered = renderElement(<AddChannelDialog open onClose={onClose} existingIds={new Set()} />)

    await type(node(document.body.querySelector('input'), 'the channel field'), channel.id)
    await click(t('youtube.channels.query'))

    expect(vi.mocked(fetchChannel)).toHaveBeenCalledWith(channel.id)
    expect(document.body.textContent).toContain(channel.title)
    expect(document.body.textContent).toContain(
      t('youtube.channels.video_count', { count: formatCount(channel.videoCount) }),
    )
    expect(document.body.textContent).toContain(
      t('youtube.channels.subscriber_count', { count: formatCount(channel.subscriberCount) }),
    )
    expect(document.body.textContent).toContain(channel.customUrl ?? '')
    expect(document.body.querySelector('img')?.getAttribute('src')).toBe(channel.thumbnailUrl)

    await click(t('youtube.channels.add_subscription'))

    expect(vi.mocked(putChannel)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(putChannel).mock.calls[0]?.[0]).toMatchObject({
      id: channel.id,
      data: channel,
      pinned: false,
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('disables the subscription button for a channel that is already saved', async () => {
    vi.mocked(fetchChannel).mockResolvedValue({ channel })
    rendered = renderElement(
      <AddChannelDialog open onClose={() => {}} existingIds={new Set([channel.id])} />,
    )

    await type(node(document.body.querySelector('input'), 'the channel field'), channel.id)
    await click(t('youtube.channels.query'))

    expect(button(t('youtube.channels.add_subscription')).disabled).toBe(true)
    expect(document.body.textContent).toContain(t('youtube.channels.already_added'))
    expect(vi.mocked(putChannel)).not.toHaveBeenCalled()
  })
})

describe('AddPlaylistDialog', () => {
  it('adds a pasted playlist link without a channel lookup', async () => {
    const onClose = vi.fn()
    rendered = renderElement(<AddPlaylistDialog open onClose={onClose} existingIds={new Set()} />)

    await type(
      node(document.body.querySelector('input'), 'the playlist field'),
      'https://www.youtube.com/playlist?list=PLabcdefghijklmnopqrstuv',
    )

    // The link names its own ID, so the channel lookup is skipped; the metadata request is not.
    expect(button(t('youtube.playlists.query')).disabled).toBe(true)
    expect(vi.mocked(fetchChannelPlaylists)).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('PLabcdefghijklmnopqrstuv')

    vi.mocked(fetchPlaylist).mockResolvedValue({
      playlist: { ...playlist('PLabcdefghijklmnopqrstuv', 'Pasted playlist'), channelTitle: 'A channel' },
    })
    await click(t('youtube.playlists.add'))

    expect(vi.mocked(fetchPlaylist)).toHaveBeenCalledWith('PLabcdefghijklmnopqrstuv')
    expect(vi.mocked(putPlaylist)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(putPlaylist).mock.calls[0]?.[0]).toMatchObject({
      id: 'PLabcdefghijklmnopqrstuv',
      data: { title: 'Pasted playlist' },
    })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('lists a channel in pages and appends the next page', async () => {
    const first = playlist('PLfirst', 'First playlist')
    const second = playlist('PLsecond', 'Second playlist')
    vi.mocked(fetchChannelPlaylists)
      .mockResolvedValueOnce({ items: [first], total: 2, nextPageToken: 'page-2', prevPageToken: null })
      .mockResolvedValueOnce({ items: [second], total: 2, nextPageToken: null, prevPageToken: null })
    rendered = renderElement(<AddPlaylistDialog open onClose={() => {}} existingIds={new Set()} />)

    await type(node(document.body.querySelector('input'), 'the playlist field'), channel.id)
    await click(t('youtube.playlists.query'))

    expect(vi.mocked(fetchChannelPlaylists)).toHaveBeenNthCalledWith(1, channel.id, undefined)
    expect(document.body.textContent).toContain(first.title)

    await click(t('youtube.playlists.load_more'))

    expect(vi.mocked(fetchChannelPlaylists)).toHaveBeenNthCalledWith(2, channel.id, 'page-2')
    expect(document.body.textContent).toContain(first.title)
    expect(document.body.textContent).toContain(second.title)
  })
})

// @vitest-environment jsdom
/**
 * The artist page's new tabs and its follow control.
 *
 * Follow is optimistic: the button flips before the answer, and a refusal — including the provider
 * account refusal — puts it back. The events feed is cursor-paged, so the second press is asserted
 * at the API boundary as well as on screen.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  MusicAlbumSummary,
  MusicArtistDetail,
  MusicArtistEvent,
  MusicArtistEventPage,
} from '../src/shared/music/api'
import type { MusicTrack } from '../src/shared/music/model'
import { ApiError } from '../src/client/lib/api'
import { initI18n } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../src/client/lib/test-render'
import { musicApi } from '../src/client/features/music/api'
import { musicText } from '../src/client/features/music/components/labels'
import { ArtistPage } from '../src/client/features/music/pages/ArtistPage'
import { useMusicLibrary } from '../src/client/features/music/store/library'
import { useUi } from '../src/client/store/ui'

function track(overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id: 'track-1',
    provider: 'netease',
    providerId: 'track-1',
    kind: 'song',
    title: 'Track one',
    artists: [{ id: 'artist-1', name: 'Artist one' }],
    album: 'Album one',
    albumId: 'album-1',
    coverUrl: 'https://provider.example/cover.jpg',
    coverKey: '',
    durationMs: 185_000,
    format: 'mp3',
    bitrate: 320_000,
    size: 1_000,
    sha256: '',
    r2Key: null,
    source: 'netease',
    sourceQuality: 'exhigh',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

const album: MusicAlbumSummary = {
  id: 'album-9',
  name: 'Album nine',
  coverUrl: 'https://provider.example/album.jpg',
  artists: ['Artist one'],
  publishTime: 0,
  trackCount: 9,
}

function detail(overrides: Partial<MusicArtistDetail> = {}): MusicArtistDetail {
  return {
    artist: {
      id: 'artist-1',
      name: 'Artist one',
      coverUrl: 'https://provider.example/artist.jpg',
      albumCount: 4,
      followCount: 12_300,
    },
    description: 'A biography.',
    followed: false,
    accountId: 'account-1',
    hotTracks: [track()],
    albums: [album],
    albumTotal: 1,
    albumHasMore: false,
    ...overrides,
  }
}

function event(overrides: Partial<MusicArtistEvent> = {}): MusicArtistEvent {
  return {
    id: 'event-1',
    createdAt: 1_700_000_000_000,
    authorName: 'Artist one',
    authorAvatarUrl: 'https://provider.example/avatar.jpg',
    content: 'A new record is out.',
    pictures: ['https://provider.example/picture.jpg'],
    likedCount: 3,
    commentCount: 2,
    forwarded: '',
    song: null,
    album,
    playlist: null,
    ...overrides,
  }
}

function buttonByText(scope: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => (button.textContent ?? '').trim() === text,
  )
}

function buttonContaining(scope: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => (button.textContent ?? '').includes(text),
  )
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

let rendered: RenderedElement | null = null

beforeEach(async () => {
  installTestGlobals()
  localStorage.clear()
  await initI18n()
  useUi.setState({ toasts: [] })
  useMusicLibrary.setState({ touchRecent: vi.fn(async () => undefined) })
  vi.spyOn(musicApi, 'artist').mockResolvedValue(detail())
  vi.spyOn(musicApi, 'artistAlbums').mockResolvedValue({ items: [album], total: 1, hasMore: false })
  vi.spyOn(musicApi, 'artistSongs').mockResolvedValue({ items: [track()], total: 1, hasMore: false })
  vi.spyOn(musicApi, 'artistEvents').mockResolvedValue({ items: [], before: null })
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ArtistPage follow', () => {
  it('flips before the answer and keeps the server state after a success', async () => {
    const follow = vi.spyOn(musicApi, 'artistFollow').mockResolvedValue({ followed: true })
    rendered = renderElement(createElement(ArtistPage, { id: 'artist-1' }))
    await flush()

    const before = buttonByText(rendered.container, musicText('music.artist.follow'))!
    expect(before.getAttribute('aria-pressed')).toBe('false')
    act(() => before.click())

    expect(buttonByText(rendered.container, musicText('music.artist.following'))!.getAttribute('aria-pressed'))
      .toBe('true')
    await flush()

    expect(follow).toHaveBeenCalledWith('artist-1', true)
    expect(buttonByText(rendered.container, musicText('music.artist.following'))!.getAttribute('aria-pressed'))
      .toBe('true')
    expect(useUi.getState().toasts.at(-1)?.title).toBe(
      musicText('music.artist.followed_toast', { name: 'Artist one' }),
    )
  })

  it('rolls back to unfollowed and sends a reader without an account to login', async () => {
    let reject!: (reason: unknown) => void
    const follow = vi.spyOn(musicApi, 'artistFollow').mockReturnValue(
      new Promise((_, onReject) => {
        reject = onReject
      }),
    )
    window.history.replaceState(null, '', '/music/artist/artist-1')
    rendered = renderElement(createElement(ArtistPage, { id: 'artist-1' }))
    await flush()

    act(() => buttonByText(rendered!.container, musicText('music.artist.follow'))!.click())
    expect(buttonByText(rendered.container, musicText('music.artist.following'))!.getAttribute('aria-pressed'))
      .toBe('true')

    await act(async () => {
      reject(new ApiError(409, 'music_provider_auth_required', 'Connect a provider account first'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(follow).toHaveBeenCalledWith('artist-1', true)
    expect(buttonByText(rendered.container, musicText('music.artist.follow'))!.getAttribute('aria-pressed'))
      .toBe('false')
    expect(useUi.getState().toasts.at(-1)?.title).toBe(musicText('music.artist.follow_login'))
    expect(window.location.pathname).toBe('/music/login')
  })
})

describe('ArtistPage tabs', () => {
  it('asks the songs route for the latest order and shows the rows', async () => {
    const songs = vi.spyOn(musicApi, 'artistSongs').mockResolvedValue({
      items: [track({ id: 'latest-1', title: 'Latest one' })],
      total: 1,
      hasMore: false,
    })
    rendered = renderElement(createElement(ArtistPage, { id: 'artist-1' }))
    await flush()

    act(() => buttonByText(rendered!.container, musicText('music.artist.tab.latest'))!.click())
    await flush()

    expect(songs).toHaveBeenCalledWith('artist-1', 1, 100, 'time')
    expect(rendered.container.textContent).toContain('Latest one')
  })

  it('pages the events feed with its before cursor and opens attached albums', async () => {
    const events = vi.spyOn(musicApi, 'artistEvents')
      .mockResolvedValueOnce({ items: [event()], before: 123 })
      .mockResolvedValueOnce({
        items: [event({ id: 'event-2', content: 'A second update.', pictures: [], album: null })],
        before: null,
      } satisfies MusicArtistEventPage)
    window.history.replaceState(null, '', '/music/artist/artist-1')
    rendered = renderElement(createElement(ArtistPage, { id: 'artist-1' }))
    await flush()

    act(() => buttonByText(rendered!.container, musicText('music.artist.tab.events'))!.click())
    await flush()

    expect(events).toHaveBeenCalledWith('artist-1', null, 20)
    expect(rendered.container.textContent).toContain('A new record is out.')
    const picture = [...rendered.container.querySelectorAll<HTMLImageElement>('img')]
      .find((image) => (image.getAttribute('src') ?? '').includes('picture.jpg'))
    expect(picture, 'the event picture was not proxied').toBeTruthy()

    act(() => buttonContaining(rendered!.container, album.name)!.click())
    expect(window.location.pathname).toBe('/music/album/album-9')

    act(() => buttonByText(rendered!.container, musicText('music.artist.events.load_more'))!.click())
    await flush()

    expect(events).toHaveBeenLastCalledWith('artist-1', 123, 20)
    expect(rendered.container.textContent).toContain('A second update.')
  })
})

// @vitest-environment jsdom
/**
 * The Now Playing layer and the two compact doors into it.
 *
 * The provider is mocked so mounting the lyric pane settles immediately: these cases are about which
 * surface is shown, which tab is selected, and where a press lands, not about fetching lyrics.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MusicTrack } from '../src/shared/music/model'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../src/client/lib/test-render'
import { MiniPlayer } from '../src/client/features/music/components/MiniPlayer'
import { NowPlaying } from '../src/client/features/music/components/NowPlaying'
import { PlayBar } from '../src/client/features/music/components/PlayBar'
import { musicText } from '../src/client/features/music/components/labels'
import { useMusicLibrary } from '../src/client/features/music/store/library'
import { useMusicPlayer } from '../src/client/features/music/store/player'
import { useMusicUi } from '../src/client/features/music/store/ui'

vi.mock('../src/client/features/music/api', () => ({
  musicApi: {
    lyrics: vi.fn(async () => ({ lrc: '', yrc: '', tlyric: '' })),
    coverUrl: (trackId: string) => `/api/music/media/cover/${trackId}`,
    // A queue press starts playback; holding that promise keeps the audio engine out of this suite.
    upsertTracks: vi.fn(() => new Promise(() => undefined)),
  },
}))

// The lyric pane's translation call belongs to the AI lane; this suite never presses it.
vi.mock('../src/client/features/music/lyrics-ai', () => ({
  defaultLyricTranslationLang: () => 'en-US',
  translateTrackLyrics: vi.fn(async () => ({ lines: [], model: 'test', cached: false })),
}))

function track(id: string, title: string): MusicTrack {
  return {
    id,
    provider: 'netease',
    providerId: id,
    kind: 'song',
    title,
    artists: [{ id: `artist-${id}`, name: `Artist ${id}` }],
    album: 'Album one',
    albumId: 'album-1',
    coverUrl: '',
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
  }
}

const first = track('track-1', 'Track one')
const second = track('track-2', 'Track two')

function resetPlayer(): void {
  useMusicPlayer.setState({
    queue: { tracks: [first, second], index: 0, mode: 'order', original: null },
    status: 'paused',
    positionMs: 0,
    durationMs: first.durationMs,
    volume: 1,
    muted: false,
    rate: 1,
    error: null,
    errorDetail: null,
    consecutiveFailures: 0,
    awaitingGesture: false,
    sourceUrl: '',
  })
}

function resetUi(): void {
  useMusicUi.setState({
    queueOpen: false,
    lyricsOpen: false,
    nowPlayingOpen: false,
    nowPlayingTab: 'lyrics',
  })
}

function buttonByLabel(scope: HTMLElement, label: string): HTMLButtonElement | null {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('aria-label') === label,
  ) ?? null
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]')
}

let rendered: RenderedElement | null = null

beforeEach(async () => {
  installTestGlobals()
  localStorage.clear()
  await initI18n()
  resetPlayer()
  resetUi()
  useMusicLibrary.setState({ favorites: [] })
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  resetUi()
  vi.clearAllMocks()
})

describe('the Now Playing layer', () => {
  it('opens on lyrics and closes from the close button and Escape', async () => {
    rendered = renderElement(createElement(NowPlaying))
    expect(dialog()).toBeNull()

    await act(async () => {
      useMusicUi.getState().setNowPlayingOpen(true, 'lyrics')
    })

    expect(dialog()).not.toBeNull()
    expect(dialog()!.getAttribute('aria-label')).toBe(musicText('music.nowplaying.title'))
    expect(document.querySelector('[role="tabpanel"]')!.getAttribute('aria-label')).toBe(
      musicText('music.lyrics.title'),
    )

    const close = buttonByLabel(document.body, t('common.close'))
    expect(close, 'the layer has no close control').toBeTruthy()
    act(() => close!.click())
    expect(dialog()).toBeNull()
    expect(useMusicUi.getState().nowPlayingOpen).toBe(false)

    act(() => {
      useMusicUi.getState().setNowPlayingOpen(true, 'lyrics')
    })
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(dialog()).toBeNull()
  })

  it('switches to the queue and starts the pressed track', async () => {
    rendered = renderElement(createElement(NowPlaying))
    await act(async () => {
      useMusicUi.getState().setNowPlayingOpen(true, 'lyrics')
    })

    const queueTab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent?.includes(musicText('music.queue.title')),
    )
    expect(queueTab, 'the queue tab did not render').toBeTruthy()
    act(() => queueTab!.click())

    expect(useMusicUi.getState().nowPlayingTab).toBe('queue')
    expect(document.querySelector('[role="tabpanel"]')!.getAttribute('aria-label')).toBe(
      musicText('music.queue.title'),
    )

    const rows = [...document.querySelectorAll<HTMLButtonElement>('.music-queue__main')]
    expect(rows).toHaveLength(2)
    act(() => rows[1]!.click())
    expect(useMusicPlayer.getState().queue.index).toBe(1)
    expect(useMusicPlayer.getState().queue.tracks[1]?.id).toBe(second.id)
  })

  it('closes the queue drawer when it takes over the screen', () => {
    useMusicUi.getState().setQueueOpen(true)
    useMusicUi.getState().setNowPlayingOpen(true, 'queue')
    expect(useMusicUi.getState().queueOpen).toBe(false)
    expect(useMusicUi.getState().nowPlayingTab).toBe('queue')
    useMusicUi.getState().setNowPlayingTab('lyrics')
    expect(useMusicUi.getState().nowPlayingTab).toBe('lyrics')
  })
})

describe('the compact doors into Now Playing', () => {
  it('opens the layer from the MiniPlayer body without swallowing play', () => {
    const open = vi.fn()
    rendered = renderElement(createElement(MiniPlayer, { onOpenNowPlaying: open }))

    const body = buttonByLabel(rendered.container, musicText('music.miniplayer.expand'))
    expect(body, 'the MiniPlayer body has no accessible name').toBeTruthy()
    act(() => body!.click())
    expect(open).toHaveBeenCalledTimes(1)

    const play = buttonByLabel(rendered.container, musicText('music.playbar.play'))
    expect(play, 'the MiniPlayer play control has no accessible name').toBeTruthy()
    act(() => play!.click())
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('opens the lyrics tab from the play bar', () => {
    rendered = renderElement(createElement(PlayBar))
    const lyrics = buttonByLabel(rendered.container, musicText('music.playbar.lyrics'))
    expect(lyrics, 'the play bar lyrics control has no accessible name').toBeTruthy()
    act(() => lyrics!.click())
    expect(useMusicUi.getState().nowPlayingOpen).toBe(true)
    expect(useMusicUi.getState().nowPlayingTab).toBe('lyrics')
    expect(useMusicUi.getState().lyricsOpen).toBe(false)
  })
})

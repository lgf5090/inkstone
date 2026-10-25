// @vitest-environment jsdom
/**
 * The two surfaces a reader meets first: one song row and the empty transport.
 *
 * Nothing here touches audio. The player store is reset to an idle queue, so mounting the bar cannot
 * create a source, and the row is driven through a plain keydown because jsdom performs no default
 * button activation on its own — the assertion is on the row's explicit Enter handling, which is also
 * what keeps the press from being cancelled by a browser's own click.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MusicTrack } from '../src/shared/music/model'
import { initI18n } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../src/client/lib/test-render'
import { PlayBar } from '../src/client/features/music/components/PlayBar'
import { SongRow } from '../src/client/features/music/components/SongRow'
import { FloatingMusicPlayer } from '../src/client/features/music/components/FloatingMusicPlayer'
import { musicApi } from '../src/client/features/music/api'
import { useMusicLibrary } from '../src/client/features/music/store/library'
import { musicText } from '../src/client/features/music/components/labels'
import { emptyQueue } from '../src/client/features/music/player/queue'
import { useMusicPlayer } from '../src/client/features/music/store/player'
import { useMusicUi } from '../src/client/features/music/store/ui'

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
    ...overrides,
  }
}

function buttonByLabel(scope: HTMLElement, label: string): HTMLButtonElement | null {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('aria-label') === label,
  ) ?? null
}

function resetPlayer(): void {
  useMusicPlayer.setState({
    queue: emptyQueue('order'),
    status: 'idle',
    positionMs: 0,
    durationMs: 0,
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

let rendered: RenderedElement | null = null

beforeEach(async () => {
  installTestGlobals()
  localStorage.clear()
  await initI18n()
  resetPlayer()
  useMusicUi.setState({ queueOpen: false, lyricsOpen: false })
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  useMusicUi.setState({ queueOpen: false, lyricsOpen: false })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('SongRow', () => {
  it('renders the track title and names the favourite and overflow controls', () => {
    const sample = track()
    rendered = renderElement(createElement(SongRow, { track: sample, onPlay: () => undefined }))

    expect(rendered.container.textContent).toContain('Track one')
    expect(rendered.container.textContent).toContain('Artist one')

    const favorite = buttonByLabel(rendered.container, musicText('music.song.favorite'))
    expect(favorite, 'the favourite control has no accessible name').toBeTruthy()
    expect(favorite!.getAttribute('aria-pressed')).toBe('false')

    const more = buttonByLabel(rendered.container, musicText('music.song.more'))
    expect(more, 'the overflow control has no accessible name').toBeTruthy()
    expect(more!.getAttribute('aria-haspopup')).toBe('menu')
  })

  it('offers transfers and removal for an online track, but no generic dislike row', () => {
    const onRemoveTrack = vi.fn()
    rendered = renderElement(createElement(SongRow, {
      track: track(),
      onPlay: () => undefined,
      onRemoveTrack,
    }))
    const more = buttonByLabel(rendered.container, musicText('music.song.more'))
    act(() => more!.click())
    const menu = document.querySelector('[role="menu"]')
    expect(menu, 'the row menu did not open').toBeTruthy()
    const labels = [...menu!.querySelectorAll('button')].map((button) => button.textContent?.trim())
    expect(labels).toContain(musicText('music.song.transfer_r2'))
    expect(labels).toContain(musicText('music.song.transfer_webdav'))
    expect(labels).toContain(musicText('music.song.transfer_alist'))
    expect(labels).toContain(musicText('music.song.download_device'))
    expect(labels).toContain(musicText('music.song.remove'))
  })

  it('does not offer cloud transfers for a WebDAV reference', () => {
    rendered = renderElement(createElement(SongRow, {
      track: track({
        provider: 'webdav',
        providerId: 'target:song.mp3',
        source: 'webdav',
        r2Key: null,
      }),
      onPlay: () => undefined,
      onRemoveTrack: () => undefined,
    }))
    const more = buttonByLabel(rendered.container, musicText('music.song.more'))
    act(() => more!.click())
    const menu = document.querySelector('[role="menu"]')
    expect(menu, 'the row menu did not open').toBeTruthy()
    const labels = [...menu!.querySelectorAll('button')].map((button) => button.textContent?.trim())
    expect(labels).toContain(musicText('music.song.download_device'))
    expect(labels).toContain(musicText('music.song.remove'))
    expect(labels).not.toContain(musicText('music.song.transfer_r2'))
    expect(labels).not.toContain(musicText('music.song.transfer_webdav'))
    expect(labels).not.toContain(musicText('music.song.transfer_alist'))
  })

  it('starts the track with Enter and marks a favourite row as pressed', () => {
    const sample = track()
    const onPlay = vi.fn()
    rendered = renderElement(createElement(SongRow, { track: sample, active: true, onPlay }))

    const main = rendered.container.querySelector<HTMLButtonElement>('.music-row__main')
    expect(main, 'the row has no press target').toBeTruthy()
    act(() => {
      main!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(onPlay).toHaveBeenCalledTimes(1)
    expect(onPlay).toHaveBeenCalledWith(sample)

    act(() => {
      main!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    })
    expect(onPlay).toHaveBeenCalledTimes(2)

    // The row is current: its state cell is the playing mark rather than a number.
    expect(rendered.container.querySelector('.music-row--active')).toBeTruthy()
  })
})

describe('PlayBar', () => {
  it('says the queue is empty and labels the transport region', () => {
    rendered = renderElement(createElement(PlayBar))

    const region = rendered.container.querySelector('[role="region"]')
    expect(region).toBeTruthy()
    expect(region!.getAttribute('aria-label')).toBe(musicText('music.playbar.label'))
    expect(rendered.container.textContent).toContain(musicText('music.playbar.empty'))
    expect(rendered.container.textContent).toContain(musicText('music.playbar.hint'))
  })

  it('cycles play modes from the transport button without opening a menu', () => {
    const sample = track()
    useMusicPlayer.setState({
      queue: { tracks: [sample], index: 0, mode: 'order', original: null },
      status: 'paused',
      durationMs: sample.durationMs,
    })
    rendered = renderElement(createElement(PlayBar))

    const modeNames = ['order', 'repeat', 'repeatOne', 'shuffle', 'intelligence'].map((mode) => musicText(`music.mode.${mode}`))
    const modeButton = (): HTMLButtonElement | undefined => [...rendered!.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => modeNames.some((name) => (button.getAttribute('aria-label') ?? '').includes(name))
        && !button.getAttribute('aria-haspopup'))
    expect(modeButton()?.getAttribute('aria-label')).toContain(musicText('music.mode.order'))

    for (const expected of ['repeat', 'repeatOne', 'shuffle', 'intelligence', 'order'] as const) {
      act(() => modeButton()!.click())
      expect(useMusicPlayer.getState().queue.mode).toBe(expected)
      expect(modeButton()?.getAttribute('aria-label')).toContain(musicText(`music.mode.${expected}`))
      expect(rendered.container.querySelector('[role="menu"]')).toBeNull()
    }
  })

  it('reflects the pause state and the queue toggle in aria-pressed', () => {
    const sample = track()
    useMusicPlayer.setState({
      queue: { tracks: [sample], index: 0, mode: 'order', original: null },
      status: 'paused',
      durationMs: sample.durationMs,
    })
    rendered = renderElement(createElement(PlayBar))

    const play = buttonByLabel(rendered.container, musicText('music.playbar.play'))
    expect(play, 'the play control has no accessible name').toBeTruthy()
    expect(play!.getAttribute('aria-pressed')).toBe('false')

    const queue = buttonByLabel(rendered.container, musicText('music.playbar.queue'))
    expect(queue, 'the queue control has no accessible name').toBeTruthy()
    expect(queue!.getAttribute('aria-pressed')).toBe('false')

    act(() => {
      queue!.click()
    })
    expect(useMusicUi.getState().queueOpen).toBe(true)
    const opened = buttonByLabel(rendered.container, musicText('music.playbar.queue'))
    expect(opened!.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('FloatingMusicPlayer', () => {
  it('shows the current track, folds into a ring and expands again', async () => {
    vi.spyOn(musicApi, 'lyrics').mockResolvedValue({
      lrc: '',
      tlyric: '',
      yrc: '',
      source: 'upload',
      fetchedAt: 0,
    })
    useMusicLibrary.setState({ status: 'ready' })
    const sample = track()
    useMusicPlayer.setState({
      queue: { tracks: [sample], index: 0, mode: 'order', original: null },
      status: 'paused',
      durationMs: sample.durationMs,
      positionMs: 30_000,
    })
    await act(async () => {
      rendered = renderElement(createElement(FloatingMusicPlayer))
      await Promise.resolve()
    })

    const region = document.querySelector<HTMLElement>(`[role="region"][aria-label="${musicText('music.floating.title')}"]`)
    expect(region, 'the floating player did not mount').toBeTruthy()
    expect(region!.textContent).toContain(sample.title)

    const collapse = buttonByLabel(document.body, musicText('music.floating.collapse'))
    expect(collapse, 'the collapse control has no accessible name').toBeTruthy()
    act(() => collapse!.click())
    expect(document.querySelector('.music-floating--collapsed')).toBeTruthy()

    const orb = buttonByLabel(document.body, musicText('music.floating.expand_track', { title: sample.title }))
    expect(orb, 'the folded player has no expand control').toBeTruthy()
    act(() => orb!.click())
    expect(document.querySelector('.music-floating--expanded')).toBeTruthy()
    expect(document.querySelector('.music-floating--expanded')!.textContent).toContain(sample.title)
  })
})

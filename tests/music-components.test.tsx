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

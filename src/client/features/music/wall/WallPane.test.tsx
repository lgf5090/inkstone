// @vitest-environment jsdom
/**
 * The wall as a reader uses it: heading and lyric, cover buttons, the 5px press/drag split, the
 * click a drag must swallow, auto-centring, and the window mounted for a long queue.
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MusicTrack } from '@shared/music/model'
import type { MusicLyricResponse } from '@shared/music/api'
import { initI18n } from '../../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../../lib/test-render'
import { musicApi } from '../api'
import { createQueue, emptyQueue } from '../player/queue'
import { useMusicPlayer } from '../store/player'
import { WallPane } from './WallPane'
import { centre, layWall } from './wall-layout'

const VIEWPORT_WIDTH = 400
const VIEWPORT_HEIGHT = 300
const TRACK_COUNT = 20

function makeTrack(index: number): MusicTrack {
  return {
    id: `track-${index}`,
    provider: 'upload',
    providerId: `provider-${index}`,
    kind: 'song',
    title: `Track ${index + 1}`,
    artists: [{ id: 'artist-1', name: 'Artist' }],
    album: 'Album',
    albumId: 'album-1',
    coverUrl: '',
    coverKey: '',
    durationMs: 180_000,
    format: 'flac',
    bitrate: null,
    size: null,
    sha256: '',
    r2Key: null,
    source: '',
    sourceQuality: 'original',
    createdAt: 0,
    updatedAt: 0,
  }
}

const TRACKS = Array.from({ length: TRACK_COUNT }, (_, index) => makeTrack(index))
const LONG_QUEUE = Array.from({ length: 500 }, (_, index) => makeTrack(index))
const INITIAL_PLAYER = useMusicPlayer.getState()

function lyricAnswer(): MusicLyricResponse {
  return {
    lrc: '[00:00.00]First line\n[00:10.00]Second line\n[00:20.00]Third line',
    tlyric: '',
    yrc: '',
    source: 'test',
    fetchedAt: 0,
  }
}

function pointerEvent(type: string, x: number, y: number): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
  })
}

function expectedTransform(index: number): string {
  const point = centre(layWall(TRACK_COUNT, VIEWPORT_WIDTH, VIEWPORT_HEIGHT), index, VIEWPORT_WIDTH, VIEWPORT_HEIGHT)
  return `translate3d(${point.x}px, ${point.y}px, 0)`
}

let rendered: RenderedElement | null = null
let playTrack = vi.fn(async () => true)
let frameRequest = vi.fn(() => 1)

function planeTransform(): string {
  return rendered!.container.querySelector<HTMLElement>('.music-wall__plane')?.style.transform ?? ''
}

function tiles(): HTMLButtonElement[] {
  return [...rendered!.container.querySelectorAll<HTMLButtonElement>('.music-wall__tile')]
}

/** Mount the pane and let the lyric request land, so the tree is quiet before assertions run. */
async function renderWall(): Promise<void> {
  rendered = renderElement(<WallPane />)
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('music-wall')
      ? new DOMRect(0, 0, VIEWPORT_WIDTH, VIEWPORT_HEIGHT)
      : new DOMRect(0, 0, 0, 0)
  })
  vi.spyOn(musicApi, 'lyrics').mockResolvedValue(lyricAnswer())
  frameRequest = vi.fn(() => 1)
  vi.stubGlobal('requestAnimationFrame', frameRequest)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  playTrack = vi.fn(async () => true)
  useMusicPlayer.setState({
    queue: createQueue({ tracks: TRACKS, index: 10 }),
    status: 'paused',
    positionMs: 12_000,
    durationMs: 180_000,
    playTrack,
  })
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  useMusicPlayer.setState({
    queue: emptyQueue(),
    status: 'idle',
    positionMs: 0,
    durationMs: 0,
    playTrack: INITIAL_PLAYER.playTrack,
  })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the wall pane', () => {
  it('names the current track and shows the line being sung and the next one', async () => {
    await renderWall()
    expect(rendered!.container.querySelector('.music-wall__title')?.textContent).toBe('Track 11')
    expect(rendered!.container.querySelector('.music-wall__artist')?.textContent).toBe('Artist')
    expect(rendered!.container.querySelector('.music-wall__lyric-line--current')?.textContent).toBe('Second line')
    expect(rendered!.container.querySelector('.music-wall__lyric-line--next')?.textContent).toBe('Third line')
  })

  it('renders every queue cover as a labelled button and marks only the current one', async () => {
    await renderWall()
    const buttons = tiles()
    expect(buttons).toHaveLength(TRACK_COUNT)
    expect(buttons.every((button) => button.tagName === 'BUTTON' && button.type === 'button')).toBe(true)
    expect(buttons[10]!.getAttribute('aria-current')).toBe('true')
    expect(buttons.filter((button) => button.hasAttribute('aria-current'))).toHaveLength(1)
    expect(buttons[2]!.getAttribute('aria-label')).toContain(TRACKS[2]!.title)

    buttons[3]!.focus()
    expect(document.activeElement).toBe(buttons[3])
  })

  it('plays the pressed cover', async () => {
    await renderWall()
    act(() => {
      tiles()[2]!.click()
    })
    expect(playTrack).toHaveBeenCalledWith(TRACKS[2])
  })

  it('mounts only 200 covers around the current track of a long queue', async () => {
    useMusicPlayer.setState({ queue: createQueue({ tracks: LONG_QUEUE, index: 250 }) })
    await renderWall()
    const buttons = tiles()
    expect(buttons).toHaveLength(200)
    // The window starts at 150, so the playing cover is the 101st button.
    expect(buttons[100]!.getAttribute('aria-current')).toBe('true')
  })

  it('keeps a press under 5px a click and starts dragging at 5px', async () => {
    await renderWall()
    const viewport = rendered!.container.querySelector<HTMLElement>('.music-wall')!
    const initial = planeTransform()
    expect(initial).toBe(expectedTransform(10))

    act(() => {
      viewport.dispatchEvent(pointerEvent('pointerdown', 100, 100))
      viewport.dispatchEvent(pointerEvent('pointermove', 104, 100))
      viewport.dispatchEvent(pointerEvent('pointerup', 104, 100))
    })
    expect(planeTransform()).toBe(initial)

    act(() => {
      tiles()[0]!.click()
    })
    expect(playTrack).toHaveBeenCalledWith(TRACKS[0])

    act(() => {
      viewport.dispatchEvent(pointerEvent('pointerdown', 100, 100))
      viewport.dispatchEvent(pointerEvent('pointermove', 106, 100))
    })
    expect(planeTransform()).not.toBe(initial)
    expect(viewport.dataset.dragging).toBe('true')
  })

  it('swallows the click a drag would otherwise deliver to a cover', async () => {
    await renderWall()
    const viewport = rendered!.container.querySelector<HTMLElement>('.music-wall')!

    act(() => {
      viewport.dispatchEvent(pointerEvent('pointerdown', 100, 100))
      viewport.dispatchEvent(pointerEvent('pointermove', 130, 130))
      viewport.dispatchEvent(pointerEvent('pointerup', 130, 130))
    })
    act(() => {
      tiles()[0]!.click()
    })
    expect(playTrack).not.toHaveBeenCalled()

    act(() => {
      tiles()[0]!.click()
    })
    expect(playTrack).toHaveBeenCalledWith(TRACKS[0])
  })

  it('centres the playing cover again when playback moves', async () => {
    await renderWall()
    expect(planeTransform()).toBe(expectedTransform(10))

    await act(async () => {
      const queue = useMusicPlayer.getState().queue
      useMusicPlayer.setState({ queue: { ...queue, index: 15 } })
      // The new current track starts its own lyric read; let that answer land before assertions.
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(planeTransform()).toBe(expectedTransform(15))
    expect(tiles()[15]!.getAttribute('aria-current')).toBe('true')
  })

  it('hands a release to animation frames, except when reduced motion is requested', async () => {
    await renderWall()
    const viewport = rendered!.container.querySelector<HTMLElement>('.music-wall')!
    act(() => {
      viewport.dispatchEvent(pointerEvent('pointerdown', 100, 100))
      viewport.dispatchEvent(pointerEvent('pointermove', 140, 140))
      viewport.dispatchEvent(pointerEvent('pointerup', 140, 140))
    })
    expect(frameRequest).toHaveBeenCalled()
  })

  it('skips release inertia under reduced motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }))
    await renderWall()
    const viewport = rendered!.container.querySelector<HTMLElement>('.music-wall')!
    act(() => {
      viewport.dispatchEvent(pointerEvent('pointerdown', 100, 100))
      viewport.dispatchEvent(pointerEvent('pointermove', 140, 140))
      viewport.dispatchEvent(pointerEvent('pointerup', 140, 140))
    })
    expect(frameRequest).not.toHaveBeenCalled()
    expect(viewport.dataset.dragging).toBeUndefined()
  })

  it('shows the queue empty state when nothing is playing', async () => {
    useMusicPlayer.setState({ queue: emptyQueue(), status: 'idle' })
    await renderWall()
    expect(rendered!.container.querySelector('.music-wall')).toBeNull()
    expect(rendered!.container.textContent).toContain('The queue is empty')
  })
})

// @vitest-environment jsdom
/**
 * The podcast About pane: the episode description, the show it belongs to, and the way into the
 * comments thread. An episode row saved before programme ids existed cannot open comments, and the
 * pane says so rather than leaving a control that fails.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MusicTrack } from '../src/shared/music/model'
import { initI18n } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../src/client/lib/test-render'
import { musicText } from '../src/client/features/music/components/labels'
import { ProgramPane } from '../src/client/features/music/now-playing/ProgramPane'
import { useMusicUi } from '../src/client/features/music/store/ui'
import { useMusicPlayer } from '../src/client/features/music/store/player'

function program(overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id: 'program-1',
    provider: 'netease',
    providerId: 'song-1',
    kind: 'podcast',
    title: 'Episode one',
    artists: [{ id: 'radio-1', name: 'Show one' }],
    album: 'Show one',
    albumId: 'radio-1',
    coverUrl: '',
    coverKey: '',
    durationMs: 1_800_000,
    format: '',
    bitrate: null,
    size: null,
    sha256: '',
    r2Key: null,
    source: 'netease',
    sourceQuality: '',
    programId: 'program-1',
    description: 'The episode notes.',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function buttonByText(scope: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => (button.textContent ?? '').trim() === text,
  )
}

let rendered: RenderedElement | null = null

beforeEach(async () => {
  installTestGlobals()
  localStorage.clear()
  await initI18n()
  useMusicUi.setState({ nowPlayingTab: 'program' })
  const podcast = program()
  useMusicPlayer.setState({
    queue: { tracks: [podcast], index: 0, mode: 'order', original: null },
    status: 'paused',
    positionMs: 0,
    durationMs: podcast.durationMs,
  })
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  useMusicPlayer.setState({
    queue: { tracks: [], index: -1, mode: 'order', original: null },
    status: 'idle',
  })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ProgramPane', () => {
  it('shows the description, links to the show and opens the comments tab', async () => {
    window.history.replaceState(null, '', '/music')
    rendered = renderElement(createElement(ProgramPane))

    expect(rendered.container.textContent).toContain('The episode notes.')
    expect(rendered.container.textContent).toContain('Episode one')

    act(() => buttonByText(rendered!.container, 'Show one')!.click())
    expect(window.location.pathname).toBe('/music/podcast/radio-1')

    const comments = buttonByText(rendered.container, musicText('music.comments.title'))!
    expect(comments.disabled).toBe(false)
    act(() => comments.click())
    expect(useMusicUi.getState().nowPlayingTab).toBe('comments')
  })

  it('explains why an episode without a programme id cannot open comments', () => {
    const podcast = program({ programId: undefined })
    useMusicPlayer.setState({
      queue: { tracks: [podcast], index: 0, mode: 'order', original: null },
      durationMs: podcast.durationMs,
    })
    rendered = renderElement(createElement(ProgramPane))

    const comments = buttonByText(rendered.container, musicText('music.comments.title'))!
    expect(comments.disabled).toBe(true)
    expect(rendered.container.textContent).toContain(musicText('music.program.comments_unavailable'))
  })
})

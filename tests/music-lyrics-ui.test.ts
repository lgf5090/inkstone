// @vitest-environment jsdom
import { act, createElement, useRef, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeLyricTranslation, parseLyrics, type LyricLine } from '../src/shared/music/lyrics'
import { renderElement } from '../src/client/lib/test-render'
import {
  activeLyricLine,
  clampLyricOffset,
  formatLyricOffset,
  lyricOffsetStorageKey,
  lyricTextOf,
  LyricLineContent,
  MUSIC_LYRIC_OFFSET_LIMIT_MS,
  MUSIC_LYRIC_OFFSET_STEP_MS,
  readLyricOffset,
  useTrackLyrics,
  writeLyricOffset,
} from '../src/client/features/music/components/LyricPanel'
import { musicApi } from '../src/client/features/music/api'
import type { MusicTrack } from '../src/shared/music/model'
import { KaraokeLine } from '../src/client/features/music/lyrics/karaoke-line'
import {
  LYRIC_ACTIVE_LINE_RATIO,
  lyricScrollTop,
  useActiveLineScroll,
} from '../src/client/features/music/lyrics/lyrics-scroll'
import { musicAudioEngine } from '../src/client/features/music/player/engine'

function wordLine(): LyricLine {
  const parsed = parseLyrics('[1000,2000](1000,500,0)Hello (1500,750,0)world')
  if (!parsed.ok) throw new Error('fixture did not parse')
  return parsed.data.lines[0]!
}

function trackFixture(kind: 'song' | 'podcast'): MusicTrack {
  return {
    id: `${kind}-1`,
    provider: 'netease',
    providerId: '1',
    kind,
    title: 'Track',
    artists: [{ id: 'a', name: 'Artist' }],
    album: 'Album',
    albumId: 'album-1',
    coverUrl: '',
    coverKey: '',
    durationMs: 1_000,
    format: 'mp3',
    bitrate: 320_000,
    size: 1_000,
    sha256: '',
    r2Key: null,
    source: 'netease',
    sourceQuality: 'lossless',
    createdAt: 0,
    updatedAt: 1,
  }
}

function LyricsProbe({ track }: { track: MusicTrack }): ReactElement {
  const lyric = useTrackLyrics(track)
  return createElement('span', { 'data-status': lyric.status }, String(lyric.lines.length))
}

describe('music lyrics UI model', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('prefers word-timed YRC and falls back to LRC when it is blank', () => {
    expect(lyricTextOf({ lrc: '[00:01.00]line', yrc: '[1000,500](0,500,0)word' })).toContain('(0,500,0)')
    expect(lyricTextOf({ lrc: '[00:01.00]line', yrc: '   ' })).toBe('[00:01.00]line')
  })

  it('skips the lyrics request for a podcast episode', () => {
    const spy = vi.spyOn(musicApi, 'lyrics').mockResolvedValue({
      lrc: '[00:01.00]line',
      tlyric: '',
      yrc: '',
      source: 'netease',
      fetchedAt: 1,
    })
    const songRender = renderElement(createElement(LyricsProbe, { track: trackFixture('song') }))
    try {
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith('song-1')
    } finally {
      songRender.unmount()
    }
    spy.mockClear()
    const podcastRender = renderElement(createElement(LyricsProbe, { track: trackFixture('podcast') }))
    try {
      expect(spy).not.toHaveBeenCalled()
      expect(podcastRender.container.textContent).toBe('0')
      expect(podcastRender.container.firstElementChild?.getAttribute('data-status')).toBe('ready')
    } finally {
      podcastRender.unmount()
      spy.mockRestore()
    }
  })

  it('keeps translation rows when the original is word-timed', () => {
    const original = parseLyrics('[1000,2000](1000,500,0)Hello (1500,500,0)world')
    expect(original.ok).toBe(true)
    if (!original.ok) return
    const lines = mergeLyricTranslation(original.data.lines, '[00:01.00]Ni hao shijie')
    expect(lines[0]?.words).toHaveLength(2)
    expect(lines[0]?.translation).toBe('Ni hao shijie')
  })

  it('moves the active line by the offset, including before the first line', () => {
    const parsed = parseLyrics('[00:01.00]one\n[00:05.00]two')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const lines = parsed.data.lines
    expect(activeLyricLine(lines, 4_000, 0)).toBe(0)
    expect(activeLyricLine(lines, 4_000, MUSIC_LYRIC_OFFSET_STEP_MS)).toBe(1)
    expect(activeLyricLine(lines, 1_000, -MUSIC_LYRIC_OFFSET_STEP_MS)).toBe(-1)
    expect(activeLyricLine(lines, 5_000, -MUSIC_LYRIC_OFFSET_STEP_MS)).toBe(0)
  })

  it('paints the word under the playhead instead of waiting for the next timeupdate', () => {
    const parsed = parseLyrics('[1000,2000](1000,500,0)Hello (1500,750,0)world')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const line = parsed.data.lines[0]!
    const rendered = renderElement(createElement(LyricLineContent, {
      line,
      timeMs: 1_250,
      wordByWord: true,
    }))
    try {
      const singing = rendered.container.querySelector<HTMLElement>('.music-lyric-word--singing')
      expect(singing?.textContent).toContain('Hello')
      expect(singing?.style.getPropertyValue('--music-word-progress')).toBe('50.0%')
      expect(rendered.container.querySelectorAll('.music-lyric-word--pending')).toHaveLength(1)
    } finally {
      rendered.unmount()
    }

    const later = renderElement(createElement(LyricLineContent, {
      line,
      timeMs: 1_700,
      wordByWord: true,
    }))
    try {
      const singing = later.container.querySelector<HTMLElement>('.music-lyric-word--singing')
      expect(singing?.textContent).toContain('world')
      expect(later.container.querySelectorAll('.music-lyric-word--sung')).toHaveLength(1)
      expect(later.container.querySelectorAll('.music-lyric-word--pending')).toHaveLength(0)
    } finally {
      later.unmount()
    }
  })

  it('clamps the offset to the offered range and formats it signed', () => {
    expect(clampLyricOffset(12_345)).toBe(MUSIC_LYRIC_OFFSET_LIMIT_MS)
    expect(clampLyricOffset(-20_000)).toBe(-MUSIC_LYRIC_OFFSET_LIMIT_MS)
    expect(clampLyricOffset(Number.NaN)).toBe(0)
    expect(formatLyricOffset(0)).toBe('0.0s')
    expect(formatLyricOffset(1_000)).toBe('+1.0s')
    expect(formatLyricOffset(-500)).toBe('-0.5s')
  })

  it('round-trips a per-track offset and clamps a stale record on read', () => {
    const key = lyricOffsetStorageKey('netease:42')
    expect(key).toContain('netease:42')
    writeLyricOffset('netease:42', 2_500)
    expect(readLyricOffset('netease:42')).toBe(2_500)
    writeLyricOffset('netease:42', 99_999)
    expect(readLyricOffset('netease:42')).toBe(MUSIC_LYRIC_OFFSET_LIMIT_MS)
    localStorage.setItem(key, 'not-a-number')
    expect(readLyricOffset('netease:42')).toBe(0)
  })
})

describe('karaoke line rendering', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates word spans only when asked and keeps the plain text otherwise', () => {
    const line = wordLine()
    const plain = renderElement(createElement(LyricLineContent, {
      line,
      timeMs: 1_250,
      wordByWord: false,
    }))
    try {
      expect(plain.container.querySelectorAll('.music-lyric-word')).toHaveLength(0)
      expect(plain.container.textContent).toBe('Hello world')
    } finally {
      plain.unmount()
    }

    const karaoke = renderElement(createElement(KaraokeLine, {
      line,
      timeMs: 1_250,
      playing: false,
    }))
    try {
      expect(karaoke.container.querySelectorAll('.music-lyric-word')).toHaveLength(2)
    } finally {
      karaoke.unmount()
    }
  })

  // One loop for the line, not one per word: the frame callback writes the fill straight to the DOM
  // instead of re-rendering React for every animation frame.
  it('schedules one animation frame while playing and fills the word in place', () => {
    const line = wordLine()
    let frame: FrameRequestCallback | null = null
    const raf = vi.fn((callback: FrameRequestCallback) => {
      frame = callback
      return 1
    })
    vi.stubGlobal('requestAnimationFrame', raf)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(musicAudioEngine, 'currentTimeMs').mockReturnValue(1_700)

    const rendered = renderElement(createElement(KaraokeLine, {
      line,
      timeMs: 1_000,
      playing: true,
    }))
    try {
      expect(raf).toHaveBeenCalledTimes(1)
      act(() => frame?.(0))
      const singing = rendered.container.querySelector<HTMLElement>('.music-lyric-word--singing')
      expect(singing?.textContent).toContain('world')
      expect(rendered.container.querySelectorAll('.music-lyric-word--sung')).toHaveLength(1)
      // The loop re-arms exactly once; words never schedule frames of their own.
      expect(raf).toHaveBeenCalledTimes(2)
    } finally {
      rendered.unmount()
      vi.unstubAllGlobals()
    }
  })

  it('does not schedule frames while paused', () => {
    const raf = vi.fn(() => 1)
    vi.stubGlobal('requestAnimationFrame', raf)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const rendered = renderElement(createElement(KaraokeLine, {
      line: wordLine(),
      timeMs: 1_250,
      playing: false,
    }))
    try {
      expect(raf).not.toHaveBeenCalled()
    } finally {
      rendered.unmount()
      vi.unstubAllGlobals()
    }
  })

  it('follows the engine timeupdate at four hertz when reduced motion is requested', () => {
    stubReducedMotion()
    const subscribe = vi.spyOn(musicAudioEngine, 'subscribe')
    const raf = vi.fn(() => 1)
    vi.stubGlobal('requestAnimationFrame', raf)
    const rendered = renderElement(createElement(KaraokeLine, {
      line: wordLine(),
      timeMs: 1_000,
      playing: true,
    }))
    try {
      expect(subscribe).toHaveBeenCalledWith('timeupdate', expect.any(Function))
      expect(raf).not.toHaveBeenCalled()
    } finally {
      rendered.unmount()
      vi.unstubAllGlobals()
    }
  })
})

function stubReducedMotion(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }))
}

describe('active line scrolling', () => {
  it('targets 40 % of the viewport and never scrolls above the list', () => {
    expect(LYRIC_ACTIVE_LINE_RATIO).toBe(0.4)
    expect(lyricScrollTop(1_000, 500)).toBe(800)
    expect(lyricScrollTop(100, 500)).toBe(0)
    expect(lyricScrollTop(1_000, 500, 0.5)).toBe(750)
  })

  function ScrollHarness({ active, trackKey }: { active: number, trackKey: string }): ReactElement {
    const ref = useRef<HTMLDivElement>(null)
    useActiveLineScroll(ref, active, trackKey)
    return createElement('div', { ref, 'data-testid': 'scroll' },
      createElement('div', { 'data-lyric-active': active === 0 ? 'true' : undefined }, 'a'),
      createElement('div', { 'data-lyric-active': active === 1 ? 'true' : undefined }, 'b'))
  }

  // Both tracks start on line 0, so the index did not change and the old effect left the reader at
  // the previous track's scroll offset.
  it('returns to the top when the track changes even if the active index is unchanged', () => {
    const rendered = renderElement(createElement(ScrollHarness, { active: 0, trackKey: 'a' }))
    try {
      const scroll = rendered.container.querySelector<HTMLElement>('[data-testid="scroll"]')!
      scroll.scrollTop = 500
      rendered.rerender(createElement(ScrollHarness, { active: 0, trackKey: 'b' }))
      expect(scroll.scrollTop).toBe(0)
    } finally {
      rendered.unmount()
    }
  })
})

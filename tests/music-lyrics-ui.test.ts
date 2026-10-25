// @vitest-environment jsdom
import { createElement } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { mergeLyricTranslation, parseLyrics } from '../src/shared/music/lyrics'
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
  writeLyricOffset,
} from '../src/client/features/music/components/LyricPanel'

describe('music lyrics UI model', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('prefers word-timed YRC and falls back to LRC when it is blank', () => {
    expect(lyricTextOf({ lrc: '[00:01.00]line', yrc: '[1000,500](0,500,0)word' })).toContain('(0,500,0)')
    expect(lyricTextOf({ lrc: '[00:01.00]line', yrc: '   ' })).toBe('[00:01.00]line')
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

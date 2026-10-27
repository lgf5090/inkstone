// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  lyricWordStateAt,
  lyricWordTimings,
  parseLyrics,
  synthesizeWordTimings,
  type LyricLine,
} from '../src/shared/music/lyrics'

function line(fullText: string, duration = 4_000, startTime = 1_000): LyricLine {
  return { startTime, duration, fullText, words: [] }
}

describe('estimated word rhythm for LRC-only lines', () => {
  // Singing takes most of a line, not the pause before the next one: the last token ends at 85 % of
  // the line box instead of being stretched over the silence that follows.
  it('shares only 85 % of a CJK line and leaves the tail empty', () => {
    const words = synthesizeWordTimings(line('\u4f60\u597d\u4e16\u754c'))
    expect(words.map((word) => word.text)).toEqual(['\u4f60', '\u597d', '\u4e16', '\u754c'])
    expect(words.map((word) => word.startTime)).toEqual([1_000, 1_850, 2_700, 3_550])
    expect(words.map((word) => word.duration)).toEqual([850, 850, 850, 850])
    expect(words.at(-1)!.startTime + words.at(-1)!.duration).toBe(4_400)
  })

  it('cuts Latin text by word, keeps punctuation on the word before it and marks the space', () => {
    const words = synthesizeWordTimings(line('Hello, brave world!'))
    expect(words.map((word) => word.text)).toEqual(['Hello,', 'brave', 'world!'])
    expect(words[0]!.space).toBe(true)
    expect(words[1]!.space).toBe(true)
    expect(words[2]!.space).toBeUndefined()
    // Weights 6 / 5 / 6 over 85 % of 4000 ms.
    expect(words.map((word) => word.duration)).toEqual([1_200, 1_000, 1_200])
    expect(words.at(-1)!.startTime + words.at(-1)!.duration).toBe(4_400)
  })

  it('mixes scripts and never lets the last word outlive the line', () => {
    const words = synthesizeWordTimings(line('Hi \u4f60\u597d', 3_000))
    expect(words.map((word) => word.text)).toEqual(['Hi', '\u4f60', '\u597d'])
    expect(words.at(-1)!.startTime + words.at(-1)!.duration).toBe(3_550)
    for (const word of words) {
      expect(word.startTime).toBeGreaterThanOrEqual(1_000)
      expect(word.startTime + word.duration).toBeLessThanOrEqual(4_000)
    }
  })

  it('returns nothing for an empty line and zero-duration words for a zero-length line', () => {
    expect(synthesizeWordTimings(line('   '))).toEqual([])
    const words = synthesizeWordTimings(line('\u4f60\u597d', 0))
    expect(words).toHaveLength(2)
    expect(words.every((word) => word.duration === 0 && word.startTime === 1_000)).toBe(true)
  })

  it('keeps a punctuation-only line as a token instead of dropping it', () => {
    const words = synthesizeWordTimings(line('\u2026\u2026', 1_000))
    expect(words).toHaveLength(1)
    expect(words[0]!.text).toBe('\u2026\u2026')
    expect(words[0]!.duration).toBe(850)
  })

  it('reports the word under the playhead and how far through it the voice is', () => {
    const parsed = parseLyrics('[1000,2000](1000,500,0)Hello (1500,750,0)world')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const words = parsed.data.lines[0]!.words
    expect(lyricWordStateAt(words, 999)).toEqual({ index: -1, progress: 0 })
    expect(lyricWordStateAt(words, 1_000)).toEqual({ index: 0, progress: 0 })
    expect(lyricWordStateAt(words, 1_250)).toEqual({ index: 0, progress: 0.5 })
    expect(lyricWordStateAt(words, 1_500)).toEqual({ index: 1, progress: 0 })
    expect(lyricWordStateAt(words, 2_250)).toEqual({ index: 1, progress: 1 })
    expect(lyricWordStateAt(words, 3_000)).toEqual({ index: 1, progress: 1 })
    expect(lyricWordStateAt([], 3_000)).toEqual({ index: -1, progress: 0 })
    expect(lyricWordStateAt([{ text: 'x', startTime: 1_000, duration: 0 }], 1_000))
      .toEqual({ index: 0, progress: 1 })
  })

  // A playhead only moves forward, so the state it reads must never step back or leave [0, 1].
  it('stays monotonic and clamps outside the line', () => {
    const words = [
      { text: 'a', startTime: 1_000, duration: 500 },
      { text: 'b', startTime: 1_500, duration: 0 },
      { text: 'c', startTime: 2_000, duration: 400 },
    ]
    let previous = -1
    for (const time of [-5_000, 0, 999, 1_000, 1_249, 1_500, 1_999, 2_000, 2_200, 2_400, 9_000]) {
      const state = lyricWordStateAt(words, time)
      expect(state.index).toBeGreaterThanOrEqual(previous)
      expect(state.progress).toBeGreaterThanOrEqual(0)
      expect(state.progress).toBeLessThanOrEqual(1)
      previous = state.index
    }
    expect(lyricWordStateAt(words, -5_000)).toEqual({ index: -1, progress: 0 })
    expect(lyricWordStateAt(words, 9_000)).toEqual({ index: 2, progress: 1 })
    expect(lyricWordStateAt(words, Number.NaN)).toEqual({ index: -1, progress: 0 })
  })

  it('flags an estimate when the provider had no word timing and keeps real timing when it did', () => {
    const parsed = parseLyrics('[00:01.00]one\n[00:03.00]two')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const estimated = lyricWordTimings(parsed.data.lines[0]!)
    expect(estimated.estimated).toBe(true)
    expect(estimated.words.map((word) => word.text)).toEqual(['one'])

    const timed = parseLyrics('[1000,2000](1000,500,0)Hello (1500,750,0)world')
    expect(timed.ok).toBe(true)
    if (!timed.ok) return
    const provider = lyricWordTimings(timed.data.lines[0]!)
    expect(provider.estimated).toBe(false)
    expect(provider.words).toBe(timed.data.lines[0]!.words)
  })
})

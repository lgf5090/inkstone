// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  findActiveLineIndex,
  isCreditLine,
  isInstrumentalLyrics,
  lyricQuiets,
  mergeLyricTranslation,
  parseLyrics,
} from '../src/shared/music/lyrics'

describe('music lyric parsing', () => {
  it('parses LRC lines and fills each duration from the next line', () => {
    const result = parseLyrics('[00:01.00]first\n[00:03.50]second\n[00:06.00]third')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.lines).toHaveLength(3)
    expect(result.data.lines[0]).toMatchObject({ startTime: 1000, duration: 2500, fullText: 'first' })
    expect(result.data.lines[2]).toMatchObject({ startTime: 6000, duration: 3000 })
  })

  // This used to read only the first timestamp and keep the rest as text, so a chorus tagged for
  // several repeats showed up once with "[00:05.00]chorus" as its words.
  it('expands several timestamps on one LRC line into one line each', () => {
    const result = parseLyrics('[00:01.00][00:05.00][00:09.00]chorus\n[00:12.00]outro')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.lines.map((line) => line.fullText)).toEqual(['chorus', 'chorus', 'chorus', 'outro'])
    expect(result.data.lines.map((line) => line.startTime)).toEqual([1000, 5000, 9000, 12000])
    expect(result.data.lines.every((line) => !line.fullText.includes('['))).toBe(true)
  })

  // Metadata tags are not lyrics and must not count towards the "mostly malformed" threshold.
  it('ignores LRC metadata tags instead of treating them as malformed lyrics', () => {
    const result = parseLyrics([
      '[by:someone]',
      '[ar:artist]',
      '[ti:title]',
      '[al:album]',
      '[offset:500]',
      '[00:01.00]line',
    ].join('\n'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.lines.map((line) => line.fullText)).toEqual(['line'])
  })

  it('parses YRC word timing and keeps inter-word spaces', () => {
    const result = parseLyrics('[1000,2000](1000,500,0)Hello (1500,750,0)world')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const line = result.data.lines[0]
    expect(line?.fullText).toBe('Hello world')
    expect(line?.words).toEqual([
      { text: 'Hello', startTime: 1_000, duration: 500, space: true },
      { text: 'world', startTime: 1_500, duration: 750 },
    ])
  })

  // An empty YRC box used to become a lyric line with no text and no words, which the panel then
  // highlighted as the active line.
  it('drops empty and whitespace-only YRC boxes', () => {
    const result = parseLyrics('[1000,2000]\n[2000,1000](2000,500,0)   \n[3000,1000](3000,500,0)real')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.lines.map((line) => line.fullText)).toEqual(['real'])
  })

  // The line's text has to be exactly the words the renderer paints, otherwise a word-timed line
  // shows one string and highlights another.
  it('builds fullText from the same words and spaces the renderer uses', () => {
    const result = parseLyrics('[1000,1000](1000,300,0)Hi (1300,200,0)there (1500,400,0)friend')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const line = result.data.lines[0]!
    const joined = line.words.map((word) => `${word.text}${word.space ? ' ' : ''}`).join('').trim()
    expect(line.fullText).toBe(joined)
    expect(line.fullText).toBe('Hi there friend')
  })

  it('reads metadata lines without letting them become lyrics', () => {
    const result = parseLyrics('{"t":0,"c":[{"tx":"meta"}]}\n[00:01.00]line')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.metadata).toEqual([{ time: 0, content: 'meta' }])
    expect(result.data.lines.map((line) => line.fullText)).toEqual(['line'])
  })

  it('attaches a translation by timestamp', () => {
    const original = parseLyrics('[00:01.00]one\n[00:03.00]two')
    expect(original.ok).toBe(true)
    if (!original.ok) return
    const merged = mergeLyricTranslation(original.data.lines, '[00:01.05]uno\n[00:03.00]dos')
    expect(merged[0]?.translation).toBe('uno')
    expect(merged[1]?.translation).toBe('dos')
  })

  it('finds the active line and ignores untimed labels', () => {
    const result = parseLyrics('label\n[00:01.00]one\n[00:05.00]two')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const lines = result.data.lines
    expect(findActiveLineIndex(lines, 0)).toBe(-1)
    expect(lines[findActiveLineIndex(lines, 1500)]?.fullText).toBe('one')
    expect(lines[findActiveLineIndex(lines, 6000)]?.fullText).toBe('two')
  })

  it('reports input that is mostly malformed instead of pretending it parsed', () => {
    const result = parseLyrics('[nonsense\n[also nonsense\n[00:01.00]ok')
    expect(result.ok).toBe(false)
  })
})

describe('credit lines', () => {
  it('recognises Chinese and English credit heads but not lyrics that merely contain a colon', () => {
    expect(isCreditLine('\u4f5c\u8bcd : Someone')).toBe(true)
    expect(isCreditLine('\u4f5c\u66f2: Someone')).toBe(true)
    expect(isCreditLine('Lyricist: Someone')).toBe(true)
    expect(isCreditLine('Producer : Someone')).toBe(true)
    expect(isCreditLine('I said: hello')).toBe(false)
    expect(isCreditLine('https://example.com')).toBe(false)
  })

  // Credits are labels, not sung lines: keeping them in the document made them active at 0 ms and
  // also hid the intro from the quiet stretch calculation.
  it('keeps credit rows out of the parsed lyric lines', () => {
    const result = parseLyrics([
      '[00:00.00]\u4f5c\u8bcd : Someone',
      '[00:00.00]Composer: Someone',
      '[00:12.00]first sung line',
    ].join('\n'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.lines.map((line) => line.fullText)).toEqual(['first sung line'])
    expect(findActiveLineIndex(result.data.lines, 0)).toBe(-1)
  })

  it('removes credit rows from word-timed lyrics as well', () => {
    const result = parseLyrics('[0,1000]\u4f5c\u8bcd: Someone\n[1000,1000](1000,500,0)real')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.lines.map((line) => line.fullText)).toEqual(['real'])
  })

  it('skips credits when it finds the quiet stretches of a song', () => {
    const parsed = parseLyrics([
      '[00:00.00]\u4f5c\u8bcd: Someone',
      '[00:10.00]one',
      '[00:20.00]two',
    ].join('\n'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    // The credit row is not sung, so the first ten seconds are an intro; the last line runs 3 s
    // past its start and leaves the outro quiet.
    expect(lyricQuiets(parsed.data.lines, 40_000)).toEqual([
      { from: 0, to: 10_000 },
      { from: 23_000, to: 40_000 },
    ])
  })
})

describe('quiet stretches', () => {
  const lines = [
    { startTime: 10_000, duration: 4_000, fullText: 'one', words: [] },
    { startTime: 30_000, duration: 4_000, fullText: 'two', words: [] },
  ]

  it('returns the intro, the interlude and the outro above the minimum', () => {
    expect(lyricQuiets(lines, 60_000)).toEqual([
      { from: 0, to: 10_000 },
      { from: 14_000, to: 30_000 },
      { from: 34_000, to: 60_000 },
    ])
  })

  it('drops stretches shorter than the minimum, including a custom minimum', () => {
    const packed = [
      { startTime: 4_000, duration: 1_000, fullText: 'one', words: [] },
      { startTime: 8_000, duration: 1_000, fullText: 'two', words: [] },
    ]
    expect(lyricQuiets(packed, 20_000)).toEqual([
      { from: 0, to: 4_000 },
      { from: 5_000, to: 8_000 },
      { from: 9_000, to: 20_000 },
    ])
    expect(lyricQuiets(packed, 20_000, 4_000)).toEqual([
      { from: 0, to: 4_000 },
      { from: 9_000, to: 20_000 },
    ])
  })

  it('treats a lyric-less track as one quiet stretch when it is long enough', () => {
    expect(lyricQuiets([], 30_000)).toEqual([{ from: 0, to: 30_000 }])
    expect(lyricQuiets([], 7_000)).toEqual([])
    expect(lyricQuiets([], 0)).toEqual([])
  })
})

describe('instrumental marker', () => {
  it('recognises a pure-music marker as an instrumental track', () => {
    const parsed = parseLyrics('[00:00.00]\u7eaf\u97f3\u4e50\uff0c\u8bf7\u6b23\u8d4f')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(isInstrumentalLyrics(parsed.data.lines)).toBe(true)
  })

  it('also recognises an English instrumental marker', () => {
    const parsed = parseLyrics('[00:00.00]Instrumental')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(isInstrumentalLyrics(parsed.data.lines)).toBe(true)
  })

  it('does not call a track instrumental when a real lyric line exists', () => {
    const parsed = parseLyrics('[00:00.00]Instrumental\n[00:10.00]a real line')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(isInstrumentalLyrics(parsed.data.lines)).toBe(false)
    expect(isInstrumentalLyrics([])).toBe(false)
  })
})

// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  findActiveLineIndex,
  isInstrumentalLyrics,
  lyricQuiets,
  lyricWordTimings,
  mergeLyricTranslation,
  parseLyrics,
} from '../src/shared/music/lyrics'

// Synthetic provider payloads only: no real track's words are copied into the suite.
const LRC = [
  '[ti:Synthetic Song]',
  '[ar:Synthetic Artist]',
  '[al:Synthetic Album]',
  '[by:Synthetic Author]',
  '[offset:0]',
  '[00:00.00]Lyricist: Synthetic Author',
  '[00:08.00]first line',
  '[00:14.00][00:20.00]repeated line',
  '[00:26.00]last line',
].join('\n')

describe('lyric parity surface', () => {
  it('parses a full provider lyric with credits, metadata and repeated timestamps', () => {
    const parsed = parseLyrics(LRC)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.data.lines.map((line) => [line.startTime, line.fullText])).toEqual([
      [8_000, 'first line'],
      [14_000, 'repeated line'],
      [20_000, 'repeated line'],
      [26_000, 'last line'],
    ])
    expect(findActiveLineIndex(parsed.data.lines, 0)).toBe(-1)
    expect(findActiveLineIndex(parsed.data.lines, 21_000)).toBe(2)
  })

  it('leaves an eight second intro quiet and drops the short gaps around a chorus', () => {
    const parsed = parseLyrics(LRC)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(lyricQuiets(parsed.data.lines, 30_000)).toEqual([{ from: 0, to: 8_000 }])
  })

  it('merges a provider translation onto the repeated line at both timestamps', () => {
    const parsed = parseLyrics(LRC)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const merged = mergeLyricTranslation(parsed.data.lines, [
      '[00:08.00]translated first',
      '[00:14.00]translated repeat',
      '[00:20.00]translated repeat',
    ].join('\n'))
    expect(merged.map((line) => line.translation)).toEqual([
      'translated first',
      'translated repeat',
      'translated repeat',
      undefined,
    ])
  })

  it('keeps word-timed text and translations aligned after an empty YRC box', () => {
    const yrc = [
      '[0,4000]',
      '[4000,2000](4000,500,0)Hello (4500,500,0)there',
      '[6000,2000](6000,500,0)   ',
      '[8000,2000](8000,500,0)Good (8500,500,0)night',
    ].join('\n')
    const parsed = parseLyrics(yrc)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.data.lines.map((line) => line.fullText)).toEqual(['Hello there', 'Good night'])
    for (const line of parsed.data.lines) {
      const joined = line.words.map((word) => `${word.text}${word.space ? ' ' : ''}`).join('').trim()
      expect(line.fullText).toBe(joined)
      expect(lyricWordTimings(line).estimated).toBe(false)
    }
  })

  it('reports an instrumental marker as pure music instead of an empty lyric', () => {
    const parsed = parseLyrics('[00:00.00]\u7eaf\u97f3\u4e50\uff0c\u8bf7\u6b23\u8d4f')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(isInstrumentalLyrics(parsed.data.lines)).toBe(true)
    expect(lyricQuiets(parsed.data.lines, 30_000)).toEqual([{ from: 0, to: 30_000 }])
  })
})

// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { findActiveLineIndex, mergeLyricTranslation, parseLyrics } from '../src/shared/music/lyrics'

describe('music lyric parsing', () => {
  it('parses LRC lines and fills each duration from the next line', () => {
    const result = parseLyrics('[00:01.00]first\n[00:03.50]second\n[00:06.00]third')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.lines).toHaveLength(3)
    expect(result.data.lines[0]).toMatchObject({ startTime: 1000, duration: 2500, fullText: 'first' })
    expect(result.data.lines[2]).toMatchObject({ startTime: 6000, duration: 3000 })
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

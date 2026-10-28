// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { partitaRows, PARTITA_MAX_ROWS } from '../src/client/features/music/stage/partita-layout'
import {
  STAGE_OUTGOING_MS,
  STAGE_SPARK_WINDOW_MS,
  stageLineProgress,
  stageSparkBursts,
  stageUnits,
  stageWordPhase,
  stageWordState,
  wordShapes,
} from '../src/client/features/music/stage/stage-math'
import { splitParts, tiltParts } from '../src/client/features/music/stage/tilt-layout'

describe('stage layout math', () => {
  it('gives a line the same word shapes every time it is shown', () => {
    const first = wordShapes(6, 12_345)
    const second = wordShapes(6, 12_345)
    expect(first).toEqual(second)
    expect(first).toHaveLength(6)
    expect(first.some((shape) => shape.scale !== first[0]!.scale)).toBe(true)
  })

  it('splits words with their spaces into display units', () => {
    const units = stageUnits({ fullText: 'one two three', startTime: 0, duration: 3000, words: [] })
    expect(units.map((unit) => unit.text.trim())).toEqual(['one', 'two', 'three'])
    expect(units.slice(0, 2).every((unit) => unit.space)).toBe(true)
  })

  it('keeps every character when it breaks a line into staged rows', () => {
    const text = 'a fairly long synthetic line for the stair layout'
    const rows = partitaRows({ fullText: text })
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.length).toBeLessThanOrEqual(PARTITA_MAX_ROWS)
    expect(rows.map((row) => row.text).join(' ').replace(/\s+/g, ' ').trim()).toContain('synthetic')
  })

  it('keeps the end of a line in the final tilt part', () => {
    const text = 'first part, second part, third part'
    const parts = splitParts(text, 3)
    expect(parts).toHaveLength(3)
    expect(parts.join(' ').replace(/\s+/g, ' ').trim()).toBe(text)
    const staged = tiltParts({ fullText: text, startTime: 0 })
    expect(staged.length).toBeLessThanOrEqual(4)
    expect(staged.at(-1)?.text).toContain('third')
  })

  it('moves the word phase forward and clamps the line progress', () => {
    expect(stageWordPhase(0, -1)).toBe('waiting')
    expect(stageWordPhase(0, 0)).toBe('singing')
    expect(stageWordPhase(0, 1)).toBe('sung')
    expect(stageWordState([
      { text: 'a', startTime: 100, duration: 100 },
      { text: 'b', startTime: 200, duration: 0 },
    ], 150)).toEqual({ index: 0, progress: 0.5 })
    expect(stageLineProgress({ startTime: 1000, duration: 1000 }, -50)).toBe(0)
    expect(stageLineProgress({ startTime: 1000, duration: 1000 }, 3000)).toBe(1)
    expect(STAGE_OUTGOING_MS).toBeGreaterThan(0)
    expect(STAGE_SPARK_WINDOW_MS).toBe(600)
    const sparks = [{ startTime: 1_000 }, { startTime: 1_500 }]
    expect(stageSparkBursts(sparks, 900)).toEqual([])
    expect(stageSparkBursts(sparks, 1_100).map((burst) => burst.index)).toEqual([0])
  })
})

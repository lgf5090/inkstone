// The seeded arithmetic behind the stage.
//
// A lyric line has to look alive without looking random on every render. Every shape here is a pure
// function of the line's own start time, so a line that scrolls back into view looks the way it did
// the first time. Nothing in this module touches the DOM or React.
import {
  lyricWordTimings,
  type LyricLine,
  type LyricWord,
  type LyricWordState,
  lyricWordStateAt,
} from '@shared/music/lyrics'

/** How long a word keeps throwing sparks after it begins. */
export const STAGE_SPARK_WINDOW_MS = 600

/** How long the previous line stays on screen while it fades. */
export const STAGE_OUTGOING_MS = 600

const CJK_CHARACTER = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
const LATIN_WORD_END = /[A-Za-z0-9]/

/** A deterministic 32-bit hash for a line seed. */
export function hashSeed(seed: number | string): number {
  if (typeof seed === 'number') {
    if (!Number.isFinite(seed)) return 0
    return (Math.trunc(seed) ^ 0x9e3779b9) >>> 0
  }
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** A mulberry32 generator; the same seed always produces the same sequence. */
export function lineRandom(seed: number | string): () => number {
  let state = hashSeed(seed)
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

export interface SpringState {
  value: number
  velocity: number
}

/**
 * One step of a damped spring.
 *
 * `dtMs` is clamped so a background tab that resumes after seconds does not fling the value across
 * its target. The default stiffness and damping settle a stage line in roughly a third of a second.
 */
export function springStep(
  state: SpringState,
  target: number,
  dtMs: number,
  stiffness = 170,
  damping = 26,
): SpringState {
  const dt = Math.min(64, Math.max(4, dtMs)) / 1000
  const acceleration = (target - state.value) * stiffness - state.velocity * damping
  const velocity = state.velocity + acceleration * dt
  return { value: state.value + velocity * dt, velocity }
}

export interface StageWordShape {
  /** Horizontal start offset in em. */
  x: number
  /** Vertical start offset in em. */
  y: number
  /** Start rotation in degrees. */
  rotate: number
  /** Start scale. */
  scale: number
  /** Staggered start delay in milliseconds. */
  delayMs: number
}

/** The entrance shape of each word, seeded by the line's start time. */
export function wordShapes(count: number, seed: number | string): StageWordShape[] {
  if (count <= 0) return []
  const random = lineRandom(seed)
  return Array.from({ length: count }, (_, index) => ({
    x: -0.38 + random() * 0.76,
    y: 0.45 + random() * 0.9,
    rotate: -8 + random() * 16,
    scale: 0.78 + random() * 0.3,
    delayMs: index * 45 + Math.round(random() * 30),
  }))
}

/**
 * Split text into balanced pieces, preferring the word breaks the author wrote.
 *
 * CJK lines have no spaces, so their pieces are characters; a Latin line keeps its words. Spaces at a
 * piece boundary are dropped, which is the only text a caller loses and exactly what a row break
 * shows anyway.
 */
export function balancedTextParts(
  text: string,
  minParts: number,
  maxParts: number,
  charsPerPart: number,
): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const units = textUnits(trimmed)
  if (!units.length) return []
  const chars = characterCount(units)
  const desired = Math.max(minParts, Math.min(maxParts, Math.ceil(chars / charsPerPart)))
  const rows = Math.max(1, Math.min(desired, units.length === 1 ? Math.min(chars, maxParts) : units.length))
  // Word units lost their separators when they were split; put them back inside each row. CJK
  // characters and a glued Latin line are single units per character and take no separator.
  const joiner = /\s/.test(trimmed) ? ' ' : ''
  return partitionUnits(units, rows, joiner)
}

export interface StageWord {
  text: string
  /** Whether a space should be painted after this word. */
  space: boolean
  startTime: number
  duration: number
}

function needsSpace(previous: string, next: string): boolean {
  if (!previous || !next) return false
  const last = previous.at(-1) ?? ''
  const first = next[0] ?? ''
  if (CJK_CHARACTER.test(last) || CJK_CHARACTER.test(first)) return false
  return LATIN_WORD_END.test(last) || LATIN_WORD_END.test(first)
}

/**
 * Words as they should be painted.
 *
 * YRC keeps CJK words separate without separators, while Latin lines often arrive as words without
 * their spaces. A space is inserted only between two Latin-looking neighbours, so Chinese, Japanese
 * and Korean lines do not grow gaps the singer never left.
 */
export function spaceWords(words: readonly LyricWord[]): StageWord[] {
  return words.map((word, index) => {
    const previous = words[index - 1]?.text ?? ''
    return {
      text: word.text,
      space: Boolean(word.space) || needsSpace(previous, word.text),
      startTime: word.startTime,
      duration: word.duration,
    }
  })
}

/** The per-word units to draw for a line; an LRC line gets the shared synthetic rhythm. */
export function stageUnits(line: Pick<LyricLine, 'fullText' | 'startTime' | 'duration' | 'words'>): StageWord[] {
  const { words } = lyricWordTimings(line as LyricLine)
  if (words.length) return spaceWords(words)
  const text = line.fullText.trim()
  if (!text) return []
  return [{
    text: line.fullText,
    space: false,
    startTime: Math.max(0, line.startTime),
    duration: Math.max(0, line.duration),
  }]
}

/** Which phase a word is in, given the word being sung right now. */
export function stageWordPhase(index: number, activeWordIndex: number): 'waiting' | 'singing' | 'sung' {
  if (index < activeWordIndex) return 'sung'
  if (index === activeWordIndex) return 'singing'
  return 'waiting'
}

/** The word state at a position, clamped to the line's own duration. */
export function stageWordState(words: readonly LyricWord[] | readonly StageWord[], timeMs: number): LyricWordState {
  return lyricWordStateAt(words, timeMs)
}

function textUnits(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (/\s/.test(trimmed)) return trimmed.split(/\s+/).filter(Boolean)
  if (CJK_CHARACTER.test(trimmed)) return [...trimmed]
  // A Latin line with no spaces is either one long word or a line the provider glued together.
  // Splitting it by characters is less bad than leaving one word in a single 64px row.
  return [...trimmed]
}

function characterCount(units: readonly string[]): number {
  return units.reduce((sum, unit) => sum + [...unit].length, 0)
}

/**
 * Split units into `rows` groups that are balanced by character count.
 *
 * Every group gets at least one unit and the final group takes whatever is left, so no row is empty
 * and no unit is dropped. The result is deterministic for a given input.
 */
function partitionUnits(units: readonly string[], rows: number, joiner = ''): string[] {
  if (!units.length) return []
  const count = Math.max(1, Math.min(rows, units.length))
  const out: string[] = []
  let cursor = 0
  let remainingChars = characterCount(units)
  for (let row = 0; row < count; row += 1) {
    const remainingRows = count - row
    // The last row takes the tail. Every earlier row leaves at least one unit per remaining row, so
    // the split can never produce an empty row and can never drop a unit.
    if (remainingRows === 1) {
      out.push(units.slice(cursor).join(joiner))
      break
    }
    const target = remainingChars / remainingRows
    let group = ''
    while (cursor < units.length - (remainingRows - 1)) {
      const unit = units[cursor]!
      group += (group ? joiner : '') + unit
      remainingChars -= [...unit].length
      cursor += 1
      if (group.length >= target) break
    }
    out.push(group)
  }
  return out.filter(Boolean)
}

/** How far the line has been sung, from 0 to 1. */
export function stageLineProgress(line: Pick<LyricLine, 'startTime' | 'duration'>, timeMs: number): number {
  const duration = Math.max(0, line.duration)
  if (duration <= 0) return timeMs >= line.startTime ? 1 : 0
  return Math.max(0, Math.min(1, (timeMs - line.startTime) / duration))
}

export interface SparkBurst {
  index: number
  elapsedMs: number
  seed: number
}

/**
 * The word bursts still throwing sparks at a position.
 *
 * A burst begins at the word's own start time and lives for {@link STAGE_SPARK_WINDOW_MS}; after
 * that the canvas is cleared and the arming path stops doing work.
 */
export function stageSparkBursts(
  words: readonly Pick<StageWord, 'startTime'>[],
  timeMs: number,
  windowMs = STAGE_SPARK_WINDOW_MS,
): SparkBurst[] {
  const bursts: SparkBurst[] = []
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!
    const elapsed = timeMs - word.startTime
    if (elapsed < 0 || elapsed >= windowMs) continue
    bursts.push({ index, elapsedMs: elapsed, seed: word.startTime + index })
  }
  return bursts
}

// Derived from AlgerMusicPlayer 5.1.0 (MIT) src/renderer/utils/yrcParser.ts, with Inkstone adaptations.
/**
 * LRC and YRC parsing.
 *
 * The parser never throws: a provider can hand back a half-broken lyric and the player should keep
 * playing with whatever lines did parse. `ok: false` is for input that is mostly not a lyric at all.
 */

export interface LyricWord {
  text: string
  startTime: number
  duration: number
  space?: boolean
}

export interface LyricLine {
  startTime: number
  duration: number
  fullText: string
  words: LyricWord[]
  translation?: string
}

export interface LyricMetadata {
  time?: number
  content: string
}

export interface ParsedLyrics {
  metadata: LyricMetadata[]
  lines: LyricLine[]
}

export type LyricParseResult =
  | { ok: true; data: ParsedLyrics }
  | { ok: false; error: string }

const METADATA_PREFIX = /^\{"(?:t|c)":/
const WORD_LINE = /^\[(\d+),(\d+)\](.*)$/
const LRC_LINE = /^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\](.*)$/
const WORD_TOKEN = /\((\d+),(\d+),\d+\)([^(]*)/g

function parseMetadataLine(line: string): LyricMetadata | null {
  try {
    const value: unknown = JSON.parse(line)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as { t?: unknown; c?: unknown }
    if (!Array.isArray(record.c)) return null
    if (record.t !== undefined && typeof record.t !== 'number') return null
    const content = record.c
      .filter((item): item is { tx: string } => Boolean(item) && typeof item === 'object' && typeof (item as { tx?: unknown }).tx === 'string')
      .map((item) => item.tx)
      .join('')
    return { ...(typeof record.t === 'number' ? { time: record.t } : {}), content }
  } catch {
    return null
  }
}

function parseWordLine(line: string): LyricLine | null {
  const match = WORD_LINE.exec(line)
  if (!match) return null
  const startTime = Number(match[1])
  const duration = Number(match[2])
  if (!Number.isFinite(startTime) || !Number.isFinite(duration) || startTime < 0 || duration < 0) return null
  const content = match[3]
  const words: LyricWord[] = []
  const rawParts: string[] = []
  WORD_TOKEN.lastIndex = 0
  for (let token = WORD_TOKEN.exec(content); token; token = WORD_TOKEN.exec(content)) {
    const wordStart = Number(token[1])
    const wordDuration = Number(token[2])
    const rawText = token[3]
    const text = rawText.trim()
    if (!Number.isFinite(wordStart) || !Number.isFinite(wordDuration) || !text) continue
    words.push({ text, startTime: wordStart, duration: wordDuration })
    rawParts.push(rawText)
  }
  const fullText = rawParts.join('').trim()
  let cursor = 0
  for (const word of words) {
    const at = fullText.indexOf(word.text, cursor)
    if (at >= 0) {
      const end = at + word.text.length
      if (fullText[end] === ' ') word.space = true
      cursor = end
    }
  }
  return { startTime, duration, fullText, words }
}

function parseLrcLine(line: string): LyricLine | null {
  const match = LRC_LINE.exec(line)
  if (!match) return null
  const minutes = Number(match[1])
  const seconds = Number(match[2])
  const fraction = match[3] ?? '0'
  const milliseconds = Number(fraction.padEnd(3, '0').slice(0, 3))
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || !Number.isFinite(milliseconds)) return null
  if (minutes < 0 || seconds < 0 || seconds >= 60 || milliseconds < 0) return null
  return {
    startTime: minutes * 60_000 + seconds * 1000 + milliseconds,
    duration: 0,
    fullText: match[4].trim(),
    words: [],
  }
}

function fillDurations(lines: LyricLine[]): LyricLine[] {
  return lines.map((line, index) => {
    if (line.duration > 0 || line.startTime < 0) return line
    const next = lines.slice(index + 1).find((entry) => entry.startTime >= 0)
    const duration = next ? Math.max(0, next.startTime - line.startTime) : 3000
    return { ...line, duration }
  })
}

export function parseLyrics(input: string): LyricParseResult {
  if (typeof input !== 'string') return { ok: false, error: 'Lyrics must be a string' }
  const text = input.trim()
  if (!text) return { ok: true, data: { metadata: [], lines: [] } }

  const metadata: LyricMetadata[] = []
  const lines: LyricLine[] = []
  let invalid = 0
  const rawLines = text.split(/\r?\n/)

  for (const rawLine of rawLines) {
    const line = rawLine.trim()
    if (!line) continue
    if (METADATA_PREFIX.test(line)) {
      const entry = parseMetadataLine(line)
      if (entry) metadata.push(entry)
      else invalid++
      continue
    }
    if (line.startsWith('[')) {
      const parsed = parseWordLine(line) ?? parseLrcLine(line)
      if (parsed) lines.push(parsed)
      else invalid++
      continue
    }
    lines.push({ startTime: -1, duration: 0, fullText: line, words: [] })
  }

  if (lines.length === 0 && invalid > 0) return { ok: false, error: 'No lyric lines could be parsed' }
  if (invalid > 0 && invalid > rawLines.length * 0.5) return { ok: false, error: 'Too many malformed lyric lines' }

  lines.sort((left, right) => {
    if (left.startTime === right.startTime) return 0
    if (left.startTime === -1) return -1
    if (right.startTime === -1) return 1
    return left.startTime - right.startTime
  })

  return { ok: true, data: { metadata, lines: fillDurations(lines) } }
}

/** Lines with no timing are labels, not lyrics; the player ignores them when seeking. */
export function findActiveLineIndex(lines: readonly LyricLine[], timeMs: number): number {
  let low = 0
  let high = lines.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    const line = lines[middle]
    if (line.startTime < 0) {
      low = middle + 1
      continue
    }
    if (line.startTime <= timeMs) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}

/**
 * Attach a translation lyric to the original by timestamp, then by line index.
 *
 * Netease's `tlyric` usually has the same timestamps, but some older songs only align by line order;
 * a 2 s window covers the former without pairing a translation with the wrong chorus.
 */
export function mergeLyricTranslation(original: readonly LyricLine[], translationText: string): LyricLine[] {
  const parsed = parseLyrics(translationText)
  if (!parsed.ok || parsed.data.lines.length === 0) return [...original]
  const translated = parsed.data.lines.filter((line) => line.startTime >= 0 && line.fullText)
  const byTime = new Map<number, string>()
  for (const line of translated) byTime.set(Math.round(line.startTime / 100) * 100, line.fullText)

  return original.map((line, index) => {
    if (line.startTime < 0) return line
    const rounded = Math.round(line.startTime / 100) * 100
    let match = byTime.get(rounded)
    if (!match) {
      for (const [time, text] of byTime) {
        if (Math.abs(time - line.startTime) <= 2000) {
          match = text
          break
        }
      }
    }
    if (!match && translated.length === original.length) match = translated[index]?.fullText
    return match ? { ...line, translation: match } : line
  })
}

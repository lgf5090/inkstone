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
  /** True when `words` came from `synthesizeWordTimings` rather than from the provider's YRC. */
  wordsEstimated?: boolean
}

/** A line's word timing, and whether it is the provider's own or an estimate from the line box. */
export interface LyricWordTimings {
  words: LyricWord[]
  estimated: boolean
}

const CJK_CHARACTER = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
const WORD_CHARACTER = /[\p{L}\p{N}]/u

/**
 * Share of a line's duration used by the estimated word rhythm.
 *
 * A singer starts a phrase before the next line arrives and leaves the tail to the accompaniment;
 * stretching the last token across the whole box made it hang far behind the voice.
 */
const ESTIMATED_WORD_SPAN_RATIO = 0.85

/**
 * Give an LRC-only line a plausible word rhythm.
 *
 * YRC is the only source of real per-word timing, and most tracks do not have it. When the reader
 * turns on word-by-word highlighting anyway, the line box is all the timing there is: CJK text is
 * cut per character, Latin text per word, punctuation sticks to the token before it, and the line's
 * own duration is shared out by how many non-space characters each token carries. The last token
 * ends exactly at the line's end, so a highlight can never outlive the line that owns it. The
 * caller is expected to say that this is an estimate rather than present it as the provider's.
 */
export function synthesizeWordTimings(line: Pick<LyricLine, 'fullText' | 'startTime' | 'duration'>): LyricWord[] {
  const text = line.fullText
  if (!text.trim()) return []
  const tokens: Array<{ text: string, space: boolean }> = []
  let word = ''
  let latin = false
  const markSpace = () => {
    const last = tokens.at(-1)
    if (last) last.space = true
  }
  const flushWord = () => {
    if (!word) return
    tokens.push({ text: word, space: false })
    word = ''
    latin = false
  }

  for (const char of text) {
    if (/\s/.test(char)) {
      flushWord()
      markSpace()
      continue
    }
    if (CJK_CHARACTER.test(char)) {
      flushWord()
      tokens.push({ text: char, space: false })
      continue
    }
    if (WORD_CHARACTER.test(char) || (latin && (char === '\'' || char === '’' || char === '-'))) {
      word += char
      latin = true
      continue
    }
    // Punctuation and symbols belong to the word or character they follow; a line that opens with
    // one keeps it as its own token so nothing is silently dropped.
    flushWord()
    const last = tokens.at(-1)
    if (last) last.text += char
    else tokens.push({ text: char, space: false })
  }
  flushWord()
  if (!tokens.length) return []

  const weights = tokens.map((token) => {
    const count = [...token.text].filter((char) => !/\s/.test(char)).length
    return count > 0 ? count : 1
  })
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const startTime = Math.max(0, line.startTime)
  const duration = Math.max(0, line.duration)
  const span = Math.round(duration * ESTIMATED_WORD_SPAN_RATIO)
  let cursor = startTime
  let cumulative = 0
  return tokens.map((token, index) => {
    cumulative += weights[index]!
    const end = index === tokens.length - 1
      ? startTime + span
      : startTime + Math.round((span * cumulative) / totalWeight)
    const word: LyricWord = {
      text: token.text,
      startTime: cursor,
      duration: Math.max(0, end - cursor),
      ...(token.space ? { space: true } : {}),
    }
    cursor = end
    return word
  })
}

/**
 * The words to highlight for one line: the provider's own timing when it has any, the estimate when
 * it does not. `estimated` is what lets the surface label the second case honestly.
 */
export function lyricWordTimings(line: LyricLine): LyricWordTimings {
  if (line.words.length) return { words: line.words, estimated: false }
  return { words: synthesizeWordTimings(line), estimated: true }
}

/**
 * Which word is being sung at a media position, and how far through it the voice is.
 *
 * A gap between words belongs to the word before it: that word stays fully filled until the next one
 * starts, which is what keeps punctuation from blinking at the end of a phrase. `index: -1` means the
 * line has not reached its first word yet.
 */
export interface LyricWordState {
  index: number
  progress: number
}

export function lyricWordStateAt(
  words: readonly LyricWord[],
  timeMs: number,
): LyricWordState {
  if (!words.length || !Number.isFinite(timeMs)) return { index: -1, progress: 0 }
  let index = -1
  for (let position = 0; position < words.length; position += 1) {
    const word = words[position]!
    if (timeMs < word.startTime) break
    index = position
  }
  if (index < 0) return { index: -1, progress: 0 }
  const word = words[index]!
  if (word.duration <= 0) return { index, progress: 1 }
  return {
    index,
    progress: Math.max(0, Math.min(1, (timeMs - word.startTime) / word.duration)),
  }
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
const LRC_METADATA = /^\[(?:by|ar|ti|al|offset|re|ve|length):/i
const WORD_LINE = /^\[(\d+),(\d+)\](.*)$/
const LRC_TAG = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g
const WORD_TOKEN = /\((\d+),(\d+),\d+\)([^(]*)/g

/** Credit labels are data, not interface copy: escaped names keep the source ASCII-only. */
const CREDIT_NAMES: readonly string[] = [
  '\u4f5c\u8bcd',
  '\u4f5c\u66f2',
  '\u7f16\u66f2',
  '\u5236\u4f5c',
  '\u76d1\u5236',
  '\u6df7\u97f3',
  '\u5f55\u97f3',
  '\u6bcd\u5e26',
  '\u548c\u58f0',
  '\u5409\u4ed6',
  '\u8d1d\u65af',
  '\u9f13',
  '\u952e\u76d8',
  '\u5f26\u4e50',
  '\u51fa\u54c1',
  '\u53d1\u884c',
  '\u8bcd',
  '\u66f2',
  'Lyrics',
  'Lyricist',
  'Music',
  'Composer',
  'Arranger',
  'Producer',
]

const INSTRUMENTAL_MARKERS = ['\u7eaf\u97f3\u4e50', 'instrumental']

/**
 * Whether a line names who made the song, as "Lyricist: Alice", rather than being sung.
 *
 * The head before the first colon must be short, so a sung line that happens to contain a colon is
 * not mistaken for a credit; a one-character name such as the Chinese word for lyrics is the whole
 * head, while longer names also match as a prefix.
 */
export function isCreditLine(text: string): boolean {
  const colon = text.search(/[:\uFF1A]/)
  if (colon <= 0) return false
  const head = text.slice(0, colon).trim()
  const runes = [...head].length
  if (runes === 0 || runes > 12) return false
  return CREDIT_NAMES.some((name) => head === name || ([...name].length > 1 && head.startsWith(name)))
}

function isInstrumentalText(text: string): boolean {
  const normalized = text.trim().toLocaleLowerCase()
  return INSTRUMENTAL_MARKERS.some((marker) => normalized.includes(marker))
}

/**
 * Whether the parsed document is a pure-music marker rather than words to sing.
 *
 * A marker may carry a timestamp, so it is kept as a line; the lyric surface uses this answer to
 * show its "pure music" state instead of treating the marker as the first sung line.
 */
export function isInstrumentalLyrics(lines: readonly LyricLine[]): boolean {
  const timed = lines.filter((line) => line.startTime >= 0 && !isCreditLine(line.fullText) && line.fullText.trim())
  if (timed.length === 0) return false
  return timed.every((line) => isInstrumentalText(line.fullText))
}

export interface LyricQuiet {
  from: number
  to: number
}

/** The shortest silence a lyric document reports between sung lines, unless the caller says otherwise. */
const LYRIC_QUIET_MIN_MS = 3_000
/** A track with no lyric at all is quiet only when it is long enough to be a real instrumental. */
const NO_LYRIC_QUIET_MIN_MS = 8_000

/**
 * The stretches of a track in which no lyric line is sung: intro, interludes and outro.
 *
 * Credit rows and an instrumental marker are not sung. A lyric-less track is one quiet stretch from
 * start to end only when it is long enough; an empty answer from a still-loading request should not
 * be presented as an instrumental by accident.
 */
export function lyricQuiets(
  lines: readonly LyricLine[],
  trackDurationMs: number,
  minMs = LYRIC_QUIET_MIN_MS,
): LyricQuiet[] {
  const duration = Math.max(0, trackDurationMs)
  if (duration <= 0) return []
  const sung = lines
    .filter((line) => line.startTime >= 0 && line.fullText.trim() && !isCreditLine(line.fullText) && !isInstrumentalText(line.fullText))
    .slice()
    .sort((left, right) => left.startTime - right.startTime)
  if (sung.length === 0) {
    return duration >= Math.max(minMs, NO_LYRIC_QUIET_MIN_MS) ? [{ from: 0, to: duration }] : []
  }

  const out: LyricQuiet[] = []
  const add = (from: number, to: number): void => {
    if (to - from >= minMs) out.push({ from, to })
  }
  let at = 0
  for (const line of sung) {
    const start = Math.max(0, line.startTime)
    add(at, Math.min(start, duration))
    at = Math.max(at, Math.min(duration, start + Math.max(0, line.duration)))
  }
  add(at, duration)
  return out
}

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
  if (!fullText) return null
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

/** One LRC source line may carry several timestamps, one per chorus repeat. */
function parseLrcLines(line: string): LyricLine[] {
  const stamps: number[] = []
  LRC_TAG.lastIndex = 0
  let lastEnd = 0
  for (let match = LRC_TAG.exec(line); match; match = LRC_TAG.exec(line)) {
    const minutes = Number(match[1])
    const seconds = Number(match[2])
    const fraction = match[3] ?? '0'
    const milliseconds = Number(fraction.padEnd(3, '0').slice(0, 3))
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || !Number.isFinite(milliseconds)) continue
    if (minutes < 0 || seconds < 0 || seconds >= 60 || milliseconds < 0) continue
    stamps.push(minutes * 60_000 + seconds * 1000 + milliseconds)
    lastEnd = match.index + match[0].length
  }
  const fullText = line.slice(lastEnd).trim()
  if (!fullText || stamps.length === 0) return []
  return stamps.map((startTime) => ({ startTime, duration: 0, fullText, words: [] }))
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
    if (LRC_METADATA.test(line)) continue
    if (line.startsWith('[')) {
      const looksWordTimed = WORD_LINE.test(line)
      const wordLine = parseWordLine(line)
      if (wordLine) {
        lines.push(wordLine)
        continue
      }
      // An empty YRC box, or one that holds only spaces, is a real provider line with nothing to
      // sing: it is dropped, not counted as a malformed line.
      if (looksWordTimed) continue
      const lrcLines = parseLrcLines(line)
      if (lrcLines.length > 0) lines.push(...lrcLines)
      else invalid++
      continue
    }
    lines.push({ startTime: -1, duration: 0, fullText: line, words: [] })
  }

  const sung = lines.filter((line) => line.fullText.trim() && !isCreditLine(line.fullText))
  if (sung.length === 0 && invalid > 0) return { ok: false, error: 'No lyric lines could be parsed' }
  if (invalid > 0 && invalid > rawLines.length * 0.5) return { ok: false, error: 'Too many malformed lyric lines' }

  sung.sort((left, right) => {
    if (left.startTime === right.startTime) return 0
    if (left.startTime === -1) return -1
    if (right.startTime === -1) return 1
    return left.startTime - right.startTime
  })

  return { ok: true, data: { metadata, lines: fillDurations(sung) } }
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

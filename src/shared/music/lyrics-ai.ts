/**
 * The wire contract for AI lyric translation.
 *
 * The model is asked for one JSON object with one entry per lyric line, in the order the lines
 * appear. Everything here validates what came back before it is cached or shown: a translation that
 * lost a line, reordered the chorus or answered in prose is refused as a whole rather than merged
 * partially, because half a translated lyric reads as a finished one and hides the failure.
 */

export const MUSIC_AI_TRANSLATE_LANGS = ['zh-CN', 'en-US', 'auto'] as const
export type MusicAiTranslateLang = (typeof MUSIC_AI_TRANSLATE_LANGS)[number]

/** A line as the provider timed it: the timestamp the translation has to keep. */
export interface MusicAiLyricSourceLine {
  startTime: number
  text: string
}

/** One translated line, still carrying the provider's timestamp. */
export interface MusicAiTranslatedLine {
  startTime: number
  text: string
}

export interface MusicAiTranslateResponse {
  lines: MusicAiTranslatedLine[]
  /** The model label that produced the translation. */
  model: string
  cached: boolean
}

export interface MusicAiTranslateRequest {
  targetLang?: unknown
  force?: unknown
}

/** A lyric beyond these bounds is a document, not a song, and is refused instead of half translated. */
export const MUSIC_AI_LYRICS_MAX_LINES = 200
export const MUSIC_AI_LYRICS_MAX_CHARS = 8_000
export const MUSIC_AI_LYRICS_MAX_LINE_CHARS = 500

export type MusicAiTranslateBody =
  | { ok: true, targetLang: MusicAiTranslateLang, force: boolean }
  | { ok: false, error: string }

/** Read the endpoint's body. Missing `targetLang` follows the source language rather than guessing. */
export function parseMusicAiTranslateBody(value: unknown): MusicAiTranslateBody {
  if (value === undefined || value === null) return { ok: true, targetLang: 'auto', force: false }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'The request body must be a JSON object' }
  }
  const record = value as MusicAiTranslateRequest
  const targetLang = record.targetLang === undefined ? 'auto' : record.targetLang
  if (typeof targetLang !== 'string' || !(MUSIC_AI_TRANSLATE_LANGS as readonly string[]).includes(targetLang)) {
    return { ok: false, error: 'targetLang must be zh-CN, en-US or auto' }
  }
  if (record.force !== undefined && typeof record.force !== 'boolean') {
    return { ok: false, error: 'force must be a boolean' }
  }
  return { ok: true, targetLang: targetLang as MusicAiTranslateLang, force: record.force === true }
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

/**
 * Which language `auto` should translate into: the opposite script of what the lyric mostly is.
 *
 * A lyric already written in CJK is translated to English, and anything else to Chinese. CJK
 * punctuation and numerals do not count as evidence of a language on their own — a line of
 * instrumental markers must not flip the decision.
 */
export function resolveMusicAiTargetLang(
  lines: readonly MusicAiLyricSourceLine[],
  requested: MusicAiTranslateLang,
): 'zh-CN' | 'en-US' {
  if (requested !== 'auto') return requested
  let cjk = 0
  let letters = 0
  for (const line of lines) {
    for (const char of line.text) {
      if (CJK.test(char)) cjk++
      else if (/\p{L}/u.test(char)) letters++
    }
  }
  if (!letters && !cjk) return 'zh-CN'
  return cjk > letters ? 'en-US' : 'zh-CN'
}

export type MusicAiTranslationParse =
  | { ok: true, lines: string[] }
  | { ok: false, reason: string }

/**
 * Read the model's JSON answer, then hold it to the shape the prompt asked for.
 *
 * The brace extraction mirrors the assistant's other JSON readers: a provider that honours the
 * structured-output request answers with a bare object, a relay that ignored it wraps the object in
 * prose, and both end up at the same parse. What follows is strict on purpose — the count, the
 * index order and the per-line length all have to hold, because a translation is only useful if it
 * lines up with the lyric it translates.
 */
export function parseMusicAiTranslation(text: string, expectedLines: number): MusicAiTranslationParse {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return { ok: false, reason: 'The answer contained no JSON object' }
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return { ok: false, reason: 'The answer was not valid JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'The answer was not a JSON object' }
  }
  const lines = (parsed as { lines?: unknown }).lines
  if (!Array.isArray(lines)) return { ok: false, reason: 'The answer carried no lines list' }
  if (lines.length !== expectedLines) {
    return { ok: false, reason: `The answer has ${lines.length} lines, expected ${expectedLines}` }
  }
  const translated: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const entry = lines[index]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, reason: `Line ${index} is not an object` }
    }
    const record = entry as { index?: unknown, text?: unknown }
    if (record.index !== index) return { ok: false, reason: `Line ${index} is out of order` }
    if (typeof record.text !== 'string') return { ok: false, reason: `Line ${index} has no text` }
    const value = record.text.trim()
    if (!value) return { ok: false, reason: `Line ${index} is empty` }
    if (value.length > MUSIC_AI_LYRICS_MAX_LINE_CHARS) {
      return { ok: false, reason: `Line ${index} is longer than ${MUSIC_AI_LYRICS_MAX_LINE_CHARS} characters` }
    }
    translated.push(value)
  }
  return { ok: true, lines: translated }
}

function timestamp(ms: number): string {
  const safe = Math.max(0, Math.round(ms))
  const minutes = Math.floor(safe / 60_000)
  const seconds = Math.floor((safe % 60_000) / 1000)
  const centiseconds = Math.floor((safe % 1000) / 10)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`
}

/** Keep the provider's timeline: every translated line is written back at its original timestamp. */
export function buildMusicAiTranslationLrc(
  source: readonly MusicAiLyricSourceLine[],
  translated: readonly string[],
): string {
  return source
    .map((line, index) => `[${timestamp(line.startTime)}]${translated[index] ?? ''}`)
    .join('\n')
}

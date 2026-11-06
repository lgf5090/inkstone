/**
 * OpenAI audio compatibility (speech-to-text, translation and text-to-speech).
 *
 * Whisper accepts base64 audio and returns text plus word timings; the gateway turns those words into
 * the `srt`, `vtt` and `verbose_json` shapes the OpenAI clients expect. Speech uses Deepgram Aura so
 * OpenAI voice names map to real speakers and most output encodings are available. None of these
 * calls stream, so a retry can move to another account before any byte reaches the client.
 */
export const WHISPER_ALIAS = 'whisper'
export const AURA_ALIAS = 'aura-1'
const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo'
const AURA_MODEL = '@cf/deepgram/aura-1'

const WHISPER_NEURONS_PER_MINUTE = 46.63
const AURA_NEURONS_PER_1K_CHARS = 1_363.64

export const GATEWAY_AUDIO_ALIASES = {
  [WHISPER_ALIAS]: { model: WHISPER_MODEL, kind: 'transcribe' as const },
  [AURA_ALIAS]: { model: AURA_MODEL, kind: 'speech' as const },
}

export type GatewayAudioAlias = keyof typeof GATEWAY_AUDIO_ALIASES

export function resolveGatewayAudio(value: string): { alias: GatewayAudioAlias; model: string; kind: 'transcribe' | 'speech' } | null {
  const entry = (GATEWAY_AUDIO_ALIASES as Record<string, { model: string; kind: 'transcribe' | 'speech' }>)[value]
  return entry ? { alias: value as GatewayAudioAlias, model: entry.model, kind: entry.kind } : null
}

export function listAudioModels(): Array<{
  id: string
  object: 'model'
  created: number
  owned_by: 'workers-ai'
  worker_model: string
  kind: 'audio'
}> {
  return Object.entries(GATEWAY_AUDIO_ALIASES).map(([alias, entry]) => ({
    id: alias,
    object: 'model' as const,
    created: 1_700_000_000,
    owned_by: 'workers-ai' as const,
    worker_model: entry.model,
    kind: 'audio' as const,
  }))
}

/**
 * Duration is what the quota gate needs before the model runs. RIFF/WAVE carries its own byte rate;
 * compressed audio is assumed to be at 16 kbps, the low end of the formats OpenAI clients upload, so
 * the estimate is longer rather than shorter than the real file.
 */
export function audioMinutes(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 0
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    const byteRate = readUint32LE(bytes, 28)
    const dataSize = readUint32LE(bytes, 40)
    if (byteRate > 0 && dataSize > 0) return dataSize / byteRate / 60
  }
  return bytes.byteLength / 120_000
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.byteLength) return 0
  return bytes[offset]! + bytes[offset + 1]! * 256 + bytes[offset + 2]! * 65_536 + bytes[offset + 3]! * 16_777_216
}

export function transcriptionReservation(bytes: Uint8Array): number {
  const minutes = audioMinutes(bytes)
  return Math.max(50, Math.ceil(WHISPER_NEURONS_PER_MINUTE * minutes * 1.10))
}

export function transcriptionSettlement(minutes: number): number {
  return Math.max(1, Math.ceil(WHISPER_NEURONS_PER_MINUTE * Math.max(0, minutes)))
}

export function speechReservation(text: string): number {
  return Math.max(50, Math.ceil((text.length / 1000) * AURA_NEURONS_PER_1K_CHARS * 1.10))
}

export function speechSettlement(text: string): number {
  return Math.max(1, Math.ceil((text.length / 1000) * AURA_NEURONS_PER_1K_CHARS))
}

export interface WhisperWord {
  word?: string
  start?: number
  end?: number
}

export interface WhisperResult {
  text?: string
  word_count?: number
  vtt?: string
  words?: WhisperWord[]
}

function durationOfWords(words: readonly WhisperWord[]): number {
  return words.reduce((max, word) => Math.max(max, Number(word.end) || 0), 0)
}

export function transcriptionDurationMinutes(result: WhisperResult, fallbackMinutes: number): number {
  const words = Array.isArray(result.words) ? result.words : []
  const wordSeconds = durationOfWords(words)
  const vttSeconds = typeof result.vtt === 'string'
    ? parseVtt(result.vtt).reduce((max, cue) => Math.max(max, cue.end), 0)
    : 0
  const seconds = Math.max(wordSeconds, vttSeconds)
  return seconds > 0 ? seconds / 60 : fallbackMinutes
}

function stamp(seconds: number, separator: '.' | ','): string {
  const total = Math.max(0, seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = Math.floor(total % 60)
  const millis = Math.floor((total - Math.floor(total)) * 1000)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`
}

interface Cue { start: number; end: number; text: string }

function cuesFromWords(words: readonly WhisperWord[]): Cue[] {
  const cues: Cue[] = []
  let current: Cue | null = null
  for (const word of words) {
    const text = String(word.word ?? '').trim()
    if (!text) continue
    const start = Number(word.start) || 0
    const end = Number(word.end) || start
    if (current && start - current.end <= 0.6 && current.text.length + text.length <= 80) {
      current.text = `${current.text} ${text}`.trim()
      current.end = Math.max(current.end, end)
      continue
    }
    if (current) cues.push(current)
    current = { start, end, text }
  }
  if (current) cues.push(current)
  return cues
}

export function toSrt(words: readonly WhisperWord[], fallbackText: string): string {
  const cues = cuesFromWords(words)
  if (cues.length === 0) {
    return `1\n${stamp(0, ',')} --> ${stamp(0, ',')}\n${fallbackText}\n`
  }
  return cues.map((cue, index) => `${index + 1}\n${stamp(cue.start, ',')} --> ${stamp(cue.end, ',')}\n${cue.text}\n`).join('\n')
}

export function toVtt(words: readonly WhisperWord[], fallbackText: string): string {
  const cues = cuesFromWords(words)
  const body = cues.length === 0
    ? `WEBVTT\n\n${stamp(0, '.')} --> ${stamp(0, '.')}\n${fallbackText}\n`
    : `WEBVTT\n\n${cues.map((cue) => `${stamp(cue.start, '.')} --> ${stamp(cue.end, '.')}\n${cue.text}\n`).join('\n')}`
  return body
}

export interface VttCue { start: number; end: number; text: string }

function parseTimestamp(value: string): number {
  const parts = value.trim().split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part))) return 0
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!
  return parts[0] ?? 0
}

/** Whisper's VTT is one cue per recognised word in practice; both cue shapes are accepted. */
export function parseVtt(vtt: string): VttCue[] {
  const cues: VttCue[] = []
  for (const block of vtt.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const timeLine = lines.find((line) => line.includes('-->'))
    if (!timeLine) continue
    const [startRaw, endRaw] = timeLine.split('-->').map((part) => part.trim())
    const text = lines.slice(lines.indexOf(timeLine) + 1).join(' ').trim()
    if (!startRaw || !endRaw || !text) continue
    cues.push({ start: parseTimestamp(startRaw), end: parseTimestamp(endRaw), text })
  }
  return cues
}

export function wordsFromVtt(vtt: string): WhisperWord[] {
  const cues = parseVtt(vtt)
  const words: WhisperWord[] = []
  for (const cue of cues) {
    const parts = cue.text.split(/\s+/).filter(Boolean)
    if (parts.length === 0) continue
    const span = Math.max(0, cue.end - cue.start) / parts.length
    parts.forEach((word, index) => {
      words.push({ word, start: cue.start + span * index, end: cue.start + span * (index + 1) })
    })
  }
  return words
}

export function vttToSrt(vtt: string): string {
  const cues = parseVtt(vtt)
  if (cues.length === 0) return ''
  return cues.map((cue, index) => `${index + 1}\n${stamp(cue.start, ',')} --> ${stamp(cue.end, ',')}\n${cue.text}\n`).join('\n')
}

export function verboseSegments(words: readonly WhisperWord[], text: string): Record<string, unknown>[] {
  const cues = cuesFromWords(words)
  const segments = cues.length > 0
    ? cues
    : [{ start: 0, end: 0, text }]
  return segments.map((cue, index) => ({
    id: index,
    seek: 0,
    start: cue.start,
    end: cue.end,
    text: cue.text,
    tokens: [],
    temperature: 0,
    avg_logprob: -0.1,
    compression_ratio: 1,
    no_speech_prob: 0.01,
  }))
}

const VOICE_TO_SPEAKER: Record<string, string> = {
  alloy: 'angus',
  echo: 'asteria',
  fable: 'arcas',
  onyx: 'orion',
  nova: 'athena',
  shimmer: 'luna',
}

export function resolveAuraSpeaker(voice: unknown): string | null {
  if (typeof voice !== 'string' || !voice) return 'angus'
  return VOICE_TO_SPEAKER[voice] ?? null
}

export interface AuraEncoding {
  encoding: string
  container: 'none' | 'wav' | 'ogg'
  contentType: string
}

export function resolveAuraEncoding(format: unknown): AuraEncoding | null {
  switch (format) {
    case undefined:
    case 'mp3': return { encoding: 'mp3', container: 'none', contentType: 'audio/mpeg' }
    case 'opus': return { encoding: 'opus', container: 'none', contentType: 'audio/ogg' }
    case 'aac': return { encoding: 'aac', container: 'none', contentType: 'audio/aac' }
    case 'flac': return { encoding: 'flac', container: 'none', contentType: 'audio/flac' }
    case 'wav': return { encoding: 'linear16', container: 'wav', contentType: 'audio/wav' }
    case 'pcm': return { encoding: 'linear16', container: 'none', contentType: 'audio/L16' }
    default: return null
  }
}

/** Aura answers with an audio body; older JSON shapes carry a base64 `audio` field. */
export async function extractAudio(response: Response): Promise<Uint8Array> {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const body = await response.json().catch(() => null) as Record<string, unknown> | null
    const result = body && typeof body.result === 'object' && body.result !== null ? body.result as Record<string, unknown> : body
    const audio = result?.audio ?? result?.b64_json
    if (typeof audio !== 'string' || audio.length === 0) throw new Error('Cloudflare returned no audio')
    return decodeBase64(audio)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error('Cloudflare returned empty audio')
  return bytes
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

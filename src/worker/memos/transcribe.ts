import { parseProviderEndpoints, type AssistantProtocol } from '@shared/assistant'
import { assertRelayableEndpoint, pickRelayHeaders } from '@shared/ai-proxy-guard'
import {
  MEMO_AI_TRANSCRIBE_MAX_BYTES,
  MEMO_AI_TRANSCRIBE_PER_HOUR,
} from '@shared/memos/constants'
import type { MemoTranscriptionResult } from '@shared/memos/types'
import { AssistantStore, type ProviderRow } from '../assistant/store'
import type { Env } from '../env'
import { toBase64 } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'
import { readStreamTextWithinLimit } from '../lib/request'
import { assertAttemptBudget, consumeAttemptBudget } from '../lib/throttle'

export const MEMO_TRANSCRIBE_FORM_MAX_BYTES = MEMO_AI_TRANSCRIBE_MAX_BYTES + 1024 * 1024

export const MEMO_TRANSCRIBE_MIME_TYPES = [
  'audio/webm',
  'audio/wav',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/x-m4a',
] as const

const TRANSCRIBE_WINDOW_MS = 60 * 60 * 1000
const TRANSCRIBE_TIMEOUT_MS = 120_000
const TRANSCRIBE_ERROR_MAX_BYTES = 64 * 1024
const TRANSCRIBE_DETAIL_MAX_CHARS = 300
const TRANSCRIBE_MODEL_MAX_CHARS = 200
const TRANSCRIBE_LANGUAGE_MAX_CHARS = 32
const TRANSCRIBE_PROMPT_MAX_CHARS = 2_000
const TRANSCRIBE_FILENAME_MAX_CHARS = 120
const DEFAULT_TRANSCRIPTION_PROMPT = 'Transcribe this audio recording. Return only the transcribed text.'

export interface MemoTranscriptionAudio {
  bytes: Uint8Array
  mime: string
  filename: string
}

export interface MemoTranscriptionInput {
  userId: string
  providerId?: string | null
  model?: string | null
  language?: string | null
  prompt?: string | null
  audio: MemoTranscriptionAudio
}

interface ProviderCall {
  baseUrl: string
  apiKey: string
  model: string
  language: string | null
  prompt: string | null
  audio: MemoTranscriptionAudio
}

export function normalizeMemoTranscriptionMime(raw: string): string | null {
  const mime = raw.split(';')[0].trim().toLowerCase()
  return (MEMO_TRANSCRIBE_MIME_TYPES as readonly string[]).includes(mime) ? mime : null
}

export function transcriptionsEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (base.endsWith('/audio/transcriptions')) return base
  const afterHost = base.replace(/^[a-z]+:\/\//i, '')
  return afterHost.includes('/') ? `${base}/audio/transcriptions` : `${base}/v1/audio/transcriptions`
}

export async function transcribeMemoAudio(
  env: Env,
  input: MemoTranscriptionInput,
): Promise<MemoTranscriptionResult> {
  const audio = normalizeAudio(input.audio)
  const providerId = transcriptionProviderId(input.providerId)
  const model = transcriptionModel(input.model)
  const language = optionalText(input.language, 'language', TRANSCRIBE_LANGUAGE_MAX_CHARS)
  const prompt = optionalText(input.prompt, 'prompt', TRANSCRIBE_PROMPT_MAX_CHARS)

  const store = new AssistantStore(env.DB, input.userId, env)
  const provider = await store.providerRecord(providerId)
  if (!provider) {
    throw ApiError.badRequest(
      'The transcription provider was not found on this account. Choose a provider in the memo transcription settings.',
    )
  }
  const wire = providerWire(provider)
  if (wire.protocol === 'anthropic') {
    throw ApiError.badRequest(
      'Transcription needs an OpenAI-compatible or Gemini provider. This provider uses the Anthropic protocol.',
    )
  }
  const apiKey = await providerApiKey(store, provider)

  await assertTranscriptionBudget(env.DB, input.userId)

  const call: ProviderCall = { baseUrl: wire.baseUrl, apiKey, model, language, prompt, audio }
  const text = wire.protocol === 'gemini'
    ? await transcribeWithGemini(call)
    : await transcribeWithOpenAi(call)
  return { text }
}

function normalizeAudio(audio: MemoTranscriptionAudio): MemoTranscriptionAudio {
  if (!audio.bytes.byteLength) throw ApiError.badRequest('The audio file is empty')
  if (audio.bytes.byteLength > MEMO_AI_TRANSCRIBE_MAX_BYTES) {
    throw ApiError.tooLarge(
      `The audio exceeds the ${MEMO_AI_TRANSCRIBE_MAX_BYTES / 1024 / 1024} MB limit`,
    )
  }
  const mime = normalizeMemoTranscriptionMime(audio.mime)
  if (!mime) {
    throw new ApiError(
      415,
      'bad_request',
      `Unsupported audio type. Use one of: ${MEMO_TRANSCRIBE_MIME_TYPES.join(', ')}`,
    )
  }
  return { bytes: audio.bytes, mime, filename: safeFilename(audio.filename) }
}

function transcriptionProviderId(raw: string | null | undefined): string {
  const providerId = typeof raw === 'string' ? raw.trim() : ''
  if (!providerId) {
    throw new ApiError(
      400,
      'bad_request',
      'No transcription provider is configured. Set providerId in the memo transcription settings.',
    )
  }
  if (!isValidId(providerId)) throw ApiError.badRequest('The transcription provider id is invalid')
  return providerId
}

function transcriptionModel(raw: string | null | undefined): string {
  const model = typeof raw === 'string' ? raw.trim() : ''
  if (!model) {
    throw new ApiError(
      400,
      'bad_request',
      'No transcription model is configured. Set model in the memo transcription settings.',
    )
  }
  if (model.length > TRANSCRIBE_MODEL_MAX_CHARS) {
    throw ApiError.badRequest('The transcription model id is too long')
  }
  return model
}

function optionalText(raw: string | null | undefined, field: string, maxChars: number): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text.length > maxChars) throw ApiError.badRequest(`The transcription ${field} is too long`)
  return text || null
}

function safeFilename(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._ ()-]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, TRANSCRIBE_FILENAME_MAX_CHARS)
  return cleaned || 'audio'
}

function providerWire(provider: ProviderRow): { protocol: AssistantProtocol; baseUrl: string } {
  const protocol: AssistantProtocol = provider.protocol === 'gemini' || provider.protocol === 'anthropic'
    ? provider.protocol
    : 'openai'
  const endpoints = parseProviderEndpoints(provider.endpoints ?? '{}')
  return { protocol, baseUrl: endpoints[protocol] || provider.base_url }
}

async function providerApiKey(store: AssistantStore, provider: ProviderRow): Promise<string> {
  const picked = await store.pickProviderKey(provider)
  if (!picked?.key) {
    throw ApiError.badRequest(
      'The transcription provider has no usable API key. Add an API key to this provider in Assistant settings.',
    )
  }
  return picked.key
}

async function assertTranscriptionBudget(db: D1Database, userId: string): Promise<void> {
  await assertAttemptBudget(
    () => consumeAttemptBudget(db, [{
      key: `memo-transcribe:${userId}`,
      maxAttempts: MEMO_AI_TRANSCRIBE_PER_HOUR,
      windowMs: TRANSCRIBE_WINDOW_MS,
      lockMs: TRANSCRIBE_WINDOW_MS,
    }]),
    'Too many transcription requests',
  )
}

async function transcribeWithOpenAi(call: ProviderCall): Promise<string> {
  const url = vettedEndpoint(transcriptionsEndpoint(call.baseUrl))
  const form = new FormData()
  form.set('file', new File([call.audio.bytes], call.audio.filename, { type: call.audio.mime }))
  form.set('model', call.model)
  if (call.language) form.set('language', call.language)
  if (call.prompt) form.set('prompt', call.prompt)

  const response = await callProvider(url, {
    method: 'POST',
    headers: pickRelayHeaders({
      accept: 'application/json',
      authorization: `Bearer ${call.apiKey}`,
    }),
    body: form,
  })
  const payload = await response.json().catch(() => null) as { text?: unknown } | null
  if (typeof payload?.text !== 'string') {
    throw new ApiError(502, 'internal', 'The transcription provider answered without a transcript.')
  }
  return payload.text.trim()
}

async function transcribeWithGemini(call: ProviderCall): Promise<string> {
  const url = vettedEndpoint(geminiGenerateEndpoint(call.baseUrl, call.model))
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: transcriptionPrompt(call.language, call.prompt) },
        { inlineData: { mimeType: call.audio.mime, data: toBase64(call.audio.bytes) } },
      ],
    }],
  }
  const response = await callProvider(url, {
    method: 'POST',
    headers: pickRelayHeaders({
      'content-type': 'application/json',
      accept: 'application/json',
      'x-goog-api-key': call.apiKey,
    }),
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null) as { candidates?: unknown } | null
  const text = firstGeminiText(payload)
  if (!text) {
    throw new ApiError(502, 'internal', 'The transcription provider answered without a transcript.')
  }
  return text
}

function transcriptionPrompt(language: string | null, prompt: string | null): string {
  const instruction = prompt ?? DEFAULT_TRANSCRIPTION_PROMPT
  return language ? `${instruction}\nThe spoken language is ${language}.` : instruction
}

function firstGeminiText(payload: { candidates?: unknown } | null): string {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : []
  const first = candidates[0]
  if (!first || typeof first !== 'object' || Array.isArray(first)) return ''
  const content = (first as Record<string, unknown>).content
  if (!content || typeof content !== 'object' || Array.isArray(content)) return ''
  const parts = (content as Record<string, unknown>).parts
  if (!Array.isArray(parts)) return ''
  for (const part of parts) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue
    const record = part as Record<string, unknown>
    if (record.thought === true) continue
    if (typeof record.text === 'string' && record.text.trim()) return record.text.trim()
  }
  return ''
}

function geminiGenerateEndpoint(baseUrl: string, model: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '').replace(/\/v1beta$/, '').replace(/\/models$/, '')
  return `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`
}

function vettedEndpoint(endpoint: string): URL {
  try {
    return assertRelayableEndpoint(endpoint)
  } catch (error) {
    throw ApiError.badRequest(error instanceof Error ? error.message : 'That provider address cannot be called')
  }
}

async function callProvider(url: URL, init: RequestInit): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      redirect: NO_REDIRECT,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ApiError(
        502,
        'internal',
        `The transcription provider did not answer within ${TRANSCRIBE_TIMEOUT_MS / 1000} seconds.`,
      )
    }
    throw new ApiError(502, 'internal', 'The transcription provider could not be reached.')
  }
  if (isRedirectResponse(response)) {
    throw new ApiError(
      502,
      'internal',
      'The transcription provider answered with a redirect, which this app does not follow.',
    )
  }
  if (!response.ok) throw await providerFailure(response)
  return response
}

async function providerFailure(response: Response): Promise<ApiError> {
  const text = (await readStreamTextWithinLimit(response.body, TRANSCRIBE_ERROR_MAX_BYTES)) ?? ''
  const detail = providerMessage(text)
  const suffix = detail ? ` ${detail}` : ''
  if (response.status === 401 || response.status === 403) {
    return new ApiError(
      502,
      'internal',
      `The transcription provider refused its API key (${response.status}). Check the provider key in Assistant settings.`,
    )
  }
  if (response.status === 404) {
    return new ApiError(
      400,
      'bad_request',
      `The transcription model or endpoint was not found (404). Check the model and the provider address.${suffix}`,
    )
  }
  if (response.status === 429) {
    return new ApiError(
      502,
      'internal',
      'The transcription provider is rate limiting this key. Try again shortly.',
    )
  }
  return new ApiError(
    502,
    'internal',
    `The transcription provider refused the request (${response.status}).${suffix}`,
  )
}

function providerMessage(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return trimmed.slice(0, TRANSCRIBE_DETAIL_MAX_CHARS)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return trimmed.slice(0, TRANSCRIBE_DETAIL_MAX_CHARS)
  }
  const record = parsed as Record<string, unknown>
  const error = record.error
  if (typeof error === 'string' && error) return error.slice(0, TRANSCRIBE_DETAIL_MAX_CHARS)
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string' && message) return message.slice(0, TRANSCRIBE_DETAIL_MAX_CHARS)
  }
  const message = record.message
  if (typeof message === 'string' && message) return message.slice(0, TRANSCRIBE_DETAIL_MAX_CHARS)
  return ''
}

/**
 * Minting a short-lived credential for a realtime voice session.
 *
 * The reader's provider key never reaches the browser: this Worker uses it once to ask the provider
 * for a client secret that expires in about a minute, and the browser speaks to the provider directly
 * with that secret. That keeps the privacy shape the rest of the assistant already has — audio and
 * answers travel between the reader and the vendor, not through this deployment — without putting a
 * long-lived key in a page.
 *
 * Only the OpenAI realtime shape is understood. The session endpoint changed during the API's
 * preview period, so the newer `client_secrets` call is tried first and the older `sessions` call is
 * the fallback for a provider that has not caught up.
 */
import { assertRelayableEndpoint } from '@shared/ai-proxy-guard'

export interface RealtimeSession {
  /** The short-lived credential the WebRTC handshake is signed with. Never the provider's own key. */
  clientSecret: string
  model: string
  /** The provider origin the browser posts its SDP offer to. */
  baseUrl: string
  /**
   * Which SDP door this provider answered on.
   *
   * The GA flow mints at `client_secrets` and exchanges SDP at `realtime/calls`; a provider that has
   * not moved to client secrets exchanges it at `realtime` with the model in the query. The browser
   * cannot guess this, so the mint remembers it.
   */
  transport: 'calls' | 'legacy'
  /** Unix seconds, when the provider said so. */
  expiresAt: number | null
}

/**
 * A session the browser opens through this Worker rather than directly.
 *
 * ModelBest authenticates a browser socket by putting the long-lived key into a WebSocket subprotocol,
 * which is the one place this app refuses to put it. The relay keeps the key server-side and the
 * browser connects to the same origin it already trusts.
 */
export interface RealtimeRelayDescriptor {
  transport: 'modelbest'
  model: string
  relayPath: string
  expiresAt: null
}

export class RealtimeSessionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'RealtimeSessionError'
  }
}

/** How long a ModelBest socket waits for an explicit queue event before initializing anyway. */
export const MODELBEST_INIT_FALLBACK_MS = 600

/** The most one browser audio frame may carry. A 100 ms 16 kHz Float32 frame is about 8.6 KB. */
export const MODELBEST_MAX_FRAME_CHARS = 256_000

/** The voice model's own reply budget; speech is short, and the setting's ceiling is for text turns. */
const MODELBEST_MAX_OUTPUT_TOKENS = 1024

/** Whether this provider speaks the MiniCPM-o realtime WebSocket protocol rather than OpenAI's WebRTC. */
export function isModelBestEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'modelbest.cn' || host.endsWith('.modelbest.cn')
  } catch {
    return false
  }
}

/**
 * The upstream realtime socket for a ModelBest provider.
 *
 * The SDK's rule for a base URL is followed exactly: a path already ending in `/v1` keeps it, and any
 * other base gets `/v1` appended before `/realtime`. Getting this wrong is a 404 that reads like a bad key.
 */
export function modelBestSocketUrl(baseUrl: string, model: string): string {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/v1') ? `${path}/realtime` : `${path}/v1/realtime`
  url.search = ''
  url.searchParams.set('mode', 'audio')
  url.searchParams.set('model', model)
  return url.toString()
}

/** The init frame the relay writes after the provider assigns a worker, before any audio is forwarded. */
export function modelBestSessionInit(instructions: string, temperature: number): string {
  return JSON.stringify({
    type: 'session.init',
    payload: {
      system_prompt: instructions,
      config: {
        max_tokens: MODELBEST_MAX_OUTPUT_TOKENS,
        temperature,
        tts_enabled: true,
      },
    },
  })
}

interface SessionShape {
  client_secret?: { value?: unknown, expires_at?: unknown } | string
  value?: unknown
  expires_at?: unknown
}

/**
 * The body of the newer `/realtime/client_secrets` call.
 *
 * The shapes are the GA ones: input and output audio are separate objects, and the input asks for a
 * transcription of what the reader said so the screen can show the turn. A voice session with no
 * transcript is a phone call the reader cannot review.
 */
function clientSecretBody(model: string, instructions: string): Record<string, unknown> {
  return {
    session: {
      type: 'realtime',
      model,
      instructions,
      audio: {
        input: {
          transcription: { model: 'gpt-4o-mini-transcribe' },
          turn_detection: { type: 'server_vad' },
        },
        output: { voice: 'alloy' },
      },
    },
  }
}

/** The older `/realtime/sessions` shape, kept for a provider that has not moved to client secrets. */
function legacySessionBody(model: string, instructions: string): Record<string, unknown> {
  return {
    model,
    voice: 'alloy',
    instructions,
    modalities: ['audio', 'text'],
    input_audio_transcription: { model: 'whisper-1' },
    turn_detection: { type: 'server_vad' },
  }
}

function readSecret(payload: SessionShape): RealtimeSession['clientSecret'] | null {
  const nested = payload.client_secret
  const value = typeof nested === 'string'
    ? nested
    : nested && typeof nested === 'object' && typeof nested.value === 'string'
      ? nested.value
      : typeof payload.value === 'string'
        ? payload.value
        : null
  return value && value.trim() ? value : null
}

function readExpiry(payload: SessionShape): number | null {
  const nested = payload.client_secret
  const value = nested && typeof nested === 'object' && typeof nested.expires_at === 'number'
    ? nested.expires_at
    : typeof payload.expires_at === 'number'
      ? payload.expires_at
      : null
  return value && Number.isFinite(value) ? value : null
}

async function postSession(url: string, apiKey: string, body: Record<string, unknown>): Promise<Response> {
  const target = assertRelayableEndpoint(url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    return await fetch(target, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch {
    throw new RealtimeSessionError(502, 'The realtime provider could not be reached.')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ask the provider for a client secret.
 *
 * The key is written into one outbound header and nowhere else; a refusal carries the status, never
 * the response body, because an upstream error is free text and this path handles a credential.
 */
export async function mintRealtimeSession(input: {
  baseUrl: string
  apiKey: string
  model: string
  instructions: string
}): Promise<RealtimeSession> {
  const baseUrl = input.baseUrl.replace(/\/+$/, '')
  const modern = await postSession(`${baseUrl}/realtime/client_secrets`, input.apiKey, clientSecretBody(input.model, input.instructions))
  const legacy = modern.status === 404 || modern.status === 405
  const response = legacy
    ? await postSession(`${baseUrl}/realtime/sessions`, input.apiKey, legacySessionBody(input.model, input.instructions))
    : modern
  if (!response.ok) {
    console.warn('[inkstone] realtime session refused by the provider', response.status)
    throw new RealtimeSessionError(response.status, `The realtime provider refused the voice session (HTTP ${response.status}).`)
  }
  let payload: SessionShape
  try {
    payload = await response.json() as SessionShape
  } catch {
    throw new RealtimeSessionError(502, 'The realtime provider answered with something that is not a session.')
  }
  const clientSecret = readSecret(payload)
  if (!clientSecret) throw new RealtimeSessionError(502, 'The realtime provider did not return a client secret.')
  return {
    clientSecret,
    model: input.model,
    baseUrl,
    transport: legacy ? 'legacy' : 'calls',
    expiresAt: readExpiry(payload),
  }
}

/**
 * Realtime voice through a ModelBest WebSocket, via this deployment's relay.
 *
 * The wire protocol is MiniCPM-o's own: JSON text frames, audio as base64 Float32 PCM, and output that
 * arrives as `response.output.delta` frames carrying a `kind` of text, audio or listen. The reader below
 * also accepts the flat event names the public documentation shows, because the two spellings coexist
 * across providers and releases.
 *
 * The relay owns the provider key and the system prompt. This controller only receives `session.created`
 * and then streams microphone frames; it never sends `session.init` and never sees a credential.
 */
import { t } from '../../lib/i18n'
import type { RealtimeEvent, RealtimeStatus } from './voice-realtime'
import type { VoiceCapture, VoicePlayer } from './voice-capture'

/** How long after the last text or audio chunk the answer is considered finished. */
export const MODELBEST_QUIET_MS = 2500

export type ModelBestEvent =
  | { kind: 'ready' }
  | { kind: 'user', text: string }
  | { kind: 'assistant-delta', delta: string }
  | { kind: 'audio', audio: string }
  | { kind: 'listening' }
  | { kind: 'ended', reason?: string }
  | { kind: 'error', message: string }

function textField(event: Record<string, unknown>, key: string): string | null {
  const value = event[key]
  if (typeof value === 'string' && value.trim()) return value.trim()
  const payload = event.payload
  if (payload && typeof payload === 'object') {
    const nested = (payload as Record<string, unknown>)[key]
    if (typeof nested === 'string' && nested.trim()) return nested.trim()
  }
  return null
}

function streamText(event: Record<string, unknown>): string | null {
  const direct = event.text ?? event.delta
  if (typeof direct === 'string') return direct
  const payload = event.payload
  if (payload && typeof payload === 'object') {
    const nested = (payload as Record<string, unknown>).text ?? (payload as Record<string, unknown>).delta
    if (typeof nested === 'string') return nested
  }
  return null
}

function eventText(event: Record<string, unknown>): string | null {
  return textField(event, 'text') ?? textField(event, 'transcript') ?? textField(event, 'delta')
}

function errorMessage(event: Record<string, unknown>): string {
  const nested = event.error
  if (nested && typeof nested === 'object' && typeof (nested as { message?: unknown }).message === 'string') {
    return String((nested as { message: string }).message)
  }
  if (typeof nested === 'string' && nested) return nested
  if (typeof event.message === 'string' && event.message) return event.message
  return 'The voice provider reported an error.'
}

/** What one server frame means to the screen, or null for queue and usage frames it does not draw. */
export function readModelBestEvent(raw: unknown): ModelBestEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const event = raw as Record<string, unknown>
  const type = typeof event.type === 'string' ? event.type : ''
  if (type === 'session.created') return { kind: 'ready' }
  if (type === 'session.closed') {
    return { kind: 'ended', reason: typeof event.reason === 'string' ? event.reason : undefined }
  }
  if (type === 'error') return { kind: 'error', message: errorMessage(event) }
  if (type === 'response.output.delta') {
    if (event.kind === 'text') {
      const text = streamText(event)
      return text === null ? null : { kind: 'assistant-delta', delta: text }
    }
    if (event.kind === 'audio') {
      const audio = typeof event.audio === 'string' ? event.audio : typeof event.delta === 'string' ? event.delta : ''
      return audio ? { kind: 'audio', audio } : null
    }
    if (event.kind === 'listen') {
      const text = eventText(event)
      return text ? { kind: 'user', text } : { kind: 'listening' }
    }
    return null
  }
  if (type === 'response.output_text.delta') {
    const text = streamText(event)
    return text === null ? null : { kind: 'assistant-delta', delta: text }
  }
  if (type === 'response.output_text.done') return { kind: 'listening' }
  if (type === 'assistant.transcript') {
    const text = eventText(event)
    return text ? { kind: 'assistant-delta', delta: text } : null
  }
  if (type === 'response.output_audio.delta') {
    const audio = typeof event.audio === 'string' ? event.audio : typeof event.delta === 'string' ? event.delta : ''
    return audio ? { kind: 'audio', audio } : null
  }
  if (type === 'response.listen'
    || type === 'response.listen.delta'
    || type === 'input_audio_transcription.completed'
    || type === 'conversation.item.input_audio_transcription.completed'
    || type === 'transcription.completed') {
    const text = eventText(event)
    return text ? { kind: 'user', text } : { kind: 'listening' }
  }
  if (type === 'user.transcript') {
    const text = eventText(event)
    return text ? { kind: 'user', text } : null
  }
  if (type === 'response.done' || type === 'turn.completed') return { kind: 'listening' }
  return null
}

export interface ModelBestVoiceDeps {
  socketUrl: string
  createSocket: (url: string) => WebSocket
  getMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  createCapture: (context: AudioContext, stream: MediaStream, onChunk: (audio: string) => void) => Promise<VoiceCapture>
  createPlayer: (context: AudioContext) => VoicePlayer
  audioContext: AudioContext
  onEvent: (event: RealtimeEvent) => void
  onStatus: (status: RealtimeStatus) => void
  onError: (detail?: string) => void
}

export class ModelBestVoiceController {
  private socket: WebSocket | null = null
  private capture: VoiceCapture | null = null
  private player: VoicePlayer | null = null
  private active = false
  private ready = false
  private muted = false
  private spoke = false
  private lastUser = ''
  private quietTimer = 0

  constructor(private readonly deps: ModelBestVoiceDeps) {}

  async start(): Promise<void> {
    if (this.active) return
    this.active = true
    this.deps.onStatus('connecting')
    this.player = this.deps.createPlayer(this.deps.audioContext)
    try {
      await this.deps.audioContext.resume()
    } catch {
      // Playback can still work on a context the browser started awake; the first chunk says so if not.
    }
    if (!this.active) return
    if (this.deps.audioContext.state === 'suspended') {
      this.fail(t('assistant.voice.audio_blocked'))
      return
    }
    let socket: WebSocket
    try {
      socket = this.deps.createSocket(this.deps.socketUrl)
    } catch {
      this.fail(t('assistant.voice.connect_failed'))
      return
    }
    this.socket = socket
    socket.onmessage = (message) => {
      if (!this.active || typeof message.data !== 'string') return
      let raw: unknown
      try { raw = JSON.parse(message.data) } catch { return }
      const event = readModelBestEvent(raw)
      if (event) this.handle(event)
    }
    socket.onerror = () => {
      if (this.active) this.fail(t('assistant.voice.connection_dropped'))
    }
    socket.onclose = () => {
      if (this.active) this.fail(t('assistant.voice.connection_dropped'))
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.capture?.setMuted(muted)
  }

  stop(): void {
    this.teardown()
    this.deps.onStatus('ended')
  }

  private handle(event: ModelBestEvent): void {
    if (!this.active) return
    if (event.kind === 'ready') {
      if (this.ready) return
      this.ready = true
      this.deps.onStatus('listening')
      void this.beginCapture()
      return
    }
    if (event.kind === 'user') {
      if (event.text === this.lastUser) return
      this.lastUser = event.text
      this.deps.onEvent({ kind: 'user', text: event.text })
      return
    }
    if (event.kind === 'assistant-delta') {
      this.spoke = true
      this.deps.onStatus('speaking')
      this.deps.onEvent({ kind: 'assistant-delta', delta: event.delta })
      this.scheduleQuiet()
      return
    }
    if (event.kind === 'audio') {
      this.spoke = true
      this.deps.onStatus('speaking')
      this.player?.enqueue(event.audio)
      this.scheduleQuiet()
      return
    }
    if (event.kind === 'listening') {
      // The provider emits listen frames while it is still producing an answer. Once it has spoken,
      // the turn is only over after a quiet beat; closing the bubble on the first frame split answers.
      // A listen frame must not push that beat back, or a provider that keeps reporting "listening"
      // never lets the screen leave Speaking.
      if (this.spoke) {
        if (!this.quietTimer) this.scheduleQuiet()
      } else {
        this.deps.onStatus('listening')
      }
      return
    }
    if (event.kind === 'ended') {
      this.teardown()
      this.deps.onStatus('ended')
      return
    }
    this.fail(event.message)
  }

  private scheduleQuiet(): void {
    window.clearTimeout(this.quietTimer)
    this.quietTimer = window.setTimeout(() => {
      this.quietTimer = 0
      if (!this.active) return
      this.spoke = false
      this.deps.onStatus('listening')
      this.deps.onEvent({ kind: 'phase', phase: 'listening' })
    }, MODELBEST_QUIET_MS)
  }

  private async beginCapture(): Promise<void> {
    let stream: MediaStream
    try {
      stream = await this.deps.getMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (error) {
      if (!this.active) return
      this.fail(error instanceof Error ? error.message : t('assistant.voice.mic_failed'))
      return
    }
    if (!this.active) {
      for (const track of stream.getTracks()) track.stop()
      return
    }
    try {
      this.capture = await this.deps.createCapture(this.deps.audioContext, stream, (audio) => this.sendAudio(audio))
      this.capture.setMuted(this.muted)
    } catch {
      for (const track of stream.getTracks()) track.stop()
      if (this.active) this.fail(t('assistant.voice.connect_failed'))
    }
  }

  private sendAudio(audio: string): void {
    if (!this.active || !this.ready || this.socket?.readyState !== WebSocket.OPEN) return
    try {
      this.socket.send(JSON.stringify({ type: 'input.append', input: { audio } }))
    } catch {
      this.fail(t('assistant.voice.connection_dropped'))
    }
  }

  private fail(detail?: string): void {
    if (!this.active) return
    this.teardown()
    this.deps.onStatus('error')
    this.deps.onError(detail)
  }

  private teardown(): void {
    this.active = false
    this.ready = false
    window.clearTimeout(this.quietTimer)
    this.quietTimer = 0
    this.capture?.stop()
    this.capture = null
    this.player?.stop()
    this.player = null
    const socket = this.socket
    this.socket = null
    if (socket) {
      try { socket.close(1000, 'voice stopped') } catch { /* the socket may already be closed */ }
    }
    try { void this.deps.audioContext.close() } catch { /* the context may already be closed */ }
  }
}

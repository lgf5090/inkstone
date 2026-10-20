/**
 * Full-duplex voice through a provider's Realtime API.
 *
 * The browser holds the microphone and the speaker; this Worker only minted the short-lived secret the
 * WebRTC handshake is signed with. Audio never passes through Inkstone, which is the same privacy shape
 * the text assistant already uses.
 *
 * The data channel's event names moved during the API's preview period (`audio_transcript` became
 * `output_audio_transcript`), so the reader below accepts both. The transport itself is injected,
 * because jsdom has neither a peer connection nor a microphone and the state transitions are the part
 * worth testing.
 */
export interface RealtimeSession {
  clientSecret: string
  model: string
  baseUrl: string
  /** Which SDP door the mint used: the GA `realtime/calls`, or the older `realtime?model=`. */
  transport: 'calls' | 'legacy'
  expiresAt?: number | null
}

export type RealtimeStatus = 'connecting' | 'listening' | 'speaking' | 'ended' | 'error'

export type RealtimeEvent =
  | { kind: 'phase', phase: 'listening' | 'thinking' | 'speaking' }
  | { kind: 'user', text: string }
  | { kind: 'assistant-delta', delta: string }
  | { kind: 'assistant-done', text: string }
  | { kind: 'error', message: string }

/** What one data-channel frame means to the screen, or null for the frames it does not draw. */
export function readRealtimeEvent(raw: unknown): RealtimeEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const event = raw as { type?: unknown, delta?: unknown, transcript?: unknown, text?: unknown, error?: { message?: unknown }, message?: unknown }
  const type = typeof event.type === 'string' ? event.type : ''
  if (type === 'conversation.item.input_audio_transcription.completed') {
    const text = typeof event.transcript === 'string' ? event.transcript : typeof event.text === 'string' ? event.text : ''
    return text.trim() ? { kind: 'user', text: text.trim() } : null
  }
  if (type === 'response.audio_transcript.delta' || type === 'response.output_audio_transcript.delta') {
    return typeof event.delta === 'string' && event.delta ? { kind: 'assistant-delta', delta: event.delta } : null
  }
  if (type === 'response.audio_transcript.done' || type === 'response.output_audio_transcript.done') {
    const text = typeof event.transcript === 'string' ? event.transcript : ''
    return text.trim() ? { kind: 'assistant-done', text: text.trim() } : null
  }
  if (type === 'input_audio_buffer.speech_started' || type === 'session.created' || type === 'session.updated' || type === 'response.done') {
    return { kind: 'phase', phase: 'listening' }
  }
  if (type === 'response.created') return { kind: 'phase', phase: 'thinking' }
  if (type === 'error') {
    const message = event.error && typeof event.error.message === 'string'
      ? event.error.message
      : typeof event.message === 'string' ? event.message : 'The voice session reported an error.'
    return { kind: 'error', message }
  }
  return null
}

export interface RealtimeVoiceDeps {
  mint: () => Promise<RealtimeSession>
  getMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  createPeer: () => RTCPeerConnection
  fetchSdp: (url: string, init: RequestInit) => Promise<Response>
  createAudio: () => HTMLAudioElement
  onEvent: (event: RealtimeEvent) => void
  onStatus: (status: RealtimeStatus) => void
  /**
   * What went wrong, named so the panel can say it in the reader's language.
   *
   * `detail` is shown when it carries words already meant for the reader — the microphone refusal
   * translated by the caller, or the provider's own sentence from the session route. The HTTP status
   * of a refused SDP offer travels separately so the panel can put it in its own sentence.
   */
  onError: (failure: RealtimeFailure, detail?: string) => void
}

export type RealtimeFailure = 'playback' | 'dropped' | 'refused' | 'failed'

export class RealtimeVoiceController {
  private active = false
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private stream: MediaStream | null = null
  private audio: HTMLAudioElement | null = null

  constructor(private readonly deps: RealtimeVoiceDeps) {}

  async start(): Promise<void> {
    if (this.active) return
    this.active = true
    this.deps.onStatus('connecting')
    const audio = this.deps.createAudio()
    this.audio = audio
    // The press that opened this panel is the only user gesture this flow gets. Playing the empty
    // element now, before the first await, is what keeps a strict autoplay policy from refusing the
    // remote track several seconds later.
    void audio.play().catch(() => {})
    try {
      const session = await this.deps.mint()
      if (!this.active) return
      const stream = await this.deps.getMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      if (!this.active) {
        stopTracks(stream)
        return
      }
      this.stream = stream
      const pc = this.deps.createPeer()
      this.pc = pc
      const track = stream.getAudioTracks()[0]
      if (track) pc.addTrack(track, stream)
      const dc = pc.createDataChannel('oai-events')
      this.dc = dc
      dc.onmessage = (message: MessageEvent) => {
        if (!this.active) return
        let raw: unknown
        try {
          raw = JSON.parse(String(message.data))
        } catch {
          return
        }
        const event = readRealtimeEvent(raw)
        if (event) this.deps.onEvent(event)
      }
      dc.onopen = () => { if (this.active) this.deps.onStatus('listening') }
      pc.ontrack = (event: RTCTrackEvent) => {
        if (!this.active) return
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
        void audio.play().catch(() => {
          // Autoplay can still be refused on a strict browser. The data channel keeps the transcript,
          // so say the call is not audible instead of pretending it is.
          if (this.active) this.deps.onError('playback')
        })
      }
      pc.onconnectionstatechange = () => {
        if (!this.active) return
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          this.deps.onError('dropped')
          this.deps.onStatus('error')
        }
      }
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await waitForIce(pc)
      if (!this.active) return
      const response = await this.deps.fetchSdp(
        session.transport === 'legacy'
          ? `${session.baseUrl}/realtime?model=${encodeURIComponent(session.model)}`
          : `${session.baseUrl}/realtime/calls`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.clientSecret}`,
            'Content-Type': 'application/sdp',
          },
          body: pc.localDescription?.sdp ?? offer.sdp ?? '',
        },
      )
      if (!this.active) return
      if (!response.ok) throw new SdpRefused(response.status)
      const sdp = await response.text()
      await pc.setRemoteDescription({ type: 'answer', sdp })
      this.deps.onStatus('listening')
    } catch (error) {
      if (!this.active) return
      this.stop()
      this.deps.onStatus('error')
      if (error instanceof SdpRefused) {
        this.deps.onError('refused', String(error.status))
        return
      }
      this.deps.onError('failed', error instanceof Error ? error.message : undefined)
    }
  }

  setMuted(muted: boolean): void {
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted
  }

  stop(): void {
    this.active = false
    try { this.dc?.close() } catch { /* the channel may never have opened */ }
    try { this.pc?.close() } catch { /* the connection may never have been created */ }
    stopTracks(this.stream)
    if (this.audio) {
      this.audio.pause()
      this.audio.srcObject = null
    }
    this.dc = null
    this.pc = null
    this.stream = null
    this.audio = null
    this.deps.onStatus('ended')
  }
}

function stopTracks(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop()
}

/** The SDP offer was answered with a refusal rather than an answer. */
class SdpRefused extends Error {
  constructor(readonly status: number) {
    super(`The realtime voice connection was refused (HTTP ${status}).`)
    this.name = 'SdpRefused'
  }
}

/** Wait for the local description to carry its candidates before the offer is posted. */
function waitForIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      window.clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    const check = () => {
      if (pc.iceGatheringState === 'complete') done()
    }
    const timer = window.setTimeout(done, 3_000)
    pc.addEventListener('icegatheringstatechange', check)
  })
}

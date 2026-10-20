// @vitest-environment jsdom
/**
 * The realtime voice transport and the events it carries.
 *
 * jsdom has neither a peer connection nor a microphone, so the transport is faked at the four boundaries
 * the controller actually touches: minting, media, the peer connection and the SDP POST. What is pinned
 * is which door the browser posts to, that the long-lived key never appears, and that a refusal puts the
 * microphone down before the panel says anything.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RealtimeVoiceController,
  readRealtimeEvent,
  type RealtimeEvent,
  type RealtimeVoiceDeps,
} from './voice-realtime'

function harness(overrides: Partial<RealtimeVoiceDeps> = {}) {
  const track = { stop: vi.fn(), enabled: true }
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream
  const dc = { onmessage: null as ((message: MessageEvent) => void) | null, onopen: null as (() => void) | null, close: vi.fn() }
  const pc = {
    iceGatheringState: 'complete',
    connectionState: 'new',
    localDescription: null as { type: string, sdp: string } | null,
    createDataChannel: vi.fn(() => dc),
    addTrack: vi.fn(),
    createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'OFFER' })),
    setLocalDescription: vi.fn(async (description: { type: string, sdp: string }) => { pc.localDescription = description }),
    setRemoteDescription: vi.fn(async () => {}),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    close: vi.fn(),
  }
  const audio = { play: vi.fn(async () => {}), pause: vi.fn(), srcObject: null as unknown }
  const statuses: string[] = []
  const errors: Array<{ failure: string, detail?: string }> = []
  const events: RealtimeEvent[] = []
  const fetchSdp = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ANSWER', { status: 200 }))
  const deps: RealtimeVoiceDeps = {
    mint: async () => ({
      clientSecret: 'ek-ephemeral',
      model: 'gpt-realtime',
      baseUrl: 'https://api.openai.com/v1',
      transport: 'calls',
      expiresAt: null,
    }),
    getMedia: async () => stream,
    createPeer: () => pc as unknown as RTCPeerConnection,
    fetchSdp,
    createAudio: () => audio as unknown as HTMLAudioElement,
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    onError: (failure, detail) => errors.push({ failure, detail }),
    ...overrides,
  }
  return { deps, track, dc, pc, audio, statuses, errors, events, fetchSdp }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the realtime voice transport', () => {
  it('posts the offer to the GA calls door with the ephemeral secret, never the provider key', async () => {
    const h = harness()
    const controller = new RealtimeVoiceController(h.deps)
    await controller.start()

    expect(h.fetchSdp).toHaveBeenCalledTimes(1)
    const [url, init] = h.fetchSdp.mock.calls[0]!
    expect(url).toBe('https://api.openai.com/v1/realtime/calls')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ek-ephemeral')
    expect(new Headers(init?.headers).get('content-type')).toBe('application/sdp')
    expect(init?.body).toBe('OFFER')
    expect(h.statuses.at(-1)).toBe('listening')
  })

  it('posts to the older door when the provider minted a legacy session', async () => {
    const h = harness({
      mint: async () => ({
        clientSecret: 'ek-legacy',
        model: 'gpt-4o-realtime',
        baseUrl: 'https://voice.example.com/v1',
        transport: 'legacy',
        expiresAt: null,
      }),
    })
    await new RealtimeVoiceController(h.deps).start()
    expect(h.fetchSdp.mock.calls[0]![0]).toBe('https://voice.example.com/v1/realtime?model=gpt-4o-realtime')
  })

  it('puts the microphone down when the SDP offer is refused', async () => {
    const h = harness({ fetchSdp: async () => new Response('no', { status: 401 }) })
    await new RealtimeVoiceController(h.deps).start()

    expect(h.errors).toEqual([{ failure: 'refused', detail: '401' }])
    expect(h.statuses).toContain('error')
    expect(h.track.stop).toHaveBeenCalledTimes(1)
    expect(h.dc.close).toHaveBeenCalledTimes(1)
  })

  it('stops the tracks, the channel and the audio when the reader ends the call', async () => {
    const h = harness()
    const controller = new RealtimeVoiceController(h.deps)
    await controller.start()
    controller.stop()

    expect(h.track.stop).toHaveBeenCalledTimes(1)
    expect(h.dc.close).toHaveBeenCalledTimes(1)
    expect(h.pc.close).toHaveBeenCalledTimes(1)
    expect(h.audio.pause).toHaveBeenCalledTimes(1)
    expect(h.statuses.at(-1)).toBe('ended')
  })

  it('mutes the outgoing track without stopping it', async () => {
    const h = harness()
    const controller = new RealtimeVoiceController(h.deps)
    await controller.start()
    controller.setMuted(true)
    expect(h.track.enabled).toBe(false)
    controller.setMuted(false)
    expect(h.track.enabled).toBe(true)
    expect(h.track.stop).not.toHaveBeenCalled()
  })
})

describe('reading realtime events', () => {
  it('accepts both names the transcript events have worn', () => {
    expect(readRealtimeEvent({ type: 'response.audio_transcript.delta', delta: 'Hel' }))
      .toEqual({ kind: 'assistant-delta', delta: 'Hel' })
    expect(readRealtimeEvent({ type: 'response.output_audio_transcript.delta', delta: 'lo' }))
      .toEqual({ kind: 'assistant-delta', delta: 'lo' })
    expect(readRealtimeEvent({ type: 'response.audio_transcript.done', transcript: 'Hello' }))
      .toEqual({ kind: 'assistant-done', text: 'Hello' })
    expect(readRealtimeEvent({ type: 'response.output_audio_transcript.done', transcript: 'Hello' }))
      .toEqual({ kind: 'assistant-done', text: 'Hello' })
  })

  it('reads what the reader said and what the session is doing', () => {
    expect(readRealtimeEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: '  open my notes  ',
    })).toEqual({ kind: 'user', text: 'open my notes' })
    expect(readRealtimeEvent({ type: 'input_audio_buffer.speech_started' })).toEqual({ kind: 'phase', phase: 'listening' })
    expect(readRealtimeEvent({ type: 'response.created' })).toEqual({ kind: 'phase', phase: 'thinking' })
    expect(readRealtimeEvent({ type: 'response.done' })).toEqual({ kind: 'phase', phase: 'listening' })
  })

  it('carries a provider error and ignores frames the panel does not draw', () => {
    expect(readRealtimeEvent({ type: 'error', error: { message: 'quota spent' } }))
      .toEqual({ kind: 'error', message: 'quota spent' })
    expect(readRealtimeEvent({ type: 'rate_limits.updated' })).toBeNull()
    expect(readRealtimeEvent({ type: 'response.output_audio_transcript.delta' })).toBeNull()
    expect(readRealtimeEvent('not json')).toBeNull()
    expect(readRealtimeEvent(null)).toBeNull()
  })
})

// @vitest-environment jsdom
/**
 * The ModelBest realtime transport.
 *
 * The socket, the microphone, the audio graph and the clock are all injected, so what is pinned is the
 * controller's own contract: audio is sent only after `session.created`, text and audio deltas reach the
 * screen and the speaker without splitting one answer into several bubbles, and every exit closes the
 * socket, the tracks and the audio context.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import type { RealtimeEvent } from './voice-realtime'
import {
  MODELBEST_QUIET_MS,
  ModelBestVoiceController,
  readModelBestEvent,
  type ModelBestVoiceDeps,
} from './voice-modelbest'

class FakeSocket {
  readyState = 1
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  closed = 0

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed++
    this.readyState = 3
    this.onclose?.()
  }

  emit(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) })
  }
}

function harness() {
  const socket = new FakeSocket()
  const track = { stop: vi.fn(), enabled: true }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream
  const capture = { stop: vi.fn(), setMuted: vi.fn() }
  const player = { enqueue: vi.fn(), stop: vi.fn() }
  const context = {
    state: 'running',
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } as unknown as AudioContext
  const events: RealtimeEvent[] = []
  const statuses: string[] = []
  const errors: Array<string | undefined> = []
  let onChunk: ((audio: string) => void) | null = null
  let captureStarted = false
  const deps: ModelBestVoiceDeps = {
    socketUrl: 'ws://localhost/api/assistant/realtime/relay?modelId=m1',
    createSocket: () => socket as unknown as WebSocket,
    getMedia: async () => stream,
    createCapture: async (_context, _stream, chunk) => {
      onChunk = chunk
      captureStarted = true
      return capture
    },
    createPlayer: () => player,
    audioContext: context,
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    onError: (detail) => errors.push(detail),
  }
  return {
    deps, socket, track, capture, player, context, events, statuses, errors,
    captureChunk: (audio: string) => onChunk?.(audio),
    get captureStarted() { return captureStarted },
  }
}

beforeEach(async () => {
  await initI18n()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('reading ModelBest frames', () => {
  it('reads the frames the provider actually sends for a spoken answer', () => {
    expect(readModelBestEvent({ type: 'session.created', session_id: 's1' })).toEqual({ kind: 'ready' })
    expect(readModelBestEvent({
      type: 'response.output.delta',
      kind: 'text',
      text: ' Two plus two is',
    })).toEqual({ kind: 'assistant-delta', delta: ' Two plus two is' })
    expect(readModelBestEvent({
      type: 'response.output.delta',
      kind: 'audio',
      audio: 'AACAPw==',
    })).toEqual({ kind: 'audio', audio: 'AACAPw==' })
    expect(readModelBestEvent({ type: 'response.output.delta', kind: 'listen' }))
      .toEqual({ kind: 'listening' })
    expect(readModelBestEvent({ type: 'session.closed', reason: 'user_stop' }))
      .toEqual({ kind: 'ended', reason: 'user_stop' })
  })

  it('accepts the flat names the public documentation shows', () => {
    expect(readModelBestEvent({ type: 'response.output_text.delta', delta: 'Hello' }))
      .toEqual({ kind: 'assistant-delta', delta: 'Hello' })
    expect(readModelBestEvent({ type: 'response.output_audio.delta', audio: 'AAAA' }))
      .toEqual({ kind: 'audio', audio: 'AAAA' })
    expect(readModelBestEvent({ type: 'input_audio_transcription.completed', transcript: '  hi  ' }))
      .toEqual({ kind: 'user', text: 'hi' })
    expect(readModelBestEvent({ type: 'response.done' })).toEqual({ kind: 'listening' })
    expect(readModelBestEvent({ type: 'response.output_text.done', text: 'full answer' }))
      .toEqual({ kind: 'listening' })
  })

  it('carries a provider error and ignores queue and usage frames', () => {
    expect(readModelBestEvent({ type: 'error', error: { code: 'x', message: 'quota spent' } }))
      .toEqual({ kind: 'error', message: 'quota spent' })
    expect(readModelBestEvent({ type: 'session.queued', position: 2 })).toBeNull()
    expect(readModelBestEvent({ type: 'session.queue_done' })).toBeNull()
    expect(readModelBestEvent('not json')).toBeNull()
    expect(readModelBestEvent(null)).toBeNull()
  })
})

describe('the ModelBest voice controller', () => {
  it('waits for session.created before sending microphone audio', async () => {
    const h = harness()
    const controller = new ModelBestVoiceController(h.deps)
    await controller.start()
    expect(h.statuses).toEqual(['connecting'])
    expect(h.socket.sent).toEqual([])

    h.socket.emit({ type: 'session.queue_done' })
    h.socket.emit({ type: 'session.created' })
    await vi.waitFor(() => expect(h.captureStarted).toBe(true))
    expect(h.statuses).toEqual(['connecting', 'listening'])

    h.captureChunk('AACAPw==')
    expect(h.socket.sent).toEqual([JSON.stringify({ type: 'input.append', input: { audio: 'AACAPw==' } })])
  })

  it('plays audio and keeps one answer open across the provider listen frames', async () => {
    const h = harness()
    const controller = new ModelBestVoiceController(h.deps)
    await controller.start()
    h.socket.emit({ type: 'session.created' })
    await vi.waitFor(() => expect(h.captureStarted).toBe(true))
    vi.useFakeTimers()

    h.socket.emit({ type: 'response.output.delta', kind: 'text', text: 'Two plus' })
    h.socket.emit({ type: 'response.output.delta', kind: 'listen' })
    h.socket.emit({ type: 'response.output.delta', kind: 'audio', audio: 'AACAPw==' })
    h.socket.emit({ type: 'response.output.delta', kind: 'listen' })
    expect(h.player.enqueue).toHaveBeenCalledWith('AACAPw==')
    expect(h.statuses).toContain('speaking')
    expect(h.events.filter((event) => event.kind === 'phase')).toHaveLength(0)

    vi.advanceTimersByTime(MODELBEST_QUIET_MS)
    expect(h.statuses.at(-1)).toBe('listening')
    expect(h.events.filter((event) => event.kind === 'phase')).toHaveLength(1)
    expect(h.events.filter((event) => event.kind === 'assistant-delta')).toHaveLength(1)
  })

  it('does not let continuous listen frames keep the screen speaking', async () => {
    const h = harness()
    const controller = new ModelBestVoiceController(h.deps)
    await controller.start()
    h.socket.emit({ type: 'session.created' })
    await vi.waitFor(() => expect(h.captureStarted).toBe(true))
    vi.useFakeTimers()

    h.socket.emit({ type: 'response.output.delta', kind: 'text', text: 'An answer.' })
    vi.advanceTimersByTime(MODELBEST_QUIET_MS - 300)
    h.socket.emit({ type: 'response.output.delta', kind: 'listen' })
    vi.advanceTimersByTime(400)
    expect(h.statuses.at(-1)).toBe('listening')
    expect(h.events.filter((event) => event.kind === 'phase')).toHaveLength(1)
  })

  it('shows a user transcript only when the provider sends one', async () => {
    const h = harness()
    const controller = new ModelBestVoiceController(h.deps)
    await controller.start()
    h.socket.emit({ type: 'session.created' })
    await vi.waitFor(() => expect(h.statuses).toContain('listening'))
    h.socket.emit({ type: 'response.output.delta', kind: 'listen', text: 'what is two plus two' })
    h.socket.emit({ type: 'response.output.delta', kind: 'listen', text: 'what is two plus two' })
    expect(h.events).toEqual([{ kind: 'user', text: 'what is two plus two' }])
  })

  it('mutes the capture without closing the call', async () => {
    const h = harness()
    const controller = new ModelBestVoiceController(h.deps)
    await controller.start()
    h.socket.emit({ type: 'session.created' })
    await vi.waitFor(() => expect(h.captureStarted).toBe(true))
    controller.setMuted(true)
    expect(h.capture.setMuted).toHaveBeenLastCalledWith(true)
    expect(h.socket.closed).toBe(0)
  })

  it('tears the microphone, socket and audio context down on stop', async () => {
    const h = harness()
    const controller = new ModelBestVoiceController(h.deps)
    await controller.start()
    h.socket.emit({ type: 'session.created' })
    await vi.waitFor(() => expect(h.captureStarted).toBe(true))
    controller.stop()

    expect(h.capture.stop).toHaveBeenCalledTimes(1)
    expect(h.player.stop).toHaveBeenCalledTimes(1)
    expect(h.socket.closed).toBe(1)
    expect(h.context.close).toHaveBeenCalledTimes(1)
    expect(h.statuses.at(-1)).toBe('ended')
  })

  it('reports a dropped connection and closes the microphone', async () => {
    const h = harness()
    const controller = new ModelBestVoiceController(h.deps)
    await controller.start()
    h.socket.emit({ type: 'session.created' })
    await vi.waitFor(() => expect(h.captureStarted).toBe(true))
    h.socket.onclose?.()

    expect(h.statuses.at(-1)).toBe('error')
    expect(h.errors).toEqual([t('assistant.voice.connection_dropped')])
    expect(h.capture.stop).toHaveBeenCalledTimes(1)
    expect(h.context.close).toHaveBeenCalledTimes(1)
  })
})

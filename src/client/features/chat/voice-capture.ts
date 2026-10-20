/**
 * The browser side of a ModelBest voice call: microphone in, speaker out.
 *
 * Capture runs through an AudioWorklet so the audio thread never waits on the page; the resampler and
 * the base64 frame builder run on the main thread, where a 100 ms chunk is cheap. Playback schedules
 * each returned chunk on one AudioContext, so consecutive deltas are one continuous voice instead of a
 * queue of clips with a gap at every boundary.
 */
import workletUrl from './voice-capture.worklet?worker&url'
import {
  VOICE_CHUNK_SAMPLES,
  VOICE_SAMPLE_RATE,
  StreamingResampler,
  decodeFloat32Base64,
  encodeFloat32Base64,
} from './voice-pcm'

export interface VoiceCapture {
  stop: () => void
  setMuted: (muted: boolean) => void
}

export interface VoicePlayer {
  enqueue: (base64: string) => void
  stop: () => void
}

/** A context created inside the Start press is the one the autoplay policy will let play. */
export function createVoiceAudioContext(): AudioContext {
  const Ctor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) throw new Error('This browser has no Web Audio support.')
  try {
    return new Ctor({ sampleRate: VOICE_SAMPLE_RATE })
  } catch {
    return new Ctor()
  }
}

export async function startVoiceCapture(
  context: AudioContext,
  stream: MediaStream,
  onChunk: (audio: string) => void,
): Promise<VoiceCapture> {
  if (!context.audioWorklet) throw new Error('This browser cannot process microphone audio.')
  await context.audioWorklet.addModule(workletUrl)
  const source = context.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(context, 'inkstone-voice-capture')
  const sink = context.createGain()
  sink.gain.value = 0
  source.connect(node)
  node.connect(sink)
  sink.connect(context.destination)
  const resampler = new StreamingResampler(context.sampleRate)
  const chunk = new Float32Array(VOICE_CHUNK_SAMPLES)
  let filled = 0
  let muted = false
  let stopped = false
  node.port.onmessage = (event: MessageEvent) => {
    if (stopped || muted) return
    const input = event.data
    if (!(input instanceof Float32Array)) return
    const samples = resampler.push(input)
    let offset = 0
    while (offset < samples.length) {
      const take = Math.min(VOICE_CHUNK_SAMPLES - filled, samples.length - offset)
      chunk.set(samples.subarray(offset, offset + take), filled)
      filled += take
      offset += take
      if (filled === VOICE_CHUNK_SAMPLES) {
        onChunk(encodeFloat32Base64(chunk))
        filled = 0
      }
    }
  }
  return {
    stop: () => {
      stopped = true
      node.port.onmessage = null
      try { source.disconnect() } catch { /* the graph may already be torn down */ }
      try { node.disconnect() } catch { /* the graph may already be torn down */ }
      try { sink.disconnect() } catch { /* the graph may already be torn down */ }
      for (const track of stream.getTracks()) track.stop()
    },
    setMuted: (next) => {
      muted = next
      for (const track of stream.getAudioTracks()) track.enabled = !next
    },
  }
}

export function createVoicePlayer(context: AudioContext): VoicePlayer {
  const sources = new Set<AudioBufferSourceNode>()
  let nextStart = 0
  return {
    enqueue: (base64) => {
      const samples = decodeFloat32Base64(base64)
      if (!samples.length) return
      const buffer = context.createBuffer(1, samples.length, VOICE_SAMPLE_RATE)
      buffer.copyToChannel(samples, 0)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      const start = Math.max(nextStart, context.currentTime + 0.03)
      source.start(start)
      nextStart = start + buffer.duration
      sources.add(source)
      source.onended = () => sources.delete(source)
    },
    stop: () => {
      for (const source of sources) {
        try { source.stop() } catch { /* a source that never started cannot be stopped */ }
      }
      sources.clear()
      nextStart = 0
    },
  }
}

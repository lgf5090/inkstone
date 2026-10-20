/**
 * The PCM arithmetic a realtime voice session needs.
 *
 * ModelBest speaks 16 kHz mono Float32 PCM in both directions, base64 on the wire. The browser's audio
 * graph runs at the device's rate, so capture is resampled to that one rate before it is sent; playback
 * hands the same rate to the browser to resample back. Everything here is pure so it can be measured
 * without a microphone.
 */

/** One frame is 100 ms at 16 kHz, which is small enough to stream and large enough to stay quiet. */
export const VOICE_CHUNK_SAMPLES = 1600

export const VOICE_SAMPLE_RATE = 16_000

/** Little-endian Float32 samples, base64 as the provider expects them. */
export function encodeFloat32Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  let binary = ''
  for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]!)
  return btoa(binary)
}

export function decodeFloat32Base64(base64: string): Float32Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  const samples = new Float32Array(Math.floor(bytes.length / 4))
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples.length * 4)
  for (let index = 0; index < samples.length; index++) samples[index] = view.getFloat32(index * 4, true)
  return samples
}

/**
 * A streaming resampler that keeps the fractional position across blocks.
 *
 * Resampling each 128-sample block on its own would reset the phase at every block boundary and leave
 * a periodic click; the carry is what makes the output one continuous signal.
 */
export class StreamingResampler {
  private pending = new Float32Array(0)
  private position = 0

  constructor(
    private readonly fromRate: number,
    private readonly toRate: number = VOICE_SAMPLE_RATE,
  ) {}

  push(input: Float32Array): Float32Array {
    if (!input.length) return new Float32Array(0)
    if (this.fromRate === this.toRate) return input
    const ratio = this.fromRate / this.toRate
    const merged = new Float32Array(this.pending.length + input.length)
    merged.set(this.pending)
    merged.set(input, this.pending.length)
    const output: number[] = []
    let position = this.position
    while (position + 1 < merged.length) {
      const left = Math.floor(position)
      const fraction = position - left
      output.push(merged[left]! * (1 - fraction) + merged[left + 1]! * fraction)
      position += ratio
    }
    const keepFrom = Math.floor(position)
    this.pending = merged.slice(keepFrom)
    this.position = position - keepFrom
    return Float32Array.from(output)
  }
}

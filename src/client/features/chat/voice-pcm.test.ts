// @vitest-environment jsdom
/**
 * The PCM layer both directions of a ModelBest call share.
 *
 * The wire format is little-endian Float32 at 16 kHz; a byte-order mistake here is audible as noise but
 * invisible in a type. The resampler is measured on a constant and on a tone because the failure that
 * matters is a phase reset at every block boundary, which a single-block test cannot see.
 */
import { describe, expect, it } from 'vitest'
import {
  VOICE_SAMPLE_RATE,
  StreamingResampler,
  decodeFloat32Base64,
  encodeFloat32Base64,
} from './voice-pcm'

describe('base64 float32 frames', () => {
  it('writes little-endian bytes the provider reads', () => {
    expect(encodeFloat32Base64(new Float32Array([1]))).toBe('AACAPw==')
    expect(Array.from(decodeFloat32Base64('AACAPw=='))).toEqual([1])
  })

  it('round-trips a frame without losing samples', () => {
    const samples = new Float32Array([-1, -0.25, 0, 0.25, 0.999])
    const decoded = decodeFloat32Base64(encodeFloat32Base64(samples))
    expect(decoded.length).toBe(samples.length)
    for (let index = 0; index < samples.length; index++) expect(decoded[index]).toBeCloseTo(samples[index]!, 6)
  })
})

describe('the streaming resampler', () => {
  it('keeps a constant signal constant across block boundaries', () => {
    const resampler = new StreamingResampler(48_000)
    const output: number[] = []
    for (let block = 0; block < 375; block++) {
      output.push(...resampler.push(new Float32Array(128).fill(0.5)))
    }
    expect(output.length).toBeGreaterThan(VOICE_SAMPLE_RATE * 0.99)
    expect(output.length).toBeLessThan(VOICE_SAMPLE_RATE * 1.01)
    expect(Math.max(...output)).toBeCloseTo(0.5, 6)
    expect(Math.min(...output)).toBeCloseTo(0.5, 6)
  })

  it('preserves a tone instead of resetting its phase every block', () => {
    const resampler = new StreamingResampler(48_000)
    const output: number[] = []
    for (let block = 0; block < 375; block++) {
      const samples = new Float32Array(128)
      for (let index = 0; index < samples.length; index++) {
        samples[index] = Math.sin(2 * Math.PI * 440 * ((block * 128 + index) / 48_000))
      }
      output.push(...resampler.push(samples))
    }
    const rms = Math.sqrt(output.reduce((sum, sample) => sum + sample * sample, 0) / output.length)
    expect(rms).toBeGreaterThan(0.65)
    expect(rms).toBeLessThan(0.75)
    let crossings = 0
    for (let index = 1; index < output.length; index++) {
      if ((output[index - 1]! < 0) !== (output[index]! < 0)) crossings++
    }
    // One second of 440 Hz crosses zero about 880 times.
    expect(crossings).toBeGreaterThan(860)
    expect(crossings).toBeLessThan(900)
  })
})

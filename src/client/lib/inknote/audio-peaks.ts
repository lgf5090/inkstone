/** Recording peaks: one bar per bucket, stored with the recording so a list can draw it without decoding. */
export function downsamplePeaks(samples: ArrayLike<number>, count = 64): number[] {
  if (samples.length === 0 || count <= 0) return []
  const peaks: number[] = []
  const bucket = Math.max(1, Math.floor(samples.length / count))
  for (let index = 0; index < count; index += 1) {
    const start = index * bucket
    if (start >= samples.length) break
    let peak = 0
    const end = Math.min(samples.length, start + bucket)
    for (let cursor = start; cursor < end; cursor += 1) peak = Math.max(peak, Math.abs(samples[cursor] ?? 0))
    peaks.push(Math.min(1, Math.max(0, peak)))
  }
  const loudest = Math.max(...peaks, 1e-6)
  return peaks.map((value) => Number((value / loudest).toFixed(3)))
}

export async function computeAudioPeaks(blob: Blob, count = 64): Promise<number[]> {
  const Ctor = typeof window === 'undefined'
    ? undefined
    : window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return []
  const context = new Ctor()
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer())
    let channel = buffer.getChannelData(0)
    for (let index = 1; index < buffer.numberOfChannels; index += 1) {
      const next = buffer.getChannelData(index)
      const merged = new Float32Array(channel.length)
      for (let cursor = 0; cursor < channel.length; cursor += 1) merged[cursor] = Math.max(Math.abs(channel[cursor] ?? 0), Math.abs(next[cursor] ?? 0))
      channel = merged
    }
    return downsamplePeaks(channel, count)
  } finally {
    void context.close()
  }
}

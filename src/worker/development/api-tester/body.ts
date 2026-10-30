export interface BodyRead {
  bytes: Uint8Array | null
  size: number
  tooLarge: boolean
}

/**
 * Reads an upstream body up to `maxBytes`, cancelling the stream the moment it crosses the cap.
 *
 * Every relay in this module needs the same thing: the caller chooses the target, so a response it
 * never bounds is a response that can hold the Worker open and fill its memory.
 */
export async function readCappedBody(response: Response, maxBytes: number): Promise<BodyRead> {
  const reader = response.body?.getReader()
  if (!reader) return { bytes: new Uint8Array(0), size: 0, tooLarge: false }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        try {
          await reader.cancel('response_too_large')
        } catch {
          // The payload is already refused; the reader is released below either way.
        }
        return { bytes: null, size: total, tooLarge: true }
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, size: total, tooLarge: false }
}

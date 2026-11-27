export type UploadBody = ReadableStream<Uint8Array> | Uint8Array | null | undefined

export interface ByteStreamLimits {
  maxBytes: number
  expectedBytes?: number
  /** Absolute wall-clock deadline, covering time spent waiting for the next chunk as well. */
  deadline?: number
  tooLarge: (received: number) => Error
  mismatched?: (received: number) => Error
  onSettled?: (error?: unknown) => void
}

function sourceOf(body: UploadBody): ReadableStream<Uint8Array> {
  if (body instanceof Uint8Array) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body)
        controller.close()
      },
    })
  }
  return body ?? new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })
}

/** Wrap an upload without buffering it, rejecting as soon as its byte count crosses the ceiling. */
export function byteStream(body: UploadBody, limits: ByteStreamLimits): ReadableStream<Uint8Array> {
  const reader = sourceOf(body).getReader()
  let received = 0
  let settled = false
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const clearDeadline = (): void => {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
    deadlineTimer = undefined
  }
  const settle = (error?: unknown): void => {
    if (settled) return
    settled = true
    clearDeadline()
    limits.onSettled?.(error)
  }
  const fail = (controller: ReadableStreamDefaultController<Uint8Array>, error: Error): void => {
    if (settled) return
    settle(error)
    controller.error(error)
    void reader.cancel(error).catch((cancelError: unknown) => {
      console.warn('[inkstone] A timed-out byte stream could not be cancelled', cancelError)
    })
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (limits.deadline !== undefined && Date.now() >= limits.deadline) {
        const error = new Error('The byte stream timed out')
        error.name = 'TimeoutError'
        fail(controller, error)
        return
      }
      if (limits.deadline !== undefined) {
        deadlineTimer = setTimeout(() => {
          const error = new Error('The byte stream timed out')
          error.name = 'TimeoutError'
          fail(controller, error)
        }, Math.max(0, limits.deadline - Date.now()))
      }
      try {
        const { done, value } = await reader.read()
        clearDeadline()
        if (settled) return
        if (done) {
          reader.releaseLock()
          if (limits.expectedBytes !== undefined && received !== limits.expectedBytes) {
            const error = (limits.mismatched ?? limits.tooLarge)(received)
            settle(error)
            controller.error(error)
            return
          }
          settle()
          controller.close()
          return
        }
        if (!value) return
        received += value.byteLength
        if (received > limits.maxBytes || (limits.expectedBytes !== undefined && received > limits.expectedBytes)) {
          fail(controller, limits.tooLarge(received))
          return
        }
        controller.enqueue(value)
      } catch (error) {
        clearDeadline()
        if (settled) return
        settle(error)
        controller.error(error)
      }
    },
    async cancel(reason) {
      settle(reason ?? new Error('Upload stream cancelled'))
      try {
        await reader.cancel(reason)
      } finally {
        reader.releaseLock()
      }
    },
  })
}

/** The bounded buffer required by external drivers that cannot sign or slice a streaming body. */
export async function readBoundedBytes(body: UploadBody, limits: ByteStreamLimits): Promise<Uint8Array> {
  const buffer = await new Response(byteStream(body, limits)).arrayBuffer()
  return new Uint8Array(buffer)
}

export function knownLengthByteStream(
  body: UploadBody,
  limits: ByteStreamLimits,
  length: number,
): { stream: ReadableStream<Uint8Array>; completed: Promise<void> } {
  if (typeof FixedLengthStream === 'function') {
    const fixed = new FixedLengthStream(length)
    const completed = byteStream(body, limits).pipeTo(fixed.writable)
    return { stream: fixed.readable, completed }
  }
  // Node-based route tests do not expose Cloudflare's FixedLengthStream. The validating stream is
  // equivalent for those consumers; Workers always take the native branch above so R2 knows length.
  let resolveCompleted!: () => void
  let rejectCompleted!: (error: unknown) => void
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve
    rejectCompleted = reject
  })
  const stream = byteStream(body, {
    ...limits,
    onSettled: (error) => {
      if (error === undefined) resolveCompleted()
      else rejectCompleted(error)
    },
  })
  return { stream, completed }
}

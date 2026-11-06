// Shared in-memory doubles for the W1 SSH protocol tests. They never stand in for the real
// handshake: the live test drives the same session against an OpenSSH server over `node:net`.

import type { SSHHostKeyInfo, SSHReadyInfo, SSHSessionSink, SSHTransportSocket } from '../src/worker/webssh/ssh/types'

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export interface MemorySocket {
  socket: SSHTransportSocket
  push(data: Uint8Array): void
  fail(error: Error): void
}

/** A transport whose inbound side the test controls and whose outbound side is discarded. */
export function makeMemorySocket(): MemorySocket {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const readable = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController
    },
    cancel() {
      cancelled = true
    },
  })
  const writable = new WritableStream<Uint8Array>({ write() {} })
  return {
    socket: {
      readable,
      writable,
      close() {
        if (cancelled) return
        try {
          controller.close()
        } catch {
          // The test may have closed or errored the stream already.
        }
      },
    },
    push(data) {
      if (cancelled) return
      controller.enqueue(data)
    },
    fail(error) {
      if (cancelled) return
      controller.error(error)
    },
  }
}

export interface TestSink extends SSHSessionSink {
  statuses: Array<{ event: string; message: string }>
  chunks: Uint8Array[]
  text(): string
  lastHostKey: SSHHostKeyInfo | null
  readySignal: Deferred<SSHReadyInfo>
  exitSignal: Deferred<{ exitCode: number | null; signal: string | null }>
  closedSignal: Deferred<{ reason: string; error?: Error }>
  waitForText(needle: string, timeoutMs?: number): Promise<void>
}

export function makeTestSink(options: { acceptHostKey?: boolean } = {}): TestSink {
  const statuses: Array<{ event: string; message: string }> = []
  const chunks: Uint8Array[] = []
  const readySignal = deferred<SSHReadyInfo>()
  const exitSignal = deferred<{ exitCode: number | null; signal: string | null }>()
  const closedSignal = deferred<{ reason: string; error?: Error }>()
  const sink: TestSink = {
    statuses,
    chunks,
    readySignal,
    exitSignal,
    closedSignal,
    lastHostKey: null,
    text() {
      return new TextDecoder().decode(concatBytes(chunks))
    },
    status(event, message) {
      statuses.push({ event, message })
    },
    output(data) {
      chunks.push(new Uint8Array(data))
    },
    hostKey(info) {
      sink.lastHostKey = info
      return options.acceptHostKey ?? true
    },
    ready(info) {
      readySignal.resolve(info)
    },
    exit(info) {
      exitSignal.resolve(info)
    },
    closed(reason, error) {
      closedSignal.resolve({ reason, ...(error ? { error } : {}) })
    },
    async waitForText(needle, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (sink.text().includes(needle)) return
        await sleep(25)
      }
      throw new Error(`Timed out waiting for terminal output: ${needle}`)
    },
  }
  return sink
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

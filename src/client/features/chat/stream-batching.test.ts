// @vitest-environment jsdom
/**
 * The text window a live turn opts into.
 *
 * A frame-by-frame stream is the contract every other reader of this transport relies on, so the window
 * is a caller's choice rather than a change to the wire. What has to hold for a live turn is that no words
 * are lost, that words written before a stage/tool/done frame stay before it, and that a turn cut short
 * still owns the words it had already written. A caller that asks for no window gets every frame.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatStreamEvent } from '@shared/assistant'
import { streamAssistantTurn } from './stream'

const frame = (payload: Record<string, unknown>): string => `data: ${JSON.stringify(payload)}\n\n`

/** One response whose bytes arrive as the given chunks; `error` closes it with a read failure instead. */
function stubBody(chunks: string[], error = false) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      // The bytes have to be read before the failure arrives, or there are no words to assert on.
      if (error) setTimeout(() => controller.error(new Error('the connection gave out')), 0)
      else controller.close()
    },
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })))
}

async function read(options?: { batchMs?: number }): Promise<ChatStreamEvent[]> {
  const seen: ChatStreamEvent[] = []
  try {
    await streamAssistantTurn({ message: 'a question' }, (event) => seen.push(event), new AbortController().signal, options)
  } catch {
    // A cut-short stream is one of the cases: the words already written are what this asserts.
  }
  return seen
}

const words = (events: ChatStreamEvent[]): string =>
  events.map((event) => (event.type === 'text' ? event.delta ?? '' : '')).join('')

afterEach(() => vi.unstubAllGlobals())

describe('a turn that opts into a text window', () => {
  it('hands one event to the store for a burst of text frames, keeping every word', async () => {
    stubBody([
      frame({ type: 'text', delta: 'half ' }) + frame({ type: 'text', delta: 'an ' }) + frame({ type: 'text', delta: 'answer' }),
    ])
    // A long window means the end of the stream, not the timer, is what flushes here.
    const seen = await read({ batchMs: 60_000 })
    expect(seen).toEqual([{ type: 'text', delta: 'half an answer' }])
  })

  it('flushes the words before a frame of another kind, so nothing is reordered', async () => {
    stubBody([
      frame({ type: 'text', delta: 'first ' }) + frame({ type: 'text', delta: 'words' })
        + frame({ type: 'stage', stage: 'reading' }) + frame({ type: 'text', delta: ' later' })
        + frame({ type: 'done' }),
    ])
    const seen = await read({ batchMs: 60_000 })
    expect(seen.map((event) => event.type)).toEqual(['text', 'stage', 'text', 'done'])
    expect(words(seen)).toBe('first words later')
  })

  it('keeps reasoning separate from the answer', async () => {
    stubBody([
      frame({ type: 'reasoning', delta: 'think ' }) + frame({ type: 'text', delta: 'say ' })
        + frame({ type: 'reasoning', delta: 'more' }),
    ])
    const seen = await read({ batchMs: 60_000 })
    expect(seen).toEqual([
      { type: 'text', delta: 'say ' },
      { type: 'reasoning', delta: 'think more' },
    ])
  })

  it('still owns the words it wrote when the connection gives out mid-turn', async () => {
    stubBody([frame({ type: 'text', delta: 'half an answer' })], true)
    expect(words(await read({ batchMs: 60_000 }))).toBe('half an answer')
  })
})

describe('a caller that asks for no window', () => {
  it('gets every frame, in order', async () => {
    stubBody([
      frame({ type: 'text', delta: 'half ' }) + frame({ type: 'text', delta: 'an ' }) + frame({ type: 'text', delta: 'answer' }),
    ])
    const seen = await read()
    expect(seen.map((event) => event.delta)).toEqual(['half ', 'an ', 'answer'])
  })
})

// @vitest-environment jsdom
/**
 * The composer's switch as it leaves the browser.
 *
 * The store hands the flag to the stream helper, and this is the other half: one key on the request
 * body, present only when the reader switched it on. A `webSearch:false` on every turn would be noise
 * the route ignores, and a missing `true` is a switch that does nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { streamAssistantTurn, type StreamTurnInput } from './stream'

function streamed(): Response {
  return new Response(new ReadableStream({ start(controller) { controller.close() } }), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function sentBody(input: StreamTurnInput): Promise<Record<string, unknown>> {
  let captured = ''
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    captured = String(init?.body ?? '')
    return streamed()
  }))
  await streamAssistantTurn(input, () => undefined, new AbortController().signal)
  vi.unstubAllGlobals()
  return JSON.parse(captured || '{}') as Record<string, unknown>
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
})

describe('the switch on the request body', () => {
  it('puts the flag on the wire when the reader asked for a live search', async () => {
    expect(await sentBody({ message: 'today', webSearch: true })).toMatchObject({ message: 'today', webSearch: true })
  })

  it('sends no flag when the switch is off', async () => {
    expect(await sentBody({ message: 'today', webSearch: false })).not.toHaveProperty('webSearch')
    expect(await sentBody({ message: 'today' })).not.toHaveProperty('webSearch')
  })
})

// @vitest-environment jsdom
/**
 * The turn-based voice conversation.
 *
 * The browser's recognition and speech engines are faked, and the assistant is a promise the test holds
 * the end of. What is pinned is the controller's own contract: a final sentence becomes one turn, the
 * answer is read aloud, the microphone opens again only after the voice stops, and a stop after the
 * question was heard can never be undone by an answer that arrives late.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import type { AnswerResult } from './editor-ai'
import type { SpeakHandlers } from './speech'
import { VoiceTurnController, type VoiceTurnDeps } from './voice-turn'
import type { SpeechEngine, SpeechResultEvent } from './voice-engine'

class FakeEngine implements SpeechEngine {
  lang = ''
  continuous = false
  interimResults = false
  onresult: ((event: SpeechResultEvent) => void) | null = null
  onend: (() => void) | null = null
  onerror: ((event?: { error?: string }) => void) | null = null
  start = vi.fn()
  stop = vi.fn()

  final(text: string): void {
    const results = { length: 1, 0: { isFinal: true, 0: { transcript: text } } }
    this.onresult?.({ resultIndex: 0, results } as unknown as SpeechResultEvent)
  }
}

interface Seen {
  phases: string[]
  lines: Array<{ role: string, text: string }>
  errors: string[]
  spoken: string[]
  handlers: SpeakHandlers[]
}

function harness(overrides: Partial<VoiceTurnDeps> = {}) {
  const engines: FakeEngine[] = []
  const seen: Seen = { phases: [], lines: [], errors: [], spoken: [], handlers: [] }
  const deps: VoiceTurnDeps = {
    language: 'en-US',
    createRecognition: () => {
      const engine = new FakeEngine()
      engines.push(engine)
      return engine
    },
    send: async (): Promise<AnswerResult> => ({ status: 'ok', text: 'An answer.' }),
    speak: (text, _language, handlers) => {
      seen.spoken.push(text)
      seen.handlers.push(handlers)
      return true
    },
    cancelSpeech: vi.fn(),
    onPhase: (phase) => seen.phases.push(phase),
    onLine: (role, text) => seen.lines.push({ role, text }),
    onError: (message) => seen.errors.push(message),
    ...overrides,
  }
  return { deps, engines, seen }
}

beforeEach(async () => {
  await initI18n()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the turn-based voice conversation', () => {
  it('turns one final sentence into a spoken answer, then listens again', async () => {
    const { deps, engines, seen } = harness()
    const controller = new VoiceTurnController(deps)
    controller.start()
    expect(engines).toHaveLength(1)
    expect(seen.phases).toEqual(['listening'])

    engines[0]!.final('What is in my inbox?')
    // The engine that heard the sentence is closed before the question is sent, so it cannot also hear
    // the answer being read aloud.
    expect(engines[0]!.stop).toHaveBeenCalledTimes(1)
    expect(seen.lines).toEqual([{ role: 'user', text: 'What is in my inbox?' }])
    expect(seen.phases).toEqual(['listening', 'thinking'])

    await vi.waitFor(() => expect(seen.phases).toContain('speaking'))
    expect(seen.lines).toEqual([
      { role: 'user', text: 'What is in my inbox?' },
      { role: 'assistant', text: 'An answer.' },
    ])
    expect(seen.spoken).toEqual(['An answer.'])

    // The microphone reopens only once the browser says the answer finished playing.
    expect(engines).toHaveLength(1)
    seen.handlers[0]!.onDone?.()
    expect(engines).toHaveLength(2)
    expect(seen.phases.at(-1)).toBe('listening')
  })

  it('does not let an answer arriving after stop reopen the microphone', async () => {
    let finish!: (result: AnswerResult) => void
    const send = (): Promise<AnswerResult> => new Promise((resolve) => { finish = resolve })
    const { deps, engines, seen } = harness({ send })
    const controller = new VoiceTurnController(deps)
    controller.start()
    engines[0]!.final('Remember this')

    controller.stop()
    finish({ status: 'ok', text: 'Too late.' })
    await Promise.resolve()
    await Promise.resolve()

    expect(seen.lines).toEqual([{ role: 'user', text: 'Remember this' }])
    expect(seen.spoken).toEqual([])
    expect(engines).toHaveLength(1)
    expect(seen.phases.at(-1)).toBe('idle')
  })

  it('says why the microphone produced nothing and stops listening', () => {
    const { deps, engines, seen } = harness()
    const controller = new VoiceTurnController(deps)
    controller.start()
    engines[0]!.onerror?.({ error: 'not-allowed' })

    expect(seen.errors).toEqual([t('assistant.composer.voice_denied')])
    expect(seen.phases).toEqual(['listening', 'error'])
  })

  it('names a turn that was refused because one was already running', async () => {
    const { deps, engines, seen } = harness({ send: async () => ({ status: 'busy' }) })
    const controller = new VoiceTurnController(deps)
    controller.start()
    engines[0]!.final('One more thing')

    await vi.waitFor(() => expect(seen.errors).toHaveLength(1))
    expect(seen.errors).toEqual([t('assistant.voice.busy')])
    expect(seen.phases.at(-1)).toBe('error')
  })

  it('reopens the microphone after silence, but not after being stopped', () => {
    vi.useFakeTimers()
    const { deps, engines } = harness()
    const controller = new VoiceTurnController(deps)
    controller.start()

    engines[0]!.onend?.()
    expect(engines).toHaveLength(1)
    vi.advanceTimersByTime(300)
    expect(engines).toHaveLength(2)

    controller.stop()
    engines[1]!.onend?.()
    vi.advanceTimersByTime(300)
    expect(engines).toHaveLength(2)
  })
})

// @vitest-environment jsdom
/**
 * Dictation: what the browser says, and what happens to the microphone.
 *
 * Two failures are pinned here because neither is visible in a screenshot. The first is repetition:
 * `SpeechRecognition.results` is the whole session's list, so a handler that walks all of it re-appends
 * every earlier sentence on each event, and walking it backwards puts a long sentence out of order. The
 * second is privacy: closing the panel that owns the button used to leave the engine running, which is
 * an open microphone behind a button nobody can see.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { VoiceButton } from './ComposerControls'

interface Recognized {
  text: string
  final: boolean
}

interface FakeResultEvent {
  resultIndex: number
  results: { length: number, [index: number]: { isFinal: boolean, 0: { transcript: string } } }
}

const harness = vi.hoisted(() => {
  const instances: FakeRecognition[] = []
  class FakeRecognition {
    lang = ''
    continuous = false
    interimResults = false
    onresult: ((event: FakeResultEvent) => void) | null = null
    onend: (() => void) | null = null
    onerror: (() => void) | null = null
    start = vi.fn()
    // A real engine reports `end` when it stops, and the component listens for it to drop the light.
    stop = vi.fn(() => { this.onend?.() })
    constructor() {
      instances.push(this)
    }
  }
  return { instances, FakeRecognition }
})

let root: Root
let host: HTMLElement
let mounted = false

function renderVoice(onText: (chunk: string) => void): void {
  root = createRoot(host)
  mounted = true
  act(() => { root.render(createElement(VoiceButton, { onText })) })
}

function unmountVoice(): void {
  mounted = false
  act(() => { root.unmount() })
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find(
    (node) => node.getAttribute('aria-label') === label,
  ) as HTMLButtonElement | undefined
}

function click(label: string): void {
  const control = button(label)
  if (!control) throw new Error(`the ${label} control is missing`)
  act(() => { control.click() })
}

/** One event as the browser reports it: only the entries from `resultIndex` on changed. */
function recognized(resultIndex: number, results: Recognized[]): FakeResultEvent {
  const list = results.map((result) => ({ isFinal: result.final, 0: { transcript: result.text } }))
  return { resultIndex, results: Object.assign(list, { length: results.length }) }
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  harness.instances.length = 0
  ;(window as unknown as Record<string, unknown>).SpeechRecognition = harness.FakeRecognition
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  if (mounted) unmountVoice()
  host?.remove()
  delete (window as unknown as Record<string, unknown>).SpeechRecognition
  vi.clearAllMocks()
})

describe('dictation', () => {
  it('appends each final phrase once, in the order it was spoken', () => {
    const heard: string[] = []
    renderVoice((chunk) => heard.push(chunk))
    click(t('assistant.composer.voice'))
    const engine = harness.instances[0]
    expect(engine, 'the engine should start when the button is pressed').toBeTruthy()
    expect(engine!.continuous).toBe(true)

    engine!.onresult?.(recognized(0, [{ text: 'one', final: true }]))
    // The list is cumulative: the second event carries "one" again and the new phrase.
    engine!.onresult?.(recognized(1, [{ text: 'one', final: true }, { text: 'two', final: true }]))
    // A browser that re-reports a finished phrase must not append it a third time.
    engine!.onresult?.(recognized(0, [{ text: 'one', final: true }, { text: 'two', final: true }]))

    expect(heard).toEqual(['one', 'two'])
  })

  it('waits for a phrase to be final before writing it', () => {
    const heard: string[] = []
    renderVoice((chunk) => heard.push(chunk))
    click(t('assistant.composer.voice'))
    const engine = harness.instances[0]!

    engine.onresult?.(recognized(0, [{ text: 'still typing', final: false }]))
    expect(heard).toEqual([])
    engine.onresult?.(recognized(0, [{ text: 'finished phrase', final: true }]))
    expect(heard).toEqual(['finished phrase'])
  })

  it('stops the engine when the panel that owns it goes away', () => {
    renderVoice(() => {})
    click(t('assistant.composer.voice'))
    const engine = harness.instances[0]!
    expect(engine.start).toHaveBeenCalled()

    unmountVoice()
    expect(engine.stop, 'the microphone stayed open after unmount').toHaveBeenCalled()
    expect(button(t('assistant.composer.voice_stop'))).toBeUndefined()
  })

  it('stops listening when the tab is hidden', () => {
    renderVoice(() => {})
    click(t('assistant.composer.voice'))
    const engine = harness.instances[0]!
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(engine.stop).toHaveBeenCalled()
    visibility.mockRestore()
  })
})

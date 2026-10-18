// @vitest-environment jsdom
/**
 * Dictation's three ways to be unavailable, and the one way a press has to be handled.
 *
 * The bug this pins is a control that looks alive: an icon in the row, a press that answers nothing, and
 * the reason parked in a modal a reader has to dismiss or in a hover they will never fire. Three different
 * facts make dictation impossible — the browser ships no engine, the page is not a secure context so the
 * microphone will never be handed out, and the reader said no — and each needs its own words, because
 * each one has a different fix.
 *
 * The second half is the gesture. `start()` is what asks for the microphone, and a browser only honours it
 * for a call made inside the press itself: a component that checks permission first (an `await`) loses the
 * gesture, and every press then fails for a reason the reader cannot act on. jsdom cannot grant a real
 * gesture, so the claim tested here is the structural one — the engine is constructed and started inside
 * the synchronous click, and a failed start leaves the button pressable again with its state taken back.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { VoiceButton } from './ComposerControls'

interface EngineError { error?: string }

const harness = vi.hoisted(() => {
  const instances: FakeRecognition[] = []
  // One module-level switch, shared by every engine built in this file: what the next `start()` does.
  // Per-instance fields would be shadowed by the class's own initializer, and a test that silently failed
  // to arm the refusal is how a green suite ends up guarding nothing.
  const state = { behaviour: 'ok' as 'ok' | 'throw' | string }
  class FakeRecognition {
    lang = ''
    continuous = false
    interimResults = false
    onresult: ((event: unknown) => void) | null = null
    onend: (() => void) | null = null
    onerror: ((event?: EngineError) => void) | null = null
    start = vi.fn(() => {
      if (state.behaviour === 'throw') throw new Error('start refused')
      if (state.behaviour !== 'ok') this.onerror?.({ error: state.behaviour })
    })
    stop = vi.fn(() => { this.onend?.() })
    constructor() {
      instances.push(this)
    }
  }
  return { instances, state, FakeRecognition }
})

let root: Root
let host: HTMLElement
let secure: (() => void) | null = null
const heard: string[] = []

function mount(withEngine = true): void {
  if (withEngine) (window as unknown as Record<string, unknown>).SpeechRecognition = harness.FakeRecognition
  else delete (window as unknown as Record<string, unknown>).SpeechRecognition
  root = createRoot(host)
  act(() => { root.render(createElement(VoiceButton, { onText: (chunk) => heard.push(chunk) })) })
}

function sayNoTo(value: string): void {
  harness.state.behaviour = value
  mount()
}

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
/** The dictation control, whichever of its two names it is wearing. */
function voice(): HTMLButtonElement | undefined {
  const start = t('assistant.composer.voice')
  const stop = t('assistant.composer.voice_stop')
  return buttons().find((node) => {
    const name = node.getAttribute('aria-label') ?? ''
    return name === start || name === stop || name.startsWith(`${start}: `)
  })
}

/** A disabled control's reason, read out of the node `aria-describedby` points at. */
function descriptionOf(node: Element | null | undefined): string {
  const ids = (node?.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
  return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim()
}

/** Words drawn in the row, as opposed to a name only an assistive technology is told. */
function drawnWords(): string {
  return document.body.textContent ?? ''
}

function press(): void {
  const control = voice()
  if (!control) throw new Error('the dictation control is missing')
  act(() => { control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  harness.instances.length = 0
  harness.state.behaviour = 'ok'
  heard.length = 0
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  secure?.()
  secure = null
  delete (window as unknown as Record<string, unknown>).SpeechRecognition
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

function pretendInsecure(): void {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'isSecureContext')
  Object.defineProperty(window, 'isSecureContext', { configurable: true, get: () => false })
  secure = () => {
    if (descriptor) Object.defineProperty(window, 'isSecureContext', descriptor)
    else delete (window as unknown as Record<string, unknown>).isSecureContext
  }
}

describe('a browser with no speech engine', () => {
  it('draws the control dead with its reason, and mounts no dialog to explain it', () => {
    mount(false)
    const control = voice()
    expect(control, 'dictation vanished instead of saying it is unavailable').toBeTruthy()
    expect(control?.hasAttribute('disabled'), 'a browser with no engine left the button pressable').toBe(true)
    // The reason is a node the control points at: a `title` alone is read by a hovering pointer only, so
    // a thumb and a keyboard get a dead icon and no sentence.
    expect(descriptionOf(control)).toContain(t('assistant.composer.voice_unsupported'))
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]'), 'a modal was mounted without a press').toBeNull()
    expect(harness.instances.length, 'the press reached an engine that cannot exist').toBe(0)
  })
})

describe('a page that is not a secure context', () => {
  it('names the address as the reason while the engine itself exists', () => {
    pretendInsecure()
    mount()
    const control = voice()
    expect(control?.hasAttribute('disabled'), 'http left a pressable microphone button in the row').toBe(true)
    expect(descriptionOf(control)).toContain(t('assistant.composer.voice_insecure'))
    // Not merely different words: the fix on http (open the app over https, or localhost) is not the fix
    // for a browser that ships no engine, so the two reasons must not read the same.
    expect(descriptionOf(control)).not.toContain(t('assistant.composer.voice_unsupported'))
    press()
    expect(harness.instances.length, 'a start was attempted where a microphone will never be granted').toBe(0)
  })
})

describe('a press that works', () => {
  it('starts the engine inside the press itself', () => {
    mount()
    // Asserted with no `await` between the click and the check: a permission probe first would leave the
    // engine un-started here, which is exactly the shape that loses the user gesture.
    press()
    expect(harness.instances.length).toBe(1)
    expect(harness.instances[0]!.start, 'the engine was constructed but never started').toHaveBeenCalled()
    expect(voice()?.getAttribute('aria-pressed'), 'the switch does not say it is listening').toBe('true')
  })

  it('takes the light back on the second press and stops the engine', () => {
    mount()
    press()
    const engine = harness.instances[0]!
    expect(voice()?.getAttribute('aria-label')).toBe(t('assistant.composer.voice_stop'))
    press()
    expect(engine.stop).toHaveBeenCalled()
    expect(voice()?.getAttribute('aria-pressed')).toBe('false')
  })
})

describe('a press the browser refuses', () => {
  it('says the microphone permission is what was refused, in words on the row', () => {
    sayNoTo('not-allowed')
    press()
    const alert = document.querySelector('[role="alert"]')
    expect(alert, 'the refusal reached no sentence at all').toBeTruthy()
    expect(alert?.textContent).toContain(t('assistant.composer.voice_denied'))
    expect(drawnWords()).toContain(t('assistant.composer.voice_denied'))
  })

  it('says there is no capture device when that is what is missing', () => {
    sayNoTo('audio-capture')
    press()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('assistant.composer.voice_no_mic'))
  })

  it('says the recognition service is what could not be reached', () => {
    sayNoTo('network')
    press()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('assistant.composer.voice_network'))
  })

  it('leaves the button pressable, and a press that works takes the notice away', () => {
    sayNoTo('not-allowed')
    press()
    const control = voice()
    expect(control?.hasAttribute('disabled'), 'a refused press turned the control dead for good').toBe(false)
    expect(control?.getAttribute('aria-pressed'), 'the button stayed lit over an engine that never started').toBe('false')
    harness.state.behaviour = 'ok'
    press()
    expect(harness.instances.length, 'the second press never reached the engine').toBe(2)
    expect(document.querySelector('[role="alert"]'), 'the old refusal is still on screen').toBeNull()
    expect(voice()?.getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps a silence that ended the session quiet', () => {
    // `no-speech` is the reader saying nothing and `aborted` is this app stopping the engine: neither is a
    // refusal, and a red line over either is what teaches a reader to skip the ones that matter.
    sayNoTo('no-speech')
    press()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(voice()?.getAttribute('aria-pressed')).toBe('false')
  })

  it('recovers the state when start() itself throws', () => {
    harness.state.behaviour = 'throw'
    mount()
    press()
    expect(voice()?.getAttribute('aria-pressed'), 'a thrown start left the listening state on').toBe('false')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('assistant.composer.voice_failed'))
    harness.state.behaviour = 'ok'
    press()
    expect(harness.instances.length).toBe(2)
    expect(voice()?.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('a phrase that arrives', () => {
  it('still reaches the composer with the words it was given', () => {
    mount()
    press()
    const engine = harness.instances[0]!
    const results = [{ isFinal: true, 0: { transcript: 'hello from the engine' } }]
    engine.onresult?.({ resultIndex: 0, results: Object.assign(results, { length: 1 }) })
    expect(heard).toEqual(['hello from the engine'])
  })
})

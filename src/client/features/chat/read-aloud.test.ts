// @vitest-environment jsdom
/**
 * Reading an answer aloud, and putting the voice back down.
 *
 * The failure this pins is a ghost: audio of an answer that is no longer on the screen. It arrives three
 * ways — the row is unmounted, the conversation is switched, or a second answer takes the one voice the
 * browser has — and each leaves the first row still claiming, in its own state, that it is reading. So
 * every case here is about a name, a pressed state, and how many times the fake engine was told to cancel.
 *
 * The engine is faked at module scope and shared across every request in the file, because the channel is
 * one per browser: a per-test instance would let two rows each believe they own it, which is the exact bug.
 *
 * jsdom has no `speechSynthesis` and no audio: nothing here is a claim that a voice was heard. The claims
 * are that the words handed to the engine are the answer with its markup taken out, that they arrive in
 * pieces the engine will not drop, and that every way of leaving the row takes the queue with it.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toPlainText } from '@shared/markdown-utils'
import { initI18n, getLocale, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useAssistant } from './assistant-store'
import { AssistantBubble, ReadAloudButton, splitForSpeech } from './MessageParts'

interface FakeEngineError { error?: string }

const harness = vi.hoisted(() => {
  const state = {
    /** Every utterance the component constructed, in the order it was constructed. */
    built: [] as Array<{ text: string, lang: string }>,
    /** What the engine has been handed and has not finished: the queue a ghost lives in. */
    queued: [] as Array<{ text: string, onend: (() => void) | null, onerror: ((event?: FakeEngineError) => void) | null }>,
    cancels: 0,
  }
  class FakeUtterance {
    text = ''
    lang = ''
    onend: (() => void) | null = null
    onerror: ((event?: FakeEngineError) => void) | null = null
    volume = 1
    constructor(text: string) {
      this.text = text
      state.built.push(this)
    }
  }
  const synth = {
    speaking: false,
    paused: false,
    pending: 0,
    speak(utterance: FakeUtterance) {
      // The engine drops a piece over roughly two hundred characters, and that is the boundary the
      // component has to stay inside — so the fake keeps what it was handed for the assertions to read.
      state.queued.push(utterance)
    },
    cancel() {
      state.cancels++
      const dropped = state.queued.splice(0)
      // A real engine reports the drop to whoever queued it; both callbacks exist in the wild, so the
      // component must survive the error half.
      for (const utterance of dropped) utterance.onerror?.({ error: 'canceled' })
    },
    getVoices: () => [],
    pause() {},
    resume() {},
  }
  return {
    state,
    FakeUtterance,
    synth,
    /** Lets the engine finish the piece at the head of its queue, as a voice finishing a sentence does. */
    finishNext: () => {
      const next = state.queued.shift()
      next?.onend?.()
      return next?.text ?? ''
    },
    /** The engine's own refusal, mid-answer. */
    failNext: (error: string) => {
      const next = state.queued.shift()
      next?.onerror?.({ error })
    },
  }
})

/**
 * The ceiling a piece has to stay under.
 *
 * Named here rather than imported: the guard is that the component cuts below a size the engine will not
 * drop, so a test that read the component's own constant would pass whatever the constant were.
 */
const ENGINE_PIECE_CEILING = 300

let root: Root
let host: HTMLElement

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const read = () => buttons().find((node) => {
  const name = node.getAttribute('aria-label') ?? ''
  return name === t('assistant.chat.read_aloud') || name === t('assistant.chat.read_stop')
})
const pressed = () => read()?.getAttribute('aria-pressed')
const drawnWords = () => document.body.textContent ?? ''

function descriptionOf(node: Element | null | undefined): string {
  const ids = (node?.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
  return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim()
}

function mount(element: React.ReactElement): void {
  root = createRoot(host)
  act(() => { root.render(element) })
}

function press(node: HTMLButtonElement | undefined = read()): void {
  expect(node, 'the read-aloud control is not drawn').toBeTruthy()
  act(() => { node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

/** Everything the engine was asked to read, in order — the answer as the voice got it. */
const spoken = () => harness.state.built.map((utterance) => utterance.text).join('')

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  harness.state.built.length = 0
  harness.state.queued.length = 0
  harness.state.cancels = 0
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: harness.synth })
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: harness.FakeUtterance })
  useAssistant.setState({ ...useAssistant.getState(), activeId: 'c-one' })
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  document.body.innerHTML = ''
  delete (window as unknown as Record<string, unknown>).speechSynthesis
  delete (window as unknown as Record<string, unknown>).SpeechSynthesisUtterance
  vi.clearAllMocks()
})

describe('the control', () => {
  it('is a button that says what pressing it does, and which way it is set', () => {
    mount(createElement(ReadAloudButton, { text: 'A settled **answer**.' }))
    const control = read()
    expect(control, 'the action row has no way to read the answer aloud').toBeTruthy()
    expect(control!.tagName).toBe('BUTTON')
    expect(control!.getAttribute('type')).toBe('button')
    expect(control!.getAttribute('aria-label')).toBe(t('assistant.chat.read_aloud'))
    expect(pressed()).toBe('false')
    expect(drawnWords()).toContain(t('assistant.chat.read_aloud'))
  })

  it('is drawn on a settled answer, next to the copy button', () => {
    mount(createElement(AssistantBubble, {
      text: 'The answer.', reasoning: '', tools: [], error: null, streaming: false, messageId: 'm1', modelLabel: 'DeepSeek',
    }))
    expect(read(), 'a stored answer offers no way to hear it').toBeTruthy()
  })

  it('says which browsers cannot read anything, and stays dead rather than pressing into nothing', () => {
    delete (window as unknown as Record<string, unknown>).speechSynthesis
    mount(createElement(ReadAloudButton, { text: 'An answer.' }))
    const control = read()
    expect(control, 'the control vanished instead of explaining itself').toBeTruthy()
    expect(control!.hasAttribute('disabled')).toBe(true)
    // The reason is a node the control points at: a `title` alone is a hovering pointer's only option.
    expect(descriptionOf(control)).toContain(t('assistant.chat.read_unavailable'))
    const before = harness.state.cancels
    act(() => { control!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(harness.state.built.length).toBe(0)
    expect(harness.state.cancels).toBe(before)
  })
})

describe('reading an answer', () => {
  it('hands the engine the words, not the markup', () => {
    mount(createElement(ReadAloudButton, { text: '## Heading\n\nSome **bold** words and a [link](https://example.test).' }))
    press()
    const heard = spoken()
    expect(heard).toContain('Some bold words and a link')
    expect(heard).not.toContain('##')
    expect(heard).not.toContain('**')
    expect(heard).not.toContain('https://example.test')
  })

  it('reads in the language the interface is set to, at the moment it was pressed', () => {
    mount(createElement(ReadAloudButton, { text: 'Just one sentence.' }))
    press()
    expect(harness.state.built[0]!.lang).toBe(getLocale())
  })

  it('reads a long answer piece by piece, and keeps the light up until the last one', () => {
    const long = 'Sentence about the note. '.repeat(40)
    mount(createElement(ReadAloudButton, { text: long }))
    press()
    expect(pressed()).toBe('true')
    // One piece is with the engine at a time: a row that handed the whole answer over at once would be a
    // row reading past the engine's own limit, which is how a voice stops mid-sentence without saying so.
    expect(harness.state.built.length).toBe(1)
    for (const utterance of harness.state.built) expect(utterance.text.length).toBeLessThanOrEqual(ENGINE_PIECE_CEILING)
    act(() => { harness.finishNext() })
    expect(harness.state.built.length, 'the engine finishing a piece did not hand it the next').toBe(2)
    expect(pressed(), 'the light came down with the answer still unfinished').toBe('true')
    let guard = 0
    while (harness.state.queued.length && ++guard < 40) {
      act(() => { harness.finishNext() })
      for (const utterance of harness.state.built) expect(utterance.text.length).toBeLessThanOrEqual(ENGINE_PIECE_CEILING)
    }
    expect(harness.state.built.length).toBeGreaterThan(2)
    expect(spoken()).toBe(toPlainText(long))
    expect(pressed(), 'the light stayed on over an engine with nothing left to read').toBe('false')
  })

  it('stops when pressed again, and says so in its own name', () => {
    mount(createElement(ReadAloudButton, { text: 'A long enough answer to still have pieces queued.' }))
    press()
    const cancels = harness.state.cancels
    expect(read()?.getAttribute('aria-label')).toBe(t('assistant.chat.read_stop'))
    press()
    expect(harness.state.cancels, 'a second press left the queue running').toBeGreaterThan(cancels)
    expect(harness.state.queued.length, 'the queue survived the stop').toBe(0)
    expect(pressed()).toBe('false')
    expect(read()?.getAttribute('aria-label')).toBe(t('assistant.chat.read_aloud'))
    // A voice the reader put down is not a failure, and a red line over a stop is how a real one gets
    // ignored.
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('draws nothing where there are no words to read', () => {
    mount(createElement(ReadAloudButton, { text: '   ' }))
    // Not a dead control with a reason: a browser that can speak is fine, there is simply nothing here to
    // hear, and a press that could only apologise for itself is the thing this app refuses to draw.
    expect(read()).toBeUndefined()
  })

  it('names a voice that died mid-answer in words on the row', () => {
    mount(createElement(ReadAloudButton, { text: 'An answer worth hearing.' }))
    press()
    act(() => { harness.failNext('not-allowed') })
    expect(pressed()).toBe('false')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('assistant.chat.read_failed'))
  })
})

describe('the voice that is left behind', () => {
  it('goes away with the row that started it', () => {
    mount(createElement(ReadAloudButton, { text: 'An answer about to disappear.' }))
    press()
    const cancels = harness.state.cancels
    act(() => { root.unmount() })
    expect(harness.state.cancels, 'unmount left an answer being read that is no longer on screen').toBeGreaterThan(cancels)
    expect(harness.state.queued.length).toBe(0)
    root = createRoot(document.createElement('div'))
  })

  it('goes away when the conversation it was read in is switched', () => {
    mount(createElement(ReadAloudButton, { text: 'An answer in this thread.' }))
    press()
    const cancels = harness.state.cancels
    act(() => { useAssistant.setState({ ...useAssistant.getState(), activeId: 'c-two' }) })
    expect(harness.state.cancels, 'switching threads left the old answer being read').toBeGreaterThan(cancels)
    expect(pressed()).toBe('false')
  })

  it('leaves the first answer alone when a second one takes the voice', () => {
    const hostA = document.createElement('div')
    const hostB = document.createElement('div')
    document.body.append(hostA, hostB)
    const rootA = createRoot(hostA)
    const rootB = createRoot(hostB)
    act(() => { rootA.render(createElement(ReadAloudButton, { text: 'The first answer.' })) })
    act(() => { rootB.render(createElement(ReadAloudButton, { text: 'The second answer.' })) })
    const controlA = () => [...hostA.querySelectorAll<HTMLButtonElement>('button')].find((node) => (node.getAttribute('aria-label') ?? '') !== '')
    const controlB = () => [...hostB.querySelectorAll<HTMLButtonElement>('button')].find((node) => (node.getAttribute('aria-label') ?? '') !== '')
    act(() => { controlA()!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(controlA()!.getAttribute('aria-pressed')).toBe('true')
    act(() => { controlB()!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    // One channel, one owner: the row that lost it has to stop saying it is reading.
    expect(controlA()!.getAttribute('aria-pressed'), 'two answers both claim to be reading').toBe('false')
    expect(controlB()!.getAttribute('aria-pressed')).toBe('true')
    // And it has to stop saying so without calling the hand-over a failure: another answer taking the
    // voice is the reader choosing, not a voice dying.
    expect(hostA.querySelector('[role="alert"]'), 'a hand-over was reported as a broken voice').toBeNull()
    act(() => { rootA.unmount(); rootB.unmount() })
    hostA.remove()
    hostB.remove()
  })
})

describe('the pieces themselves', () => {
  it('cuts on a boundary the engine will keep, and loses no word', () => {
    const source = 'One two three four. '.repeat(30)
    const pieces = splitForSpeech(source)
    expect(pieces.length).toBeGreaterThan(1)
    // The pieces are the answer: concatenated they are exactly what the words-only reading of it is, so
    // a cut neither drops a sentence nor reads one twice.
    expect(pieces.join('')).toBe(toPlainText(source))
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(ENGINE_PIECE_CEILING)
  })

  it('answers nothing for words there are none of', () => {
    expect(splitForSpeech('   ')).toEqual([])
    expect(splitForSpeech('')).toEqual([])
  })
})

// @vitest-environment jsdom
/**
 * The composer's keyboard contract.
 *
 * Escape is the key a reader reaches for when an answer is taking too long, so while a turn is running
 * it stops that turn — but only then. With no turn running it keeps its other meanings, a composition
 * owns it before the app does, and a picker panel that is already open takes it first. Enter still sends
 * what was typed, which is the neighbouring binding this one must not disturb.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useAssistant } from './assistant-store'
import { ChatComposer } from './ChatView'

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
  api: {
    search: vi.fn(async () => ({ results: [] })),
    tags: { list: vi.fn(async () => ({ tags: [] })) },
    folders: { list: vi.fn(async () => ({ folders: [] })) },
    notes: {},
    assistant: { skills: vi.fn(async () => ({ skills: [] })) },
  },
}))

const original = useAssistant.getState()

let root: Root
let host: HTMLElement
let mounted = false

function renderComposer(options: { streaming: boolean, onStop: () => void, onSend?: (text: string) => Promise<boolean> }): void {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mounted = true
  act(() => {
    root.render(createElement(ChatComposer, {
      streaming: options.streaming,
      sendOnEnter: true,
      onSend: options.onSend ?? (async () => true),
      onStop: options.onStop,
    }))
  })
}

function box(): HTMLTextAreaElement {
  const field = document.body.querySelector('textarea')
  if (!field) throw new Error('the composer has no text box')
  return field
}

function pressKey(key: string, init: KeyboardEventInit = {}): void {
  act(() => { box().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
}

/**
 * Types into the controlled box the way the browser does: value first, then the input event React reads.
 *
 * The wait inside the act lets the trigger panel's lookup settle under the same act() — it is an async
 * state update that would otherwise land after the event that started it had already been flushed.
 */
async function type(text: string): Promise<void> {
  const field = box()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(field, text)
    field.setSelectionRange(text.length, text.length)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  useAssistant.setState({
    ...original,
    pending: [],
    skills: [],
    models: [],
    providers: [],
    settings: null,
    turnTools: [],
    turnScopes: [],
    loadSkills: vi.fn(async () => undefined),
  })
})

afterEach(() => {
  if (mounted) act(() => { root.unmount() })
  mounted = false
  host.remove()
  useAssistant.setState(original, true)
  vi.clearAllMocks()
})

describe('stopping with Escape', () => {
  it('stops a running turn', () => {
    const onStop = vi.fn()
    renderComposer({ streaming: true, onStop })
    pressKey('Escape')
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('leaves Escape alone when nothing is running', () => {
    const onStop = vi.fn()
    renderComposer({ streaming: false, onStop })
    pressKey('Escape')
    expect(onStop).not.toHaveBeenCalled()
  })

  it('lets an input method own the key while a candidate is open', () => {
    const onStop = vi.fn()
    renderComposer({ streaming: true, onStop })
    pressKey('Escape', { isComposing: true })
    expect(onStop).not.toHaveBeenCalled()
  })

  it('closes an open picker before it stops the turn', async () => {
    const onStop = vi.fn()
    renderComposer({ streaming: true, onStop })
    // A trailing @ opens the note picker; its own Escape is that panel's, not the turn's.
    await type('look at @')
    expect(document.body.querySelector('[role="listbox"]'), 'the picker did not open').toBeTruthy()
    pressKey('Escape')
    expect(onStop).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="listbox"]')).toBeNull()
    // The panel is closed now, so the next press is the stop it was always meant to be.
    pressKey('Escape')
    expect(onStop).toHaveBeenCalledTimes(1)
  })
})

describe('sending', () => {
  it('still sends on Enter', async () => {
    const onStop = vi.fn()
    const onSend = vi.fn(async () => true)
    renderComposer({ streaming: false, onStop, onSend })
    await type('a question')
    pressKey('Enter')
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledWith('a question'))
    expect(onStop).not.toHaveBeenCalled()
  })

  it('hands the words back when the request never left', async () => {
    const onSend = vi.fn(async () => false)
    renderComposer({ streaming: false, onStop: vi.fn(), onSend })
    await type('a question the network refused')
    pressKey('Enter')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(box().value, 'the refused words were swallowed').toBe('a question the network refused')
  })
})

// @vitest-environment jsdom
/**
 * The three controls under the reader's own message.
 *
 * The row is the only place their words can be taken back out of the thread, so what is pinned is which
 * of them is drawn, what each one reaches — the clipboard, the editor, the confirmation — and that a
 * turn being written right now is left alone.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { MessageRow, UserBubble } from './ChatView'
import { useAssistant } from './assistant-store'

/** The confirm host is not mounted here, so the one dialog under test is answered by hand. */
const asked = vi.fn(async (_options: { title?: string, tone?: string }) => true)
vi.mock('../../components/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/overlay')>()
  return { ...actual, confirm: (options: { title?: string, tone?: string }) => asked(options) }
})

const original = useAssistant.getState()
const editMessage = vi.fn(async () => undefined)
const removeMessage = vi.fn(async () => undefined)
let root: Root
let host: HTMLElement

const ASK = 'What did I ask?'

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'user',
    content: ASK,
    tools: [],
    status: 'complete',
    error: null,
    createdAt: 1_700_000_000_000,
    source: 'chat',
    ...overrides,
  }
}

/** A control is found by its accessible name: every one of these is an icon on a hover row. */
const control = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
  .find((node) => node.getAttribute('aria-label') === label)
const byText = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
  .find((node) => node.textContent?.includes(text))
const click = async (node: HTMLButtonElement | undefined) => {
  expect(node, 'the control is not drawn').toBeTruthy()
  await act(async () => { node!.click() })
}
/**
 * Type into the box the way a keyboard does.
 *
 * React reads the value off the node when the event arrives, and jsdom's own setter is what the
 * reconciler tracks, so a plain assignment would leave the draft looking unchanged.
 */
const type = async (node: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  asked.mockClear()
  editMessage.mockClear()
  removeMessage.mockClear()
  useAssistant.setState({ ...original, activeId: 'c1', editMessage, removeMessage })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
})

describe("a stored message of the reader's", () => {
  it('copies the words back out, and says so on its own face', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    act(() => { root.render(createElement(MessageRow, { message: message() })) })
    await click(control(t('assistant.chat.copy')))
    expect(writeText).toHaveBeenCalledWith(ASK)
    expect(control(t('assistant.chat.copied')), 'the press said nothing back').toBeTruthy()
  })

  it('opens the words for retyping, and answers again from the new ones', async () => {
    act(() => { root.render(createElement(MessageRow, { message: message() })) })
    await click(control(t('assistant.chat.edit_message')))
    const box = document.body.querySelector<HTMLTextAreaElement>('textarea')
    expect(box?.value, 'the editor did not open on the message').toBe(ASK)
    await type(box!, 'What I meant')
    await click(byText(t('assistant.chat.edit_message_save')))
    expect(editMessage).toHaveBeenCalledWith('m1', 'What I meant')
  })

  it('keeps the save press out of reach until the words actually change', async () => {
    act(() => { root.render(createElement(MessageRow, { message: message() })) })
    await click(control(t('assistant.chat.edit_message')))
    const save = byText(t('assistant.chat.edit_message_save'))
    expect(save?.disabled, 'an unchanged message offers to be saved again').toBe(true)
    // Whitespace is not a rewrite: the words a model is answered from are the trimmed ones.
    await type(document.body.querySelector<HTMLTextAreaElement>('textarea')!, `${ASK} `)
    expect(byText(t('assistant.chat.edit_message_save'))?.disabled).toBe(true)
    await type(document.body.querySelector<HTMLTextAreaElement>('textarea')!, `${ASK} And why?`)
    expect(byText(t('assistant.chat.edit_message_save'))?.disabled).toBe(false)
  })

  it('asks before taking the turn back, and only then removes the pair', async () => {
    act(() => { root.render(createElement(MessageRow, { message: message() })) })
    asked.mockResolvedValueOnce(false)
    await click(control(t('assistant.chat.delete_message')))
    expect(asked).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.chat.delete_message_title'), tone: 'danger' }))
    expect(removeMessage).not.toHaveBeenCalled()
    asked.mockResolvedValueOnce(true)
    await click(control(t('assistant.chat.delete_message')))
    expect(removeMessage).toHaveBeenCalledWith('m1')
  })

  it('leaves a turn alone while a reply is being written', () => {
    act(() => { root.render(createElement(MessageRow, { message: message(), busy: true })) })
    expect(control(t('assistant.chat.edit_message'))?.disabled).toBe(true)
    expect(control(t('assistant.chat.delete_message'))?.disabled).toBe(true)
  })
})

describe('a turn that has no row yet', () => {
  it('offers a copy and nothing that would need a message to act on', () => {
    // The live turn draws the same words, under an id the server has not assigned.
    act(() => { root.render(createElement(UserBubble, { text: ASK })) })
    expect(control(t('assistant.chat.copy'))).toBeTruthy()
    expect(control(t('assistant.chat.edit_message'))).toBeUndefined()
    expect(control(t('assistant.chat.delete_message'))).toBeUndefined()
  })
})

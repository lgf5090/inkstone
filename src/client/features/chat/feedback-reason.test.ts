// @vitest-environment jsdom
/**
 * The grounds behind a thumbs-down.
 *
 * The card's shape is what a keyboard and a screen reader depend on, and jsdom draws none of it, so this
 * reads roles, names and the payload that left the client — the two halves worth pinning: that a verdict
 * can be taken back and explained, and that a reason never rides on an upvote.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import { useAssistant } from './assistant-store'
import { AssistantBubble } from './MessageParts'
import { FEEDBACK_REASONS, feedbackReasonText } from './feedback-reason'

// The route answers with the row it just wrote, so the store repaints from it exactly as it does in the
// product: an echo here is what proves the verdict the reader pressed is the one that stood.
const rateAnswerMock = vi.hoisted(() => vi.fn(async (_conversationId: string, _messageId: string, feedback: unknown) => ({ message: { feedback } })))

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  // The note store stamps every local write with this, so a module mock has to answer for it.
  CLIENT_ID: 'test-client',
  api: { assistant: { rateAnswer: rateAnswerMock, skills: vi.fn(async () => ({ skills: [] })) } },
}))

const rate = rateAnswerMock

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
/**
 * An exact name rather than a substring.
 *
 * `includes` would answer "Save" with the row "Save to a note" every bubble already draws, and a test that
 * pressed the wrong button is a test that proved nothing.
 */
const byName = (name: string) => buttons()
  .find((node) => ((node.getAttribute('aria-label') ?? node.textContent ?? '').trim() === name))
const card = () => document.body.querySelector<HTMLElement>('[data-feedback-reasons]')

function row(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    content: 'the answer',
    tools: [],
    status: 'complete',
    error: null,
    createdAt: 1_700_000_000_000,
    source: 'chat',
    ...over,
  }
}

let root: Root
let host: HTMLElement

/**
 * Mount, and re-mount from the store.
 *
 * `ChatView` hands the bubble the verdict it holds, so a test that pressed a thumb has to redraw with what
 * the store now says — otherwise the card would be looking at the verdict as it was before the press.
 */
function mount(): void {
  const feedback = useAssistant.getState().messages[0]?.feedback
  act(() => {
    root.render(createElement(AssistantBubble, {
      text: 'The answer.',
      reasoning: '',
      tools: [],
      error: null,
      streaming: false,
      messageId: 'm1',
      feedback,
      onRate: (value) => { void useAssistant.getState().rateAnswer('m1', value) },
    }))
  })
}

function open(): void {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mount()
}

async function press(node: HTMLButtonElement | null | undefined): Promise<void> {
  expect(node, 'the control is not drawn').toBeTruthy()
  await act(async () => {
    node!.click()
    await Promise.resolve()
  })
  mount()
}

const originalAssistant = useAssistant.getState()
const originalUi = useUi.getState()

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  rate.mockClear()
  useAssistant.setState({ ...originalAssistant, activeId: 'c1', messages: [row()] })
  useUi.setState({ ...originalUi })
  open()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(originalAssistant, true)
  useUi.setState(originalUi, true)
  vi.restoreAllMocks()
})

describe('the grounds card', () => {
  it('opens on a downvote with the five grounds and a line of the reader\'s own', async () => {
    await press(byName(t('assistant.chat.rate_down')))
    expect(card(), 'the grounds card never opened').toBeTruthy()
    expect(document.body.textContent).toContain(t('assistant.chat.reason_title'))
    for (const reason of FEEDBACK_REASONS) {
      const chip = document.body.querySelector<HTMLButtonElement>(`button[data-feedback-reason="${reason}"]`)
      expect(chip, `the ${reason} ground is missing`).toBeTruthy()
      expect(chip!.getAttribute('aria-pressed')).toBe('false')
    }
    expect(document.body.querySelector('input')).toBeTruthy()
    expect(byName(t('assistant.chat.reask'))).toBeTruthy()
    expect(byName(t('common.save'))).toBeTruthy()
  })

  it('records nothing on a card with nothing said, so its rows start disabled', async () => {
    await press(byName(t('assistant.chat.rate_down')))
    expect(byName(t('common.save'))!.disabled).toBe(true)
    expect(byName(t('assistant.chat.reask'))!.disabled).toBe(true)
  })

  it('says so when there is no conversation to write the grounds on', async () => {
    useAssistant.setState({ activeId: null })
    await press(byName(t('assistant.chat.rate_down')))
    await press(document.body.querySelector<HTMLButtonElement>('button[data-feedback-reason="wrong"]'))
    await press(byName(t('common.save')))
    expect(rate).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(t('assistant.embed.no_conversation'))
  })
})

describe('a verdict that can be taken back', () => {
  it('clears when the same thumb is pressed again, and closes the card', async () => {
    await press(byName(t('assistant.chat.rate_down')))
    expect(rate).toHaveBeenLastCalledWith('c1', 'm1', 'down')
    expect(useAssistant.getState().messages[0]!.feedback).toBe('down')

    await press(byName(t('assistant.chat.rate_down')))
    expect(rate).toHaveBeenLastCalledWith('c1', 'm1', null)
    expect(useAssistant.getState().messages[0]!.feedback).toBeUndefined()
    expect(byName(t('assistant.chat.rate_down'))!.getAttribute('aria-pressed')).toBe('false')
    expect(card()).toBeNull()
  })

  it('carries no reason on an upvote, however the panel was left', async () => {
    await press(byName(t('assistant.chat.rate_down')))
    await press(document.body.querySelector<HTMLButtonElement>('button[data-feedback-reason="incomplete"]'))
    await press(byName(t('assistant.chat.rate_up')))
    expect(rate).toHaveBeenLastCalledWith('c1', 'm1', 'up')
    // Every call this surface made is a verdict alone: the grounds only ever travel with a downvote.
    for (const call of rate.mock.calls) expect(call.length).toBeLessThanOrEqual(3)
  })
})

describe('the payload a reason sends', () => {
  it('sends the verdict and the grounds together', async () => {
    await press(byName(t('assistant.chat.rate_down')))
    await press(document.body.querySelector<HTMLButtonElement>('button[data-feedback-reason="wrong"]'))
    const chip = document.body.querySelector<HTMLButtonElement>('button[data-feedback-reason="wrong"]')!
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    const toast = vi.spyOn(useUi.getState(), 'toast')
    await press(byName(t('common.save')))
    expect(rate).toHaveBeenCalledWith('c1', 'm1', 'down', t('assistant.chat.reason_wrong'))
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.chat.reason_saved') }))
    expect(card()).toBeNull()
  })

  it('joins the reader\'s own line after the grounds they ticked', async () => {
    expect(feedbackReasonText(['wrong', 'off_topic'], '')).toBe(
      `${t('assistant.chat.reason_wrong')} · ${t('assistant.chat.reason_off_topic')}`,
    )
    expect(feedbackReasonText([], 'the fence is wrong')).toBe('the fence is wrong')
    expect(feedbackReasonText(['wrong'], '')).toBe(t('assistant.chat.reason_wrong'))
  })

  it('re-asks on those grounds, as the reader\'s own next message', async () => {
    const send = vi.fn(async () => true)
    useAssistant.setState({ send })
    await press(byName(t('assistant.chat.rate_down')))
    await press(document.body.querySelector<HTMLButtonElement>('button[data-feedback-reason="length"]'))
    await press(byName(t('assistant.chat.reask')))
    expect(rate).toHaveBeenCalledWith('c1', 'm1', 'down', t('assistant.chat.reason_length'))
    expect(send).toHaveBeenCalledWith(t('assistant.chat.reask_prompt', { grounds: t('assistant.chat.reason_length') }))
  })

  it('keeps what was typed when the grounds call is the one that fails', async () => {
    await press(byName(t('assistant.chat.rate_down')))
    // The verdict has already landed; only the call that carries the grounds is refused.
    rate.mockRejectedValueOnce(new Error('the route refused'))
    await press(document.body.querySelector<HTMLButtonElement>('button[data-feedback-reason="off_topic"]'))
    await press(byName(t('common.save')))
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('the route refused')
    expect(card(), 'the card closed on a failure').toBeTruthy()
    const chip = document.body.querySelector<HTMLButtonElement>('button[data-feedback-reason="off_topic"]')!
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    // And the downvote the reader pressed stands: a refused explanation takes the verdict back with it
    // nowhere.
    expect(useAssistant.getState().messages[0]!.feedback).toBe('down')
  })
})

describe('Escape from the card', () => {
  it('closes it and gives the focus back to the thumb that opened it', () => {
    const down = byName(t('assistant.chat.rate_down'))!
    act(() => { down.click() })
    mount()
    const cardElement = card()
    expect(cardElement).toBeTruthy()
    act(() => { cardElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(card()).toBeNull()
    expect(document.activeElement).toBe(down)
  })
})

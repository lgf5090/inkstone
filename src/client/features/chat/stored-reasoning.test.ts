// @vitest-environment jsdom
/**
 * What a reopened thread shows of the thinking behind an answer.
 *
 * The fold used to exist only while a turn was streaming, because the trace was never filed with the
 * answer. Now it is a column on the row, and this pins the join between the two: a message read from the
 * server hands its own reasoning to the bubble, and one that never had any draws no fold at all.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AssistantMessage } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { MessageRow } from './ChatView'
import { useAssistant } from './assistant-store'

const original = useAssistant.getState()
let root: Root
let host: HTMLElement

const TRACE = 'I checked the documentation before answering.'

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    content: 'THE ANSWER',
    tools: [],
    status: 'complete',
    error: null,
    createdAt: 1_700_000_000_000,
    source: 'chat',
    usage: { inputTokens: 10, outputTokens: 5 },
    durationMs: 1000,
    modelLabel: 'deepseek-chat',
    versionCount: 0,
    ...overrides,
  }
}

const fold = () => [...document.body.querySelectorAll('button')]
  .find((node) => node.textContent?.includes(t('assistant.chat.thought')))

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  useAssistant.setState({ ...original, activeId: 'c1' })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
})

describe('a stored answer', () => {
  it('folds the reasoning it was filed with, closed until the reader asks for it', () => {
    act(() => { root.render(createElement(MessageRow, { message: message({ reasoning: TRACE }) })) })
    expect(document.body.textContent).toContain('THE ANSWER')
    expect(document.body.textContent).not.toContain(TRACE)
    const button = fold()
    expect(button, 'the row carries a reasoning and nothing was drawn for it').toBeTruthy()
    expect(button?.getAttribute('aria-expanded')).toBe('false')
    act(() => { button!.click() })
    expect(document.body.textContent).toContain(TRACE)
    expect(button?.getAttribute('aria-expanded')).toBe('true')
  })

  it('draws no fold for an answer that never reported any', () => {
    act(() => { root.render(createElement(MessageRow, { message: message() })) })
    expect(document.body.textContent).toContain('THE ANSWER')
    expect(fold()).toBeUndefined()
  })
})

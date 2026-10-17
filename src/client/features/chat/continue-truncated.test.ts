// @vitest-environment jsdom
/**
 * Which answer the thread offers to carry on.
 *
 * The rule is the reader's, not the row's flag: an answer cut off at the output cap is stored as an
 * `error`, and hiding the control on every error hid it on the one case it is for. So the test asks
 * whether anything was written at all — the same question the worker asks before it agrees, which is
 * what keeps a control from appearing on a turn that would only be refused.
 */
import { describe, expect, it } from 'vitest'
import type { AssistantMessage } from '@shared/assistant'
import { canContinueAnswer } from './ChatView'

const CUT_OFF = 'The model was cut off at its 4096-token output limit, so the answer above stops where it does.'

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    content: 'A finished answer',
    tools: [],
    status: 'complete',
    error: null,
    createdAt: 1_700_000_000_000,
    source: 'chat',
    ...overrides,
  }
}

const LAST = 'm1'

describe('the answer a thread offers to continue', () => {
  it('offers a complete newest answer', () => {
    expect(canContinueAnswer(message(), false, LAST)).toBe(true)
  })

  it('offers a cut-off one, because its unfinished words are the whole point', () => {
    const truncated = message({ content: 'The harbour was built in', status: 'error', error: CUT_OFF })
    expect(canContinueAnswer(truncated, false, LAST)).toBe(true)
  })

  it('withholds a stopped answer that never got to write', () => {
    const wroteNothing = message({ content: '', status: 'error', error: 'I could not produce an answer this time.' })
    expect(canContinueAnswer(wroteNothing, false, LAST)).toBe(false)
  })

  it('withholds an answer whose only body is whitespace', () => {
    expect(canContinueAnswer(message({ content: '  \n ', status: 'error', error: CUT_OFF }), false, LAST)).toBe(false)
  })

  it('withholds an answer while one is still arriving', () => {
    const truncated = message({ content: 'The harbour was built in', status: 'error', error: CUT_OFF })
    expect(canContinueAnswer(truncated, true, LAST)).toBe(false)
  })

  it('withholds anything but the newest answer', () => {
    const truncated = message({ content: 'The harbour was built in', status: 'error', error: CUT_OFF })
    expect(canContinueAnswer(truncated, false, 'other')).toBe(false)
  })

  it('withholds the reader\'s own turns', () => {
    expect(canContinueAnswer(message({ role: 'user', content: 'A question' }), false, LAST)).toBe(false)
  })
})

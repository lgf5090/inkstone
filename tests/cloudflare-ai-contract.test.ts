import { describe, expect, it } from 'vitest'
import { readChatDelta } from '../src/client/features/cloudflare/api/ai'

describe('the chat stream delta', () => {
  it('reads content and reasoning from a delta', () => {
    expect(readChatDelta(JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] }))).toEqual({ content: 'Hi', reasoning: '', done: false })
    expect(readChatDelta(JSON.stringify({ choices: [{ delta: { reasoning_content: 'think' } }] }))).toEqual({ content: '', reasoning: 'think', done: false })
  })

  it('marks the terminal frame and the [DONE] sentinel', () => {
    expect(readChatDelta(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }))).toEqual({ content: '', reasoning: '', done: true })
    expect(readChatDelta('[DONE]')).toEqual({ content: '', reasoning: '', done: true })
  })

  it('answers an empty delta for a malformed frame instead of throwing', () => {
    expect(readChatDelta('not json')).toEqual({ content: '', reasoning: '', done: false })
    expect(readChatDelta('')).toEqual({ content: '', reasoning: '', done: false })
  })
})

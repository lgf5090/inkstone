import { describe, expect, it } from 'vitest'
import { diagnoseAssistantError } from '../src/client/features/chat/error-diagnosis'

describe('assistant error diagnosis', () => {
  it('maps the worker codes the turn can carry', () => {
    expect(diagnoseAssistantError('rate_limited').title).toBe('assistant.error.rate_limited.title')
    expect(diagnoseAssistantError('forbidden').settings).toBe(true)
    expect(diagnoseAssistantError('summary_unavailable').hint).toBe('assistant.error.summary.hint')
    expect(diagnoseAssistantError('conflict').title).toBe('assistant.error.conflict.title')
    expect(diagnoseAssistantError('stream').title).toBe('assistant.error.stream.title')
  })

  it('reads a stored row that has no code', () => {
    expect(diagnoseAssistantError(null, '429 Too Many Requests').title).toBe('assistant.error.rate_limited.title')
    expect(diagnoseAssistantError(undefined, '401 Unauthorized: bad api key').title).toBe('assistant.error.forbidden.title')
    expect(diagnoseAssistantError(null, 'maximum context length exceeded').title).toBe('assistant.error.summary.title')
  })

  it('does not invent an action from an unknown line', () => {
    const fallback = diagnoseAssistantError(null, 'something unexpected happened')
    expect(fallback.title).toBe('assistant.error.internal.title')
    expect(fallback.settings).toBe(false)
  })
})

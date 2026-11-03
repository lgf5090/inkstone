import { describe, expect, it } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, normalizeAssistantSettings } from '../src/shared/assistant'

/**
 * The settings added with the Agent/writing work are stored in the same untrusted JSON blob as the rest,
 * so their bounds are the only thing standing between a hand-edited config and a broken interface.
 */
describe('new assistant settings fields', () => {
  it('keeps the answers a reader can actually choose', () => {
    const settings = normalizeAssistantSettings({
      namingModelId: '01hzzzzzzzzzzzzzzzzzzzzz01',
      titlePrompt: 'Name it briefly.',
      autoRecover: false,
      requestTimeoutMs: 90_000,
      mentionMode: 'light',
      chatScale: 1.2,
      exportReasoning: true,
      exportToolCalls: true,
    })
    expect(settings.namingModelId).toBe('01hzzzzzzzzzzzzzzzzzzzzz01')
    expect(settings.titlePrompt).toBe('Name it briefly.')
    expect(settings.autoRecover).toBe(false)
    expect(settings.requestTimeoutMs).toBe(90_000)
    expect(settings.mentionMode).toBe('light')
    expect(settings.chatScale).toBe(1.2)
    expect(settings.exportReasoning).toBe(true)
    expect(settings.exportToolCalls).toBe(true)
  })

  it('clamps what cannot be used instead of storing it', () => {
    const settings = normalizeAssistantSettings({
      requestTimeoutMs: 1_000,
      chatScale: 9,
      mentionMode: 'everything',
    })
    expect(settings.requestTimeoutMs).toBe(5_000)
    expect(settings.chatScale).toBe(1.5)
    expect(settings.mentionMode).toBe(DEFAULT_ASSISTANT_SETTINGS.mentionMode)
  })

  it('keeps a blank title prompt as blank, because blank means the built-in one', () => {
    expect(normalizeAssistantSettings({ titlePrompt: '' }).titlePrompt).toBe('')
    expect(normalizeAssistantSettings({ titlePrompt: 'x'.repeat(9_000) }).titlePrompt).toHaveLength(4_000)
  })
})

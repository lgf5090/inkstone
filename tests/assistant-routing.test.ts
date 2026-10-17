/**
 * Which model answers a turn when the reader asked the assistant to choose.
 *
 * The rule is a policy, so it is tested as one: what may be picked at all (tools, a window that fits
 * with room to answer), and which of the eligible models wins (the smallest declared window, with an
 * undeclared one treated as the reader's default rather than as a small model).
 */
import { describe, expect, it } from 'vitest'
import type { AssistantModel } from '../src/shared/assistant'
import { pickModelForTurn } from '../src/shared/assistant-routing'

function model(over: Partial<AssistantModel> & { id: string }): AssistantModel {
  return {
    providerId: 'p1',
    model: over.id,
    label: over.id,
    temperature: null,
    maxOutputTokens: null,
    enabled: true,
    reasoning: 'auto',
    contextTokens: null,
    vision: true,
    purpose: 'chat',
    kind: 'chat',
    supportsTools: true,
    maxInputTokens: null,
    modalities: [],
    ...over,
  } as AssistantModel
}

describe('pickModelForTurn', () => {
  it('takes the smallest declared window that still holds the turn', () => {
    const picked = pickModelForTurn([
      model({ id: 'big', contextTokens: 1_000_000 }),
      model({ id: 'small', contextTokens: 32_000 }),
      model({ id: 'medium', contextTokens: 128_000 }),
    ], { estimatedTokens: 2_000, needsTools: false })
    expect(picked?.id).toBe('small')
  })

  it('drops a model whose window cannot hold the question and an answer', () => {
    const picked = pickModelForTurn([
      model({ id: 'tiny', contextTokens: 1_000 }),
      model({ id: 'roomy', contextTokens: 64_000 }),
    ], { estimatedTokens: 4_000, needsTools: false })
    // Four thousand tokens of question needs a window of at least eight thousand to answer in.
    expect(picked?.id).toBe('roomy')
  })

  it('only offers models that can call tools when the turn carries them', () => {
    const picked = pickModelForTurn([
      model({ id: 'no-tools', contextTokens: 8_000, supportsTools: false }),
      model({ id: 'tools', contextTokens: 64_000, supportsTools: true }),
    ], { estimatedTokens: 100, needsTools: true })
    expect(picked?.id).toBe('tools')
  })

  it('falls back to a model with no declared window only when no declared one fits', () => {
    const declared = pickModelForTurn([
      model({ id: 'default', contextTokens: null }),
      model({ id: 'declared', contextTokens: 32_000 }),
    ], { estimatedTokens: 1_000, needsTools: false })
    expect(declared?.id).toBe('declared')

    const only = pickModelForTurn([model({ id: 'default', contextTokens: null })], { estimatedTokens: 1_000, needsTools: false })
    expect(only?.id).toBe('default')
  })

  it('answers null when nothing can do the job, so the reader\'s own model stays', () => {
    const picked = pickModelForTurn([
      model({ id: 'disabled', contextTokens: 32_000, enabled: false }),
      model({ id: 'image', contextTokens: 32_000, purpose: 'image_generate' }),
    ], { estimatedTokens: 100, needsTools: false })
    expect(picked).toBeNull()
  })
})

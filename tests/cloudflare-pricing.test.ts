// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  estimateImageNeurons,
  estimateNeurons,
  estimateTranslationNeurons,
  estimateTtsNeurons,
} from '../src/worker/cloudflare/pricing'

describe('neuron estimates', () => {
  it('bills chat by token, with the cached prompt at its own rate', () => {
    // Llama 3.1 8B: 25.608 in / 75.147 out per thousand tokens.
    expect(estimateNeurons('@cf/meta/llama-3.1-8b-instruct', 1000, 1000)).toBe(101)
    expect(estimateNeurons('@cf/meta/llama-3.1-8b-instruct', 0, 0)).toBe(1)
    // Cached tokens never cost more than fresh ones, and never produce a negative bill.
    const cached = estimateNeurons('@cf/meta/llama-3.1-8b-instruct', 1000, 0, 1000)
    expect(cached).toBe(26)
  })

  it('falls back to the table default for an unknown model rather than to zero', () => {
    expect(estimateNeurons('@cf/nobody/knows-this-model', 1000, 1000)).toBe(90)
  })

  it('bills images per image and speech per thousand characters', () => {
    expect(estimateImageNeurons('@cf/stabilityai/stable-diffusion-v1-5')).toBe(671)
    expect(estimateImageNeurons('@cf/nobody/image')).toBe(1338)
    expect(estimateTtsNeurons('x'.repeat(1000), '@cf/deepgram/aura-1')).toBe(30)
    expect(estimateTtsNeurons('x'.repeat(1000), '@cf/nobody/voice')).toBe(30)
    expect(estimateTtsNeurons('x', '@cf/nobody/voice')).toBe(1)
  })

  it('bills translation as input plus output characters', () => {
    expect(estimateTranslationNeurons('x'.repeat(1000), '@cf/nobody/translation')).toBe(90)
    expect(estimateTranslationNeurons('', '@cf/nobody/translation')).toBe(1)
  })
})

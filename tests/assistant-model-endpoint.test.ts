// @vitest-environment node
/**
 * Which address a model is called on.
 *
 * One gateway key can answer on three wires, so the model names the protocol and the provider supplies
 * the address for it. What is pinned is the fallback order — a model that follows the provider, an
 * endpoint that was never filled in, and a stored map written by an older backup.
 */
import { describe, expect, it } from 'vitest'
import { modelEndpoint } from '../src/worker/assistant/model-config'
import type { ProviderRow } from '../src/worker/assistant/store'
import type { AssistantModel } from '@shared/assistant'

function provider(over: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: 'p1', label: 'Gateway', protocol: 'openai', base_url: 'https://gw.test/v1',
    endpoints: '{}', created_at: 1, updated_at: 1, ...over,
  }
}

function model(over: Partial<AssistantModel> = {}): AssistantModel {
  return {
    id: 'm1', providerId: 'p1', model: 'x', label: 'X', temperature: null, maxOutputTokens: 1024,
    enabled: true, reasoning: 'auto', contextTokens: null, vision: true, purpose: 'chat', kind: 'text',
    supportsTools: true, maxInputTokens: null, modalities: [], topP: null, customParams: [], protocol: null,
    ...over,
  }
}

describe('the endpoint a model is called through', () => {
  it('follows the provider when the model says nothing', () => {
    expect(modelEndpoint(model(), provider())).toEqual({ protocol: 'openai', baseUrl: 'https://gw.test/v1' })
  })

  it('takes the provider’s own address for the protocol it names', () => {
    const row = provider({ endpoints: JSON.stringify({ anthropic: 'https://gw.test/anthropic' }) })
    expect(modelEndpoint(model({ protocol: 'anthropic' }), row))
      .toEqual({ protocol: 'anthropic', baseUrl: 'https://gw.test/anthropic' })
  })

  it('falls back to the base URL when that protocol has no address of its own', () => {
    const row = provider({ endpoints: JSON.stringify({ anthropic: 'https://gw.test/anthropic' }) })
    expect(modelEndpoint(model({ protocol: 'gemini' }), row))
      .toEqual({ protocol: 'gemini', baseUrl: 'https://gw.test/v1' })
  })

  it('reads a blank or broken map as no extra addresses', () => {
    for (const stored of ['', '   ', '{not json', '[]', '{"gemini":"  "}']) {
      // The stored map goes to `expect`, which is where a failure message belongs; `toEqual` takes none.
      expect(modelEndpoint(model({ protocol: 'gemini' }), provider({ endpoints: stored })), stored)
        .toEqual({ protocol: 'gemini', baseUrl: 'https://gw.test/v1' })
    }
  })
})

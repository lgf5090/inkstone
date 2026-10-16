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
    inputPrice: null, outputPrice: null, priceCurrency: '',
    ...over,
  }
}

describe('the endpoint a model is called through', () => {
  it('follows the provider when the model says nothing', () => {
    expect(modelEndpoint(model(), provider())).toEqual({ protocol: 'openai', baseUrl: 'https://gw.test/v1', reasoningDialect: null })
  })

  it('takes the provider’s own address for the protocol it names', () => {
    const row = provider({ endpoints: JSON.stringify({ anthropic: 'https://gw.test/anthropic' }) })
    expect(modelEndpoint(model({ protocol: 'anthropic' }), row))
      .toEqual({ protocol: 'anthropic', baseUrl: 'https://gw.test/anthropic', reasoningDialect: null })
  })

  it('falls back to the base URL when that protocol has no address of its own', () => {
    const row = provider({ endpoints: JSON.stringify({ anthropic: 'https://gw.test/anthropic' }) })
    expect(modelEndpoint(model({ protocol: 'gemini' }), row))
      .toEqual({ protocol: 'gemini', baseUrl: 'https://gw.test/v1', reasoningDialect: null })
  })

  it('reads a blank or broken map as no extra addresses', () => {
    for (const stored of ['', '   ', '{not json', '[]', '{"gemini":"  "}']) {
      // The stored map goes to `expect`, which is where a failure message belongs; `toEqual` takes none.
      expect(modelEndpoint(model({ protocol: 'gemini' }), provider({ endpoints: stored })), stored)
        .toEqual({ protocol: 'gemini', baseUrl: 'https://gw.test/v1', reasoningDialect: null })
    }
  })

  it('carries the pin the reader set on the provider', () => {
    // What the reader pinned is the whole answer for an address nothing can be read from, so it travels with
    // the endpoint rather than being looked up again at the far end of the request path.
    expect(modelEndpoint(model(), provider({ reasoning_dialect: 'deepseek' })).reasoningDialect).toBe('deepseek')
  })

  it('drops a pin the wire it would be sent on cannot honour', () => {
    // An effort shape in a Gemini body would be a field nothing there reads, so the pin is not carried once
    // the model is switched to a protocol it does not belong to — the dialect is read off the address again.
    const row = provider({ protocol: 'gemini', base_url: 'https://gw.test/gemini', reasoning_dialect: 'claude-effort' })
    expect(modelEndpoint(model(), row).reasoningDialect).toBe(null)
    expect(modelEndpoint(model(), provider({ protocol: 'gemini', reasoning_dialect: 'gemini-level' })).reasoningDialect).toBe('gemini-level')
  })

  it('reads a stored pin an older build wrote as no pin', () => {
    for (const stored of ['', '   ', 'gpt5', 'DeepSeek']) {
      expect(modelEndpoint(model(), provider({ reasoning_dialect: stored })).reasoningDialect, stored).toBe(null)
    }
  })
})

/**
 * Which model answers.
 *
 * The reader picks one row of `chat_models`; the provider it belongs to supplies the address,
 * the protocol and the key. A model whose provider has gone away, or a stale id left behind by an
 * import, reads as "nothing configured" rather than throwing — the settings screen has to be able to
 * show a half-configured assistant so the reader can fix it.
 */

import type { AssistantModel, AssistantProtocol, AssistantSettings, ReasoningDialect } from '@shared/assistant'
import { modelWire, parseProviderEndpoints, reasoningDialectValue } from '@shared/assistant'
import { dialectsForProtocol } from '@shared/reasoning'
import type { AssistantStore } from './store'
import type { ProviderRow } from './store'

/**
 * Which door this model is called through, and what thinking shape that door speaks.
 *
 * A gateway can answer on more than one wire with the same key, so the model names the protocol and the
 * provider supplies the address for it. A protocol with no address of its own falls back to the provider's
 * base URL, which is what every provider written before this column had.
 *
 * The dialect rides along because it is read from the same two facts — the address, and the model's own
 * name — and because a pin that no longer fits the wire has to be dropped here rather than sent as a
 * field the far end does not know.
 */
export interface ModelEndpoint {
  protocol: AssistantProtocol
  baseUrl: string
  reasoningDialect: ReasoningDialect | null
}

export function modelEndpoint(model: AssistantModel, provider: ProviderRow): ModelEndpoint {
  const { protocol, baseUrl } = modelWire(model, {
    protocol: pickProtocol(provider.protocol),
    baseUrl: provider.base_url,
    endpoints: parseProviderEndpoints(provider.endpoints),
  })
  const pinned = reasoningDialectValue(provider.reasoning_dialect)
  return {
    protocol,
    baseUrl,
    reasoningDialect: pinned && dialectsForProtocol(protocol).includes(pinned) ? pinned : null,
  }
}

function pickProtocol(value: string): AssistantProtocol {
  return value === 'anthropic' || value === 'gemini' || value === 'openai' ? value : 'openai'
}

export interface ResolvedModel {
  model: AssistantModel | null
  provider: ProviderRow | null
  /** Why nothing was resolved, so the UI can say which of the two rows to fix. */
  reason: 'ok' | 'no_model' | 'no_provider'
}

export async function loadModelAndProvider(
  store: AssistantStore,
  settings: AssistantSettings,
  /**
   * A model chosen for this turn, which answers it instead of the reader's own.
   *
   * Two callers have one: the automatic router, which picked one out of the reader's catalogue, and a
   * request that named its own — and a named id is checked against this account's enabled `chat` models
   * where the request is read, because an answer from the default model would otherwise look exactly like
   * the answer that was asked for.
   */
  overrideModelId?: string | null,
): Promise<ResolvedModel> {
  const activeId = overrideModelId ?? settings.activeModelId
  if (!activeId) return { model: null, provider: null, reason: 'no_model' }
  const model = await store.getModel(activeId)
  if (!model || !model.enabled) return { model: null, provider: null, reason: 'no_model' }
  const provider = await store.providerRecord(model.providerId)
  if (!provider) return { model: null, provider: null, reason: 'no_provider' }
  return { model, provider, reason: 'ok' }
}

/** The first usable model, for the moment a reader adds a provider and has not picked yet. */
export async function suggestActiveModel(store: AssistantStore, settings: AssistantSettings): Promise<string | null> {
  if (settings.activeModelId) {
    const current = await store.getModel(settings.activeModelId)
    if (current?.enabled) return current.id
  }
  const models = (await store.listModels()).filter((model) => model.enabled)
  return models[0]?.id ?? null
}

/**
 * Which model answers.
 *
 * The reader picks one row of `chat_models`; the provider it belongs to supplies the address,
 * the protocol and the key. A model whose provider has gone away, or a stale id left behind by an
 * import, reads as "nothing configured" rather than throwing — the settings screen has to be able to
 * show a half-configured assistant so the reader can fix it.
 */

import type { AssistantModel, AssistantSettings } from '@shared/assistant'
import type { AssistantStore } from './store'
import type { ProviderRow } from './store'

export interface ResolvedModel {
  model: AssistantModel | null
  provider: ProviderRow | null
  /** Why nothing was resolved, so the UI can say which of the two rows to fix. */
  reason: 'ok' | 'no_model' | 'no_provider'
}

export async function loadModelAndProvider(store: AssistantStore, settings: AssistantSettings): Promise<ResolvedModel> {
  const activeId = settings.activeModelId
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

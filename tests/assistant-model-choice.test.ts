// @vitest-environment node
/**
 * What a resolution is allowed to name, which is what the interface is allowed to show.
 *
 * The composer chip and an answer's own footer both read one thing out to the reader: which model answered.
 * That makes this function the trust boundary for the *name*, not only for the call — a model id arrives
 * from the request (`TurnInput.modelId`), and a request can carry an id that is not this account's, is
 * switched off, or belongs to a provider that has gone away. Each of those has to resolve to nothing,
 * because an answer produced by the default model and shown under another account's name is a claim about a
 * cost nobody incurred.
 *
 * Two facts already exist and are deliberately not re-invented here: the per-turn name (`overrideModelId`)
 * and the daily cost rows keyed by `model_id`. What is pinned is which rows may come back out of them.
 */
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { newId } from '../src/worker/lib/id'
import { loadModelAndProvider, suggestActiveModel } from '../src/worker/assistant/model-config'
import type { Env } from '../src/worker/env'
import type { AssistantModel, AssistantSettings } from '../src/shared/assistant'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore
let settings: AssistantSettings
let small: AssistantModel
let large: AssistantModel

/** Another account, with a model the reader could name but must never be shown. */
function foreignStore(): AssistantStore {
  return new AssistantStore(env.DB as D1Database, OTHER, env)
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
  const provider = await store.createProvider({ label: 'Ours', protocol: 'openai', baseUrl: 'https://ours.example.test', apiKey: '' })
  small = await store.createModel({ providerId: provider.id, model: 'ours-small', label: 'Our small model' })
  large = await store.createModel({ providerId: provider.id, model: 'ours-large', label: 'Our large model' })
  const foreign = foreignStore()
  const theirs = await foreign.createProvider({ label: 'Theirs', protocol: 'openai', baseUrl: 'https://theirs.example.test', apiKey: '' })
  await foreign.createModel({ providerId: theirs.id, model: 'theirs', label: 'Their model' })
  settings = await store.saveSettings({ ...(await store.getSettings()), activeModelId: small.id, autoRoute: true })
})

afterEach(() => {
  sqlite.close()
})

describe('the model a resolution may name', () => {
  it('names the account’s own standing pick when the turn names nothing', async () => {
    const resolved = await loadModelAndProvider(store, settings)
    expect(resolved.reason).toBe('ok')
    expect(resolved.model?.id).toBe(small.id)
    expect(resolved.model?.label).toBe('Our small model')
    expect(resolved.provider?.id).toBe(small.providerId)
  })

  it('names the model a turn asked for, which is what pairs an answer with one', async () => {
    // Per-turn naming is not a new field: the router already answers on the id the request carried, and the
    // cost of doing so is filed under that model's own id.
    const resolved = await loadModelAndProvider(store, settings, large.id)
    expect(resolved.reason).toBe('ok')
    expect(resolved.model?.id).toBe(large.id)
  })

  it.each([
    ['an id that is nobody’s', () => Promise.resolve(newId())],
    ['another account’s model', async () => {
      const rows = await foreignStore().listModels()
      return rows[0]?.id ?? newId()
    }],
    ['a model the reader switched off', async () => {
      await store.updateModel(large.id, { enabled: false })
      return large.id
    }],
  ])('names nothing at all for %s, so no foreign label can reach the reader', async (_label, pick) => {
    const resolved = await loadModelAndProvider(store, settings, await pick())
    expect(resolved.model).toBeNull()
    expect(resolved.provider).toBeNull()
    expect(resolved.reason).toBe('no_model')
  })

  it('says the provider is what is broken, not the model', async () => {
    // The reader has to be told which of the two rows to fix; one sentence for both would send them to the
    // wrong screen, and a blank one would send them nowhere.
    const removed = sqlite.prepare('DELETE FROM chat_providers WHERE id = ?').run(small.providerId)
    expect(removed.changes).toBe(1)
    const resolved = await loadModelAndProvider(store, settings)
    expect(resolved.reason).toBe('no_provider')
    expect(resolved.model).toBeNull()
    expect(resolved.provider).toBeNull()
  })

  it('offers nothing when the account never picked a model', async () => {
    const empty = await store.saveSettings({ ...settings, activeModelId: null })
    const resolved = await loadModelAndProvider(store, empty)
    expect(resolved.reason).toBe('no_model')
    expect(resolved.model).toBeNull()
  })

  it('suggests only an enabled model of this account as the first pick', async () => {
    const empty = await store.saveSettings({ ...settings, activeModelId: null })
    expect(await suggestActiveModel(store, empty)).toBe(small.id)
    await store.updateModel(small.id, { enabled: false })
    await store.updateModel(large.id, { enabled: false })
    expect(await suggestActiveModel(store, empty)).toBeNull()
  })
})

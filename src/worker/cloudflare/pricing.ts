/**
 * What one AI request costs, in Cloudflare's neurons.
 *
 * The numbers come from `model-pricing.json`, which the reference module and this port share. A model
 * the table does not know falls back to the file's own default rather than to zero: a free-looking
 * estimate would let the quota screens stay green while the account is being drained.
 */
import { MODEL_PRICING } from './model-pricing'

interface Rate {
  input?: number
  output?: number
  cachedInput?: number
  perImage?: number
  perKChar?: number
}

interface PricingTable {
  models?: Record<string, Rate>
  default?: Rate
  defaultImage?: { perImage?: number }
  defaultTts?: { perKChar?: number }
}

const table = MODEL_PRICING as PricingTable

function rateOf(model: string): Rate {
  return table.models?.[model] ?? table.default ?? {}
}

/** Chat models bill by token, with a cheaper rate for the prompt half a provider served from cache. */
export function estimateNeurons(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0,
): number {
  const rate = rateOf(model)
  const cached = Math.max(0, cachedTokens)
  const normalInput = Math.max(0, Math.max(0, promptTokens) - cached)
  const cachedRate = rate.cachedInput ?? rate.input ?? 0
  const neurons =
    (normalInput / 1000) * (rate.input ?? 0) +
    (cached / 1000) * cachedRate +
    (Math.max(0, completionTokens) / 1000) * (rate.output ?? 0)
  return Math.max(1, Math.round(neurons))
}

/** Image models bill per image; the rate may differ per model. */
export function estimateImageNeurons(model: string): number {
  return rateOf(model).perImage ?? table.defaultImage?.perImage ?? 1338
}

/** Speech bills per thousand characters. */
export function estimateTtsNeurons(text: string, model: string): number {
  const perKChar = rateOf(model).perKChar ?? table.defaultTts?.perKChar ?? 30
  return Math.max(1, Math.round((text.length / 1000) * perKChar))
}

/** Translation is billed as input plus output characters, which the reference approximated as two rates. */
export function estimateTranslationNeurons(text: string, model: string): number {
  const rate = rateOf(model)
  const inputRate = rate.input ?? table.default?.input ?? 30
  const outputRate = rate.output ?? table.default?.output ?? 30
  return Math.max(1, Math.round((text.length / 1000) * (inputRate + outputRate)))
}

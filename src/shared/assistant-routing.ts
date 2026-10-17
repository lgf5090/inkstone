/**
 * Choosing the model for one turn, when the reader asked the assistant to choose.
 *
 * The rule is deliberately narrow: among the models that *can* answer this turn, take the one with the
 * smallest declared window that still holds it. A window is the only cost signal every provider gives
 * without the reader filling in prices, and a small window is what the fast, cheap members of a family
 * have. Nothing is chosen that could not do the job — a turn with tools only sees models marked for
 * tools, and a turn that fits none of them is answered by the reader's own model instead.
 */

import type { AssistantModel } from './assistant'

export interface RouteInput {
  /** The reader's words, estimated in tokens with the same rule the context budget uses. */
  estimatedTokens: number
  /** Whether this turn carries tools the model would have to be able to call. */
  needsTools: boolean
}

export function pickModelForTurn(models: readonly AssistantModel[], input: RouteInput): AssistantModel | null {
  const usable = models.filter((model) => model.enabled && model.purpose === 'chat')
    .filter((model) => !input.needsTools || model.supportsTools)
  if (!usable.length) return null
  // The turn has to fit with room to answer: a window that only holds the question leaves no space for
  // the reply, and a model that has to be cut off mid-answer is not a model that could do the job.
  const needed = Math.max(1_000, input.estimatedTokens * 2)
  const fits = usable.filter((model) => model.contextTokens === null || model.contextTokens >= needed)
  if (!fits.length) return null
  // A model with no declared window is the reader's account default, not a small one: it goes last so an
  // explicit number wins, and among the declared ones the smallest that still fits is the choice.
  const declared = fits.filter((model): model is AssistantModel & { contextTokens: number } => model.contextTokens !== null)
  if (declared.length) {
    return [...declared].sort((left, right) => left.contextTokens - right.contextTokens)[0] ?? null
  }
  return fits[0] ?? null
}

/**
 * The thinking levels one model is offered, as its own service names them.
 *
 * The composer's chip and the model dialog both list levels, and both have to list the same ones: a
 * service that publishes five rungs of effort should not be shown three, and one that can only be
 * switched on or off should not be shown five. The rule itself lives in `@shared/reasoning` and is read
 * by the worker when it builds the request; this is that rule asked the two questions the screens have —
 * which rungs, and can this model be stopped at all.
 */
import { modelWire, type AssistantModel, type AssistantProvider, type AssistantReasoning, type ReasoningDialect } from '@shared/assistant'
import { canDisableThinking, reasoningDialect, reasoningRungs } from '@shared/reasoning'

export interface ModelReasoning {
  dialect: ReasoningDialect
  /** The levels this model has, cheapest first, with `auto` as the first entry. */
  rungs: AssistantReasoning[]
  /** False when the service has no way to stop thinking, which the dialog says out loud. */
  canDisable: boolean
}

export function modelReasoning(model: AssistantModel, provider: AssistantProvider | null | undefined): ModelReasoning {
  // A model whose provider has gone missing reads as the plain OpenAI shape: a store never lists one, but
  // the settings screen has to be able to draw a half-configured assistant, and a guess with a safe
  // default is better than a screen that throws.
  if (!provider) {
    const rungs = reasoningRungs('openai')
    return { dialect: 'openai', rungs, canDisable: true }
  }
  const wire = modelWire(model, provider)
  const dialect = reasoningDialect(wire.protocol, wire.baseUrl, model.model, provider.reasoningDialect)
  return { dialect, rungs: reasoningRungs(dialect), canDisable: canDisableThinking(dialect, model.model) }
}

/**
 * The options a level picker draws: the model's own rungs, plus the stored level when it is not one of
 * them.
 *
 * A level can stop being offered — a model that could be switched off is replaced by one that cannot —
 * and a picker whose value is not in its own list would show the reader something other than what is
 * saved, or nothing at all. Keeping the odd value in the list is what makes the row honest; the note
 * beside it says what that level means on this model.
 */
export function reasoningOptions(reasoning: ModelReasoning, current: AssistantReasoning): AssistantReasoning[] {
  return reasoning.rungs.includes(current) ? reasoning.rungs : [...reasoning.rungs, current]
}

/**
 * What each model's own thinking switch is called, and which of its rungs a level lands on.
 *
 * One reader-facing level has to become different fields on different services, and getting that wrong is
 * not cosmetic: a field an endpoint does not know is refused outright by OpenAI's own service, Anthropic's
 * newest models reject the budget form its older ones require, and a `thinkingBudget` is not what a 3.x
 * Gemini reads as `thinkingLevel`. This file is the only place that knows what a level is called wherever
 * the model lives, and both sides of the app read it: the worker to build the request, the settings
 * screens to offer a model the levels its own service has rather than a list of five that may not fit.
 *
 * The dialect is decided from the endpoint and then from the model id, because the endpoint names the
 * vendor in most cases (its own host) and the model id names it when the endpoint is a gateway serving
 * several vendors (SiliconFlow, Together, Fireworks …). A reader can also pin it on the provider, which is
 * the only way to say what a custom gateway or a proxy is, and the pin wins over both readings.
 *
 * The rules below are each service's documentation as it stands today. Those pages could not be opened
 * from the build machine — Anthropic and Google answer this network with certificate errors and OpenAI's
 * model cards were unreachable — so they were read through their search-index excerpts; the DeepSeek
 * behaviour is the exception and was measured against a live key. Where a rule is model-specific rather
 * than vendor-wide it is applied only where it was read, and the comment beside it says so.
 */
import { REASONING_BUDGET_TOKENS, type AssistantProtocol, type AssistantReasoning, type ReasoningDialect } from './assistant'

/**
 * The levels in the order they spend thinking, `off` first.
 *
 * This is the app's own scale rather than any one vendor's, and `auto` is deliberately not on it: leaving
 * the decision to the model is a different thing from picking a rung.
 */
export const REASONING_SCALE: readonly AssistantReasoning[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * The rungs each dialect offers, cheapest first.
 *
 * A vendor's own app shows its own set — Claude five rungs of effort, Gemini three levels — so the list a
 * model is offered here is that set, not a fixed five for everybody. `auto` is on every list because it is
 * how a reader says "not my business", and a dialect without `off` is one whose service has no way to stop
 * thinking at all (see `canDisableThinking`), which the settings screen says out loud.
 */
const DIALECT_RUNGS: Record<ReasoningDialect, readonly AssistantReasoning[]> = {
  openai: ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  deepseek: ['auto', 'off', 'low', 'medium', 'high'],
  qwen: ['auto', 'off'],
  openrouter: ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gemini-budget': ['auto', 'off', 'minimal', 'low', 'medium', 'high'],
  'gemini-level': ['auto', 'minimal', 'low', 'medium', 'high'],
  'claude-budget': ['auto', 'off', 'minimal', 'low', 'medium', 'high'],
  'claude-effort': ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
}

/** The dialects a provider on this protocol can use, which is what the provider form offers. */
export function dialectsForProtocol(protocol: AssistantProtocol): ReasoningDialect[] {
  if (protocol === 'anthropic') return ['claude-budget', 'claude-effort']
  if (protocol === 'gemini') return ['gemini-budget', 'gemini-level']
  return ['openai', 'deepseek', 'qwen', 'openrouter']
}

/** The rungs a model on this dialect is offered, in the order the settings screen lists them. */
export function reasoningRungs(dialect: ReasoningDialect): AssistantReasoning[] {
  return [...DIALECT_RUNGS[dialect]]
}

export function reasoningDialect(
  protocol: AssistantProtocol,
  baseUrl: string,
  model: string,
  override?: ReasoningDialect | null,
): ReasoningDialect {
  // A pin is the reader saying what this address really is, so it is the end of the question: no host or
  // model name is consulted after it.
  if (override && dialectsForProtocol(protocol).includes(override)) return override
  if (protocol === 'anthropic') {
    const version = claudeVersion(model)
    // Adaptive thinking, with the depth as an effort beside it, is what 4.7 and later take; the older
    // `budget_tokens` form is refused by those, and an older model has no effort scale to read, so the
    // version decides and a name without one keeps the form it has always had.
    const adaptive = !!version && (version.major > 4 || (version.major === 4 && version.minor >= 7))
    return adaptive ? 'claude-effort' : 'claude-budget'
  }
  if (protocol === 'gemini') {
    const version = /gemini-(\d+)/.exec(model.toLowerCase())
    return version && Number(version[1]) >= 3 ? 'gemini-level' : 'gemini-budget'
  }
  const host = hostOf(baseUrl)
  if (host === 'openai.com' || host.endsWith('.openai.com')) return 'openai'
  if (host.includes('deepseek')) return 'deepseek'
  if (host.includes('aliyuncs.com')) return 'qwen'
  if (host.includes('openrouter.ai')) return 'openrouter'
  // A gateway serves several vendors from one address, so the model's own name is all that is left to go
  // on — and it is the right thing to go on, because the field follows the model the gateway forwards to.
  if (model.toLowerCase().includes('deepseek')) return 'deepseek'
  if (model.toLowerCase().includes('qwen')) return 'qwen'
  return 'openai'
}

/**
 * Whether this model can be asked not to think at all.
 *
 * False where the service has no such switch: Anthropic's newest models answer a disabled thinking block
 * with an error, and a 3.x Gemini has `MINIMAL` rather than none. A 2.5 Gemini can only be stopped when it
 * is a Flash or a Lite — its Pro models refuse a zero budget — so that one is decided by the model's name.
 */
export function canDisableThinking(dialect: ReasoningDialect, model: string): boolean {
  if (dialect === 'claude-effort' || dialect === 'gemini-level') return false
  if (dialect === 'gemini-budget') return /flash|lite/i.test(model)
  return true
}

/**
 * The rung a level becomes on this dialect.
 *
 * A dialect that has the level keeps it. One that does not takes the cheapest rung above it, so asking for
 * more thinking than a model offers gives that model's most rather than quietly less than was asked.
 *
 * Depth is never clamped down onto `off`: that rung is only ever what the reader asked for, and a dialect
 * whose switch has no depth between off and on (Qwen) would otherwise answer a request for thinking with a
 * request to stop thinking.
 */
export function clampRung(dialect: ReasoningDialect, level: AssistantReasoning): AssistantReasoning {
  if (level === 'auto') return 'auto'
  const rungs = DIALECT_RUNGS[dialect]
  // An explicit off is honoured wherever the dialect has the switch, and becomes that dialect's least
  // thinking — `MINIMAL` on a 3.x Gemini, a small budget on an older Claude — where it does not.
  if (level === 'off') return rungs.includes('off') ? 'off' : leastThinking(rungs)
  const wanted = REASONING_SCALE.indexOf(level)
  const offered = rungs.filter((rung) => rung !== 'auto' && rung !== 'off')
  for (const rung of offered) {
    if (REASONING_SCALE.indexOf(rung) >= wanted) return rung
  }
  // Nothing on the list is as deep as what was asked: a dialect with a top rung takes that one, and the one
  // with no depth at all has only its switch to answer with, at the vendor's own depth.
  return offered[offered.length - 1] ?? 'low'
}

/** The least a dialect can think without being stopped, which is its first rung above off. */
function leastThinking(rungs: readonly AssistantReasoning[]): AssistantReasoning {
  return rungs.find((rung) => rung !== 'auto' && rung !== 'off') ?? 'off'
}

/** The extra fields an OpenAI-shaped request carries for its thinking level. */
export function openAiReasoningFields(dialect: ReasoningDialect, level: AssistantReasoning): Record<string, unknown> {
  const rung = clampRung(dialect, level)
  if (rung === 'auto') return {}
  if (dialect === 'deepseek') {
    // Measured against a live key: `reasoning_effort` alone left the reasoning attached when the reader
    // asked for it off, and `thinking` is what actually stops it. The effort names are DeepSeek's own
    // rather than OpenAI's — none/low/high/max — so this level of ours lands on that ladder, not on the
    // word it happens to share.
    if (rung === 'off') return { thinking: { type: 'disabled' } }
    return { thinking: { type: 'enabled' }, reasoning_effort: rung === 'low' ? 'low' : rung === 'medium' ? 'high' : 'max' }
  }
  if (dialect === 'qwen') {
    // Alibaba's switch is a boolean, and the budget beside it is bounded per model — a number this side
    // cannot know — so only the switch is sent and the depth is the vendor's own. That is why this dialect
    // offers nothing between `off` and on.
    return { enable_thinking: rung !== 'off' }
  }
  if (dialect === 'openrouter') {
    // One normalized object, which OpenRouter maps onto whatever the upstream uses. Its off rung is
    // `none`, and its effort is not sent beside a token budget because the two are alternatives there.
    return { reasoning: { effort: rung === 'off' ? 'none' : rung } }
  }
  // OpenAI's own service reads `reasoning_effort` and refuses the fields it does not know, so the shape
  // that used to travel on both — a `thinking` object beside the effort — is narrowed to the one field
  // that is documented. `none` is the off rung of the models that publish one.
  return { reasoning_effort: rung === 'off' ? 'none' : rung }
}

export interface AnthropicReasoning {
  /** The `thinking` and `output_config` fields, or nothing when the level leaves the vendor alone. */
  fields: Record<string, unknown>
  /**
   * Whether the reader's temperature and top-p may travel at all.
   *
   * False for the newest models, which refuse a non-default sampling setting outright, and false for an
   * older model while it is thinking, which refuses a temperature other than 1.
   */
  sampling: boolean
}

export function anthropicReasoning(
  dialect: ReasoningDialect,
  level: AssistantReasoning,
  maxOutputTokens: number,
): AnthropicReasoning {
  const rung = clampRung(dialect, level)
  if (dialect === 'claude-effort') {
    // Adaptive thinking, steered by an effort. `auto` sends nothing, which leaves the model on the
    // thinking its own release notes describe as the default.
    if (rung === 'auto') return { fields: {}, sampling: false }
    return {
      fields: { thinking: { type: 'adaptive' }, output_config: { effort: effortFor(rung) } },
      sampling: false,
    }
  }
  // The older form: a budget under the answer ceiling, or nothing at all — which is how those models are
  // asked not to think, since they have no switch of their own.
  if (rung === 'auto' || rung === 'off') return { fields: {}, sampling: true }
  const budget = Math.min(budgetFor(rung), Math.max(1024, maxOutputTokens - 1024))
  return { fields: { thinking: { type: 'enabled', budget_tokens: Math.max(1024, budget) } }, sampling: false }
}

/** The `thinkingConfig` a dialect puts inside `generationConfig`, or nothing at all. */
export function geminiThinkingConfig(
  dialect: ReasoningDialect,
  level: AssistantReasoning,
  model: string,
): Record<string, unknown> {
  const rung = clampRung(dialect, level)
  if (rung === 'auto') return {}
  if (dialect === 'gemini-level') {
    // 3.x and later took a level instead of a budget, and refuse both in one request; the least they
    // offer is `MINIMAL`, which is why this dialect has no `off` and the settings screen says so.
    return { thinkingConfig: { thinkingLevel: GEMINI_LEVEL[rung], ...(rung === 'minimal' ? {} : { includeThoughts: true }) } }
  }
  if (rung === 'off') {
    // A zero budget is a switch only on the models that allow thinking to be turned off; a 2.5 Pro
    // answers it with `INVALID_ARGUMENT`, so it is left out there and the vendor's own default stands
    // rather than the request failing.
    return canDisableThinking(dialect, model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}
  }
  return { thinkingConfig: { thinkingBudget: budgetFor(rung), includeThoughts: true } }
}

/** Anthropic's effort scale, which stops at `high` on the models that publish it. */
function effortFor(rung: AssistantReasoning): string {
  if (rung === 'xhigh') return 'xhigh'
  if (rung === 'max') return 'max'
  if (rung === 'high') return 'high'
  if (rung === 'medium') return 'medium'
  return 'low'
}

/** Google's level names. `MINIMAL` is the least a 3.x model thinks, which is not the same as none. */
const GEMINI_LEVEL: Record<string, string> = { minimal: 'MINIMAL', low: 'LOW', medium: 'MEDIUM', high: 'HIGH' }

/** A rung's own number for the two services that take a token budget rather than a name. */
function budgetFor(rung: AssistantReasoning): number {
  return rung === 'auto' || rung === 'off' ? 0 : REASONING_BUDGET_TOKENS[rung]
}

/** Claude's version as its id spells it: `claude-opus-5.5`, `claude-sonnet-4-5`, `claude-3-5-sonnet`. */
function claudeVersion(model: string): { major: number, minor: number } | null {
  const match = /claude(?:-[a-z]+)*-(\d+)(?:[.-](\d+))?/.exec(model.toLowerCase())
  if (!match) return null
  return { major: Number(match[1]), minor: match[2] ? Number(match[2]) : 0 }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.toLowerCase()
  } catch {
    return ''
  }
}

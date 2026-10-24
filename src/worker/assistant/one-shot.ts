/**
 * One cheap, tool-less call to the reader's active model.
 *
 * The assistant makes several calls that are not turns: naming a thread, judging a conflicting note
 * write, summarising an overflow, translating a lyric. They share the same obligations — resolve the
 * account's model, sign with a key from that provider's ring, reserve one request from the day's
 * ceiling, meter what was actually spent, and stop after a deadline — and differ only in their
 * prompt and their budget. This is that shared path, kept in one place so a new one cannot quietly
 * forget the meter or the ceiling.
 *
 * Nothing here logs the prompt, the key or the answer: a failure is reported by its kind, because
 * those are the only facts the caller needs to choose between "no model", "no budget" and "the
 * provider refused".
 */

import { estimateTokens, type AssistantSettings } from '@shared/assistant'
import { loadModelAndProvider, modelEndpoint } from './model-config'
import { AbortError, streamUpstream } from './upstream'
import type { AssistantStore, ProviderRow } from './store'

export type OneShotFailure = 'no_model' | 'quota' | 'timeout' | 'aborted' | 'upstream'

/**
 * A one-shot call that did not produce text, with the reason kept as a value.
 *
 * `no_model` and `quota` are answers the caller can turn into a settings prompt or a wait; the
 * others are failures. The message is for the caller, not the reader, and never contains the prompt.
 */
export class OneShotError extends Error {
  constructor(readonly kind: OneShotFailure, message: string) {
    super(message)
    this.name = 'OneShotError'
  }
}

export interface OneShotRequest {
  system: string
  user: string
  /**
   * The model this call is for. Omitted means the reader's active model; a caller working beside a
   * turn passes that turn's model so the extra call is not answered by a different one than the
   * answer it belongs to.
   */
  modelId?: string
  maxOutputTokens: number
  temperature?: number
  /** The caller's own leash; the stream is aborted and the call reports `timeout`. */
  timeoutMs: number
  /** Ask the wire for a JSON object. A relay may ignore it, so the caller still parses the text. */
  structured?: boolean
  /** A stop of the reader's turn, watched rather than replaced. */
  signal?: AbortSignal
}

export interface OneShotResult {
  text: string
  usage: { inputTokens: number, outputTokens: number }
  modelLabel: string
}

/** The key this call signs with, taken from the provider's ring and marked as just used. */
async function signKey(store: AssistantStore, provider: ProviderRow): Promise<string> {
  const picked = await store.pickProviderKey(provider)
  if (!picked) return ''
  await store.markProviderKeyUsed(provider.id, picked.keyId)
  return picked.key
}

/**
 * Run one call and return its text and spend. Throws `OneShotError` and meters the failed attempt.
 *
 * The daily request is reserved before the key is signed, exactly as the naming pass always did:
 * a call with no budget left must not reach a provider, and a call that reaches one has been paid
 * for even when its answer is unusable.
 */
export async function runOneShot(
  store: AssistantStore,
  settings: AssistantSettings,
  request: OneShotRequest,
): Promise<OneShotResult> {
  const resolved = await loadModelAndProvider(store, settings, request.modelId ?? null)
  if (!resolved.model || !resolved.provider) {
    throw new OneShotError('no_model', 'No assistant model is configured.')
  }
  const model = resolved.model
  const provider = resolved.provider
  const call = modelEndpoint(model, provider)
  // Billing keeps the turn's own label exactly; the display name falls back to the wire model so a
  // caller that shows it (the translation badge) always has something to show.
  const modelLabel = model.label
  const displayLabel = model.label || model.model
  const keyRef = { providerId: provider.id, providerLabel: provider.label }
  if (!(await store.reserveRequests(1, settings.limits.maxRequestsPerDay, modelLabel, keyRef))) {
    throw new OneShotError('quota', 'The daily assistant request ceiling is spent.')
  }

  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort(request.signal?.reason)
  if (request.signal?.aborted) onAbort()
  else request.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, Math.max(1, request.timeoutMs))

  const spent = { inputTokens: 0, outputTokens: 0 }
  let text = ''
  try {
    for await (const event of streamUpstream(call.protocol, {
      baseUrl: call.baseUrl,
      apiKey: await signKey(store, provider),
      model: model.model,
      system: request.system,
      turns: [{ role: 'user', content: request.user }],
      tools: [],
      maxOutputTokens: request.maxOutputTokens,
      temperature: request.temperature ?? 0,
      reasoning: 'off',
      reasoningDialect: call.reasoningDialect,
      ...(request.structured ? { structured: true } : {}),
      signal: controller.signal,
    })) {
      if (event.type === 'text') text += event.delta
      if (event.type === 'usage') {
        // `max` rather than `+`: a provider that repeats a running total on `done` must not be
        // counted twice, and there is only one step here to add.
        spent.inputTokens = Math.max(spent.inputTokens, event.inputTokens)
        spent.outputTokens = Math.max(spent.outputTokens, event.outputTokens)
      }
    }
  } catch (error) {
    await store.incrementUsage({ errors: 1 }, undefined, modelLabel, keyRef)
    if (timedOut) throw new OneShotError('timeout', 'The model call ran past its deadline.')
    if (request.signal?.aborted || error instanceof AbortError) {
      throw new OneShotError('aborted', 'The model call was cancelled.')
    }
    throw new OneShotError('upstream', error instanceof Error ? `${error.name}: ${error.message}` : 'The model call failed.')
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', onAbort)
  }
  // A stream can end quietly when its controller aborts: the wire has no error to throw if the
  // response simply closes. The deadline still has to be the answer, not an empty success.
  if (timedOut) {
    await store.incrementUsage({ errors: 1 }, undefined, modelLabel, keyRef)
    throw new OneShotError('timeout', 'The model call ran past its deadline.')
  }

  // The call ran, so its tokens are paid for whether the answer is useful or not. Estimate when a
  // relay streamed no usage frame, so the reader is never quietly given a free call.
  const charged = spent.inputTokens || spent.outputTokens
    ? spent
    : { inputTokens: estimateTokens(`${request.system}\n${request.user}`), outputTokens: estimateTokens(text) }
  await store.incrementUsage(
    { inputTokens: charged.inputTokens, outputTokens: charged.outputTokens },
    undefined,
    modelLabel,
    keyRef,
  )
  return { text, usage: charged, modelLabel: displayLabel }
}

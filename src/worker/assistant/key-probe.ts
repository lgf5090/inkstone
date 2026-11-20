/**
 * Asking a provider whether a stored key still works.
 *
 * The only question a probe may answer is "did the provider accept this credential". It is deliberately
 * not a chat call: the cheapest free door every supported protocol has is its model listing, and a probe
 * that costs tokens is a probe nobody runs. When a provider does not publish that door the answer is
 * `probe_incompatible` rather than a guess.
 *
 * The shape of the answer is three outcomes, not two. A 429, a timeout or a 5xx says nothing about the
 * key, and reporting those as invalid is how a working credential gets deleted — so "cannot tell" is its
 * own result, with a reason that tells the reader whether to wait, retry later, or replace the key.
 */
import { assertRelayableEndpoint, pickRelayHeaders } from '@shared/ai-proxy-guard'
import type {
  AssistantKeyProbeOutcome,
  AssistantKeyProbeReason,
  AssistantProtocol,
} from '@shared/assistant'
import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'
import { vendorModelsEndpoint } from './vendor-models'

export interface KeyProbeResult {
  outcome: AssistantKeyProbeOutcome
  reason: AssistantKeyProbeReason | null
  /** Round-trip time, which is how a reader tells two working keys apart. Null when nothing was timed. */
  latencyMs: number | null
}

/** A probe is a diagnostic, not a turn: past this the reader is better served by "cannot tell". */
const PROBE_TIMEOUT_MS = 8_000

export async function probeProviderKey(
  protocol: AssistantProtocol,
  baseUrl: string,
  apiKey: string,
): Promise<KeyProbeResult> {
  let url: URL
  try {
    url = assertRelayableEndpoint(vendorModelsEndpoint(protocol, baseUrl))
  } catch {
    // An address the guard refuses is not a key problem, and saying "invalid key" here would send the
    // reader to rotate a credential that was never the issue.
    return { outcome: 'inconclusive', reason: 'probe_incompatible', latencyMs: null }
  }
  // Same header spelling as the listing and the chat call, so a key that works there works here.
  const headers = protocol === 'anthropic'
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', accept: 'application/json' }
    : protocol === 'gemini'
      ? { 'x-goog-api-key': apiKey, accept: 'application/json' }
      : { authorization: apiKey ? `Bearer ${apiKey}` : '', accept: 'application/json' }

  const started = Date.now()
  let response: Response
  try {
    response = await fetch(url.toString(), {
      method: 'GET',
      headers: pickRelayHeaders(headers) as Record<string, string>,
      redirect: NO_REDIRECT,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    const timedOut = name === 'TimeoutError' || name === 'AbortError'
    return {
      outcome: 'inconclusive',
      reason: timedOut ? 'timeout' : 'upstream_error',
      latencyMs: Date.now() - started,
    }
  }
  const latencyMs = Date.now() - started
  // The body is never read: a listing can be megabytes, and an error page is vendor text that has quoted
  // credentials before. The status is the whole answer.
  try { await response.body?.cancel() } catch {
    // The exchange is already over; a cancellation that fails has nothing left to release.
  }

  const status = response.status
  // A redirect is the guard's blind spot rather than the key's problem: the probe stops at the first
  // address it was allowed to call.
  if (isRedirectResponse(response)) return { outcome: 'inconclusive', reason: 'probe_incompatible', latencyMs }
  if (status >= 200 && status < 300) return { outcome: 'passed', reason: null, latencyMs }
  if (status === 401 || status === 403) return { outcome: 'failed', reason: 'invalid_credential', latencyMs }
  if (status === 429) return { outcome: 'inconclusive', reason: 'rate_limited', latencyMs }
  // 404/405 is the one address shape this vendor does not publish. The chat call may still work.
  if (status === 404 || status === 405) return { outcome: 'inconclusive', reason: 'probe_incompatible', latencyMs }
  if (status >= 500) return { outcome: 'inconclusive', reason: 'upstream_error', latencyMs }
  return { outcome: 'inconclusive', reason: 'unknown', latencyMs }
}

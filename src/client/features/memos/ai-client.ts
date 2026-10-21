/**
 * The memo app's calls into the account's assistant providers.
 *
 * `api.ts` owns the memo REST surface and is closed to new groups, so the microphone's two calls live
 * here — built on the same `memoRequest` transport, which keeps the shared client headers, the abort
 * signal and the `ApiError` shape the surfaces already know how to report.
 *
 * The provider shape is restated rather than imported from the worker: the display layer may not reach
 * into `src/worker`, and `tests/memos-ai.test.ts` reads the route's own answer so the two cannot drift.
 * Nothing here carries a credential, because the route does not send one.
 */
import type { AssistantProtocol } from '@shared/assistant'
import type { MemoTranscriptionResult } from '@shared/memos/types'
import { memoRequest } from './api'

/** The protocols the transcription call can put a recording through. */
export const MEMO_TRANSCRIPTION_PROTOCOLS = ['openai', 'gemini'] as const

/** One provider `GET /api/memos/ai/providers` describes, narrowed to what a recording needs. */
export interface MemoAiProvider {
  id: string
  label: string
  protocol: AssistantProtocol
  /** The enabled text models that may answer the transcription call, in the reader's own order. */
  models: string[]
}

/** The provider and model one recording is sent to. */
export interface MemoTranscriptionTarget {
  providerId: string
  model: string
}

/**
 * The first provider and model a recording can be sent to, or null when the account has none.
 *
 * Anthropic has no audio endpoint this app can call, so a listing that only holds one is the same
 * answer as an empty listing: the caller says which settings to fill in rather than spending a request
 * that is certain to be refused. The first model is the reader's first choice — the listing is already
 * in the order their provider screen shows.
 */
export function memoTranscriptionTarget(
  providers: readonly MemoAiProvider[],
): MemoTranscriptionTarget | null {
  for (const provider of providers) {
    if (!(MEMO_TRANSCRIPTION_PROTOCOLS as readonly string[]).includes(provider.protocol)) continue
    const model = provider.models[0]
    if (model) return { providerId: provider.id, model }
  }
  return null
}

export const memoAi = {
  providers(signal?: AbortSignal): Promise<MemoAiProvider[]> {
    return memoRequest<{ providers: MemoAiProvider[] }>('/ai/providers', { signal })
      .then((answer) => answer.providers)
  },

  transcribe(form: FormData, signal?: AbortSignal): Promise<MemoTranscriptionResult> {
    return memoRequest<MemoTranscriptionResult>('/ai/transcribe', {
      method: 'POST',
      formData: form,
      signal,
    })
  },
}

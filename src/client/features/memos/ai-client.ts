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
 * The provider and model a recording is sent to, or null when the account has none.
 *
 * A configured provider wins when the listing still holds it; otherwise the first usable one does, so
 * a deleted provider or model falls back instead of failing the recording. Anthropic has no audio
 * endpoint this app can call, so a listing that only holds one is the same answer as an empty listing.
 */
export function memoTranscriptionTarget(
  providers: readonly MemoAiProvider[],
  preferred?: { providerId?: string | null; model?: string | null },
): MemoTranscriptionTarget | null {
  const usable = providers.filter((provider) => (
    (MEMO_TRANSCRIPTION_PROTOCOLS as readonly string[]).includes(provider.protocol)
    && provider.models.length > 0
  ))
  const chosen = preferred?.providerId
    ? usable.find((provider) => provider.id === preferred.providerId)
    : undefined
  const provider = chosen ?? usable[0]
  if (!provider) return null
  const model = preferred?.model && provider.models.includes(preferred.model)
    ? preferred.model
    : provider.models[0]
  return model ? { providerId: provider.id, model } : null
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

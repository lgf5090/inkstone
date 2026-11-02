import type { MessageKey } from '../../lib/i18n'

export interface AssistantErrorDiagnosis {
  title: MessageKey
  hint: MessageKey
  /** Which settings surface answers this failure, or null when nothing on that side can. */
  settings: boolean
}

const BY_CODE: Record<string, AssistantErrorDiagnosis> = {
  rate_limited: {
    title: 'assistant.error.rate_limited.title',
    hint: 'assistant.error.rate_limited.hint',
    settings: true,
  },
  forbidden: {
    title: 'assistant.error.forbidden.title',
    hint: 'assistant.error.forbidden.hint',
    settings: true,
  },
  summary_unavailable: {
    title: 'assistant.error.summary.title',
    hint: 'assistant.error.summary.hint',
    settings: false,
  },
  conflict: {
    title: 'assistant.error.conflict.title',
    hint: 'assistant.error.conflict.hint',
    settings: false,
  },
  not_found: {
    title: 'assistant.error.not_found.title',
    hint: 'assistant.error.not_found.hint',
    settings: false,
  },
  stream: {
    title: 'assistant.error.stream.title',
    hint: 'assistant.error.stream.hint',
    settings: false,
  },
  internal: {
    title: 'assistant.error.internal.title',
    hint: 'assistant.error.internal.hint',
    settings: false,
  },
  bad_request: {
    title: 'assistant.error.bad_request.title',
    hint: 'assistant.error.bad_request.hint',
    settings: false,
  },
}

/**
 * The sentence a reader can act on, from the code the worker sent.
 *
 * A stored turn has no code — the row keeps the provider's line, not this app's — so the text is read as
 * a fallback. That fallback is deliberately narrow: guessing "quota" from an arbitrary sentence would
 * point a reader at the wrong settings page, and the raw line is still in the card's detail.
 */
export function diagnoseAssistantError(code: string | null | undefined, message?: string | null): AssistantErrorDiagnosis {
  if (code && BY_CODE[code]) return BY_CODE[code]
  const text = (message ?? '').toLowerCase()
  if (/rate limit|quota|429|too many requests/.test(text)) return BY_CODE.rate_limited
  if (/unauthori[sz]ed|forbidden|401|403|api key|credential/.test(text)) return BY_CODE.forbidden
  if (/context|window|too many tokens|token limit/.test(text)) return BY_CODE.summary_unavailable
  return BY_CODE.internal
}

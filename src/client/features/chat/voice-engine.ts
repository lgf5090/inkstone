/**
 * The browser's own dictation, as much of it as this app uses.
 *
 * Kept apart from the composer because two surfaces now listen: the microphone button that types into
 * the box, and the voice conversation that takes a whole turn. Both need the same engine shape, the
 * same secure-context check and the same words for why a press produced no microphone.
 */
import { t, type MessageKey } from '../../lib/i18n'

/** One phrase the browser recognised. Final results are the only ones that may become text. */
export interface SpeechResult {
  isFinal: boolean
  0: { transcript: string }
}

/** The event shape `SpeechRecognition.onresult` sends; `resultIndex` is where this event starts. */
export interface SpeechResultEvent {
  /** The first result this event changed. Everything before it was reported by an earlier event. */
  resultIndex: number
  results: { length: number, [index: number]: SpeechResult }
}

export interface SpeechEngine {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: SpeechResultEvent) => void) | null
  onend: (() => void) | null
  /**
   * The engine's own report of why a session ended badly.
   *
   * Read for `error`, and only optionally: the Web Speech spec puts the reason on the event, but a
   * browser — and the test engine this file is driven by — may call the handler with nothing, which
   * has to be reported as a failure rather than silently swallowed.
   */
  onerror: ((event?: { error?: string }) => void) | null
  start: () => void
  stop: () => void
}

export function speechRecognitionCtor(): (new () => SpeechEngine) | null {
  if (typeof window === 'undefined') return null
  const scope = window as unknown as Record<string, unknown>
  return (scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null) as (new () => SpeechEngine) | null
}

/** Why dictation cannot be offered at all, before anybody presses it. */
export type VoiceBlocker = 'none' | 'unsupported' | 'insecure'

/**
 * Whether this browser can be asked for a microphone at all, and which of the two facts says it cannot.
 *
 * The engine's absence is the obvious half. The second is the one that used to look like a broken button:
 * recognition records audio through `getUserMedia`, and a browser only hands that out on a potentially
 * trustworthy URL, so on plain http the engine exists, `start()` is refused with a permission-shaped
 * error, and the reader has a lit icon and nothing else. Checking the context is free; checking it after
 * the press would be the same modal in a later frame.
 */
export function voiceBlocker(): VoiceBlocker {
  if (!speechRecognitionCtor()) return 'unsupported'
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure'
  return 'none'
}

/** The blocker a disabled control explains, in the words the reader can act on. */
export function voiceBlockerReason(blocker: Exclude<VoiceBlocker, 'none'>): MessageKey {
  return blocker === 'insecure' ? 'assistant.composer.voice_insecure' : 'assistant.composer.voice_unsupported'
}

/** How an engine ends without being refused anything: nobody spoke, and this app stopped it. */
const VOICE_ENDINGS = ['aborted', 'no-speech', 'silent'] as const

/**
 * The sentence a failed press owes the reader, or null when nothing went wrong.
 *
 * Unknown names answer with the general reason rather than with silence: a failure this table has never
 * seen is still a press that produced no microphone, and an unexplained one is the bug this whole branch
 * exists to kill.
 */
export function voiceRefusal(error: string | undefined): string | null {
  if (!error) return t('assistant.composer.voice_failed')
  if ((VOICE_ENDINGS as readonly string[]).includes(error)) return null
  if (error === 'not-allowed' || error === 'service-not-allowed') return t('assistant.composer.voice_denied')
  if (error === 'audio-capture') return t('assistant.composer.voice_no_mic')
  if (error === 'network') return t('assistant.composer.voice_network')
  return t('assistant.composer.voice_failed')
}

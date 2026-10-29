/**
 * The memo composer's voice recorder: the shared hook with the composer's own wording and file names.
 *
 * The session lifecycle lives in `lib/use-voice-recorder`; this wrapper only binds the message keys the
 * composer shows and the `memo-voice-*` name its transcription expects, so the composer keeps its
 * existing contract while other surfaces use the same recorder.
 */
import { useVoiceRecorder, type VoiceRecorderErrorKeys, type VoiceRecorderStatus } from '../../lib/use-voice-recorder'
import type { MessageKey } from '../../lib/i18n'

export type MemoRecorderStatus = VoiceRecorderStatus

export interface MemoRecorder {
  status: MemoRecorderStatus
  /** Whole seconds since this session began recording; zero while idle. */
  seconds: number
  /** Why a session ended without a recording, for the caller to report once; null when all is well. */
  error: MessageKey | null
  /** Asks for the microphone and begins recording. Null means it started; otherwise, what to tell. */
  start: () => Promise<MessageKey | null>
  /** Ends the session. Resolves with the recording, or null when nothing usable was captured. */
  stop: () => Promise<File | null>
  /** Marks the last `error` as reported, so the same failure can be raised again next time. */
  clearError: () => void
}

const MEMO_ERROR_KEYS = {
  unsupported: 'memos.composer.voice_unsupported',
  denied: 'memos.composer.voice_denied',
  noMic: 'memos.composer.voice_no_mic',
  failed: 'memos.composer.voice_failed',
} as const satisfies VoiceRecorderErrorKeys

export function useMemoRecorder(): MemoRecorder {
  const recorder = useVoiceRecorder({
    filePrefix: 'memo-voice',
    errorKeys: MEMO_ERROR_KEYS,
  })
  return {
    status: recorder.status,
    seconds: recorder.seconds,
    // The shared hook deals in plain strings so it stays independent of the message catalog. These
    // four are catalog entries by construction, so the composer's narrower type is restored here.
    error: recorder.error as MessageKey | null,
    start: recorder.start as () => Promise<MessageKey | null>,
    stop: recorder.stop,
    clearError: recorder.clearError,
  }
}

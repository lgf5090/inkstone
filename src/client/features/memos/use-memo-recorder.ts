/**
 * The browser's own voice recorder, as much of it as the memo composer uses.
 *
 * It owns exactly one microphone session at a time: the permission prompt, the `MediaRecorder`, the
 * elapsed-time clock and the tracks behind them. Whatever the recording is for — transcription, in this
 * app — is the caller's business, so `stop()` answers with a `File` and no request is made here.
 *
 * Every way the session can end goes through one teardown: the stop button, a recorder error, and the
 * composer unmounting while the microphone is live. That is what keeps a denied prompt from leaving a
 * stream open — the case a browser shows as a recording indicator that never goes away.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MessageKey } from '../../lib/i18n'

/**
 * Offered in this order: Opus in WebM is what Chromium and Firefox produce, and it is the smallest
 * recording for a given minute. Safari records MP4 instead, which the worker's supported list accepts.
 */
const MEMO_RECORDING_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
] as const

const RECORDING_EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
}

const TIMER_INTERVAL_MS = 1000

export type MemoRecorderStatus = 'idle' | 'starting' | 'recording' | 'stopping'

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

function preferredRecordingMime(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null
  }
  return MEMO_RECORDING_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null
}

function recordingFileName(mime: string): string {
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? ''
  return `memo-voice-${Date.now()}.${RECORDING_EXTENSIONS[base] ?? 'webm'}`
}

/**
 * Why a permission prompt produced no microphone, in the sentence the composer shows.
 *
 * A refusal the browser names is answered by name — the reader can act on "denied" differently from
 * "no device" — and anything else falls back to the general failure rather than disappearing.
 */
function microphoneRefusal(error: unknown): MessageKey {
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name)
    : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'memos.composer.voice_denied'
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return 'memos.composer.voice_no_mic'
  }
  return 'memos.composer.voice_failed'
}

export function useMemoRecorder(): MemoRecorder {
  const [status, setStatus] = useState<MemoRecorderStatus>('idle')
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState<MessageKey | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<number | null>(null)
  const startedAtRef = useRef(0)
  const stopResolveRef = useRef<((file: File | null) => void) | null>(null)
  const stopPromiseRef = useRef<Promise<File | null> | null>(null)
  const mountedRef = useRef(true)

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return
    window.clearInterval(timerRef.current)
    timerRef.current = null
  }, [])

  const releaseTracks = useCallback((stream: MediaStream | null) => {
    stream?.getTracks().forEach((track) => track.stop())
  }, [])

  const teardown = useCallback((file: File | null, failure: MessageKey | null = null) => {
    clearTimer()
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder) {
      recorder.ondataavailable = null
      recorder.onstop = null
      recorder.onerror = null
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop()
        } catch (error) {
          // The recorder ending itself between the check and the call is the one throw here, and the
          // session is over either way; the tracks below are what would otherwise stay open.
          console.warn('[inkstone] A memo recording had already stopped on its own', error)
        }
      }
    }
    releaseTracks(streamRef.current)
    streamRef.current = null
    chunksRef.current = []
    const settle = stopResolveRef.current
    stopResolveRef.current = null
    stopPromiseRef.current = null
    settle?.(file)
    if (mountedRef.current) {
      setStatus('idle')
      setSeconds(0)
      if (failure) setError(failure)
    }
  }, [clearTimer, releaseTracks])

  const start = useCallback(async (): Promise<MessageKey | null> => {
    if (recorderRef.current) return null
    const mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
    if (typeof MediaRecorder === 'undefined' || !mediaDevices?.getUserMedia) {
      return 'memos.composer.voice_unsupported'
    }
    setError(null)
    setStatus('starting')
    let stream: MediaStream
    try {
      stream = await mediaDevices.getUserMedia({ audio: true })
    } catch (error) {
      if (mountedRef.current) setStatus('idle')
      return microphoneRefusal(error)
    }
    if (!mountedRef.current) {
      releaseTracks(stream)
      return null
    }
    let recorder: MediaRecorder
    const mime = preferredRecordingMime()
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
    } catch (error) {
      releaseTracks(stream)
      setStatus('idle')
      // The browser said it could record and then refused the constructor: nothing will capture, so
      // the press has to be reported rather than leaving a lit button and no session.
      console.warn('[inkstone] Could not open a memo recorder', error)
      return 'memos.composer.voice_failed'
    }
    streamRef.current = stream
    recorderRef.current = recorder
    chunksRef.current = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data)
    }
    recorder.onerror = () => teardown(null, 'memos.composer.voice_failed')
    recorder.onstop = () => {
      const type = recorder.mimeType || mime || 'audio/webm'
      const blob = new Blob(chunksRef.current, { type })
      teardown(blob.size > 0 ? new File([blob], recordingFileName(type), { type: blob.type }) : null)
    }
    startedAtRef.current = Date.now()
    setSeconds(0)
    timerRef.current = window.setInterval(() => {
      if (mountedRef.current) setSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000))
    }, TIMER_INTERVAL_MS)
    recorder.start()
    setStatus('recording')
    return null
  }, [releaseTracks, teardown])

  const stop = useCallback((): Promise<File | null> => {
    // A second press before the recorder has packaged the blob must wait for the same session, not
    // start a second one: `MediaRecorder.state` is already `inactive` by then, so a fresh call would
    // answer null and read as an empty recording.
    if (stopPromiseRef.current) return stopPromiseRef.current
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return Promise.resolve(null)
    const promise = new Promise<File | null>((resolve) => {
      stopResolveRef.current = resolve
    })
    stopPromiseRef.current = promise
    setStatus('stopping')
    try {
      recorder.stop()
    } catch (error) {
      console.warn('[inkstone] Could not stop a memo recording cleanly', error)
      teardown(null)
    }
    return promise
  }, [teardown])

  const clearError = useCallback(() => setError(null), [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      teardown(null)
    }
  }, [teardown])

  return { status, seconds, error, start, stop, clearError }
}

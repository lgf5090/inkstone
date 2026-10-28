/**
 * One microphone session, recorded to a `File`.
 *
 * The hook owns the permission prompt, the `MediaRecorder`, the elapsed-time clock and the tracks
 * behind them, and it owns exactly one session at a time. Whatever the recording is for —
 * transcription, an upload, a note — is the caller's business, so `stop()` answers with a `File` and
 * no request is made here.
 *
 * Every way the session can end goes through one teardown: the stop call, a recorder error, and the
 * component unmounting while the microphone is live. That is what keeps a denied prompt from leaving
 * a stream open — the case a browser shows as a recording indicator that never goes away.
 *
 * Callers supply the file-name prefix and, because the hook never renders text itself, the error
 * identifiers their own message catalog understands. Everything else stays the same between surfaces.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Offered in this order: Opus in WebM is what Chromium and Firefox produce, and it is the smallest
 * recording for a given minute. Safari records MP4 instead, which the worker's supported list accepts.
 */
const RECORDING_MIME_TYPES = [
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
const DEFAULT_FILE_PREFIX = 'memo-voice'

export type VoiceRecorderStatus = 'idle' | 'starting' | 'recording' | 'stopping'

/**
 * The identifiers a failed session answers with. They are plain strings so the hook stays
 * independent of any surface's message catalog; the caller turns them into text.
 */
export interface VoiceRecorderErrorKeys {
  unsupported: string
  denied: string
  noMic: string
  failed: string
}

export interface VoiceRecorderOptions {
  /** Stem of the recorded file's name; a `-<timestamp>.<extension>` suffix is appended. */
  filePrefix?: string
  /** Passed to `MediaRecorder`; the size lever a caller uses to stay under an upload limit. */
  audioBitsPerSecond?: number
  /** What a failed session answers with; defaults are identifiers, not display text. */
  errorKeys?: VoiceRecorderErrorKeys
}

export interface VoiceRecorder {
  status: VoiceRecorderStatus
  /** Whole seconds since this session began recording; zero while idle. */
  seconds: number
  /** Why a session ended without a recording, for the caller to report once; null when all is well. */
  error: string | null
  /** Asks for the microphone and begins recording. Null means it started; otherwise, what to tell. */
  start: () => Promise<string | null>
  /** Ends the session. Resolves with the recording, or null when nothing usable was captured. */
  stop: () => Promise<File | null>
  /** Marks the last `error` as reported, so the same failure can be raised again next time. */
  clearError: () => void
}

const DEFAULT_ERROR_KEYS: VoiceRecorderErrorKeys = {
  unsupported: 'voice.unsupported',
  denied: 'voice.denied',
  noMic: 'voice.no_mic',
  failed: 'voice.failed',
}

function preferredRecordingMime(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null
  }
  return RECORDING_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null
}

function recordingFileName(prefix: string, mime: string): string {
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? ''
  return `${prefix}-${Date.now()}.${RECORDING_EXTENSIONS[base] ?? 'webm'}`
}

/**
 * Why a permission prompt produced no microphone, as the identifier the caller gave for it.
 *
 * A refusal the browser names is answered by name — a reader can act on "denied" differently from
 * "no device" — and anything else falls back to the general failure rather than disappearing.
 */
function microphoneRefusal(error: unknown, keys: VoiceRecorderErrorKeys): string {
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name)
    : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return keys.denied
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return keys.noMic
  }
  return keys.failed
}

export function useVoiceRecorder(options: VoiceRecorderOptions = {}): VoiceRecorder {
  const {
    filePrefix = DEFAULT_FILE_PREFIX,
    audioBitsPerSecond,
    errorKeys = DEFAULT_ERROR_KEYS,
  } = options
  const [status, setStatus] = useState<VoiceRecorderStatus>('idle')
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)
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

  const teardown = useCallback((file: File | null, failure: string | null = null) => {
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
          console.warn('[inkstone] A voice recording had already stopped on its own', error)
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

  const start = useCallback(async (): Promise<string | null> => {
    if (recorderRef.current) return null
    const mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
    if (typeof MediaRecorder === 'undefined' || !mediaDevices?.getUserMedia) {
      return errorKeys.unsupported
    }
    setError(null)
    setStatus('starting')
    let stream: MediaStream
    try {
      stream = await mediaDevices.getUserMedia({ audio: true })
    } catch (error) {
      if (mountedRef.current) setStatus('idle')
      return microphoneRefusal(error, errorKeys)
    }
    if (!mountedRef.current) {
      releaseTracks(stream)
      return null
    }
    let recorder: MediaRecorder
    const mime = preferredRecordingMime()
    const recorderOptions: MediaRecorderOptions = {}
    if (mime) recorderOptions.mimeType = mime
    if (audioBitsPerSecond !== undefined) recorderOptions.audioBitsPerSecond = audioBitsPerSecond
    try {
      recorder = new MediaRecorder(stream, recorderOptions)
    } catch (error) {
      releaseTracks(stream)
      setStatus('idle')
      // The browser said it could record and then refused the constructor: nothing will capture, so
      // the press has to be reported rather than leaving a lit button and no session.
      console.warn('[inkstone] Could not open a voice recorder', error)
      return errorKeys.failed
    }
    streamRef.current = stream
    recorderRef.current = recorder
    chunksRef.current = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data)
    }
    recorder.onerror = () => teardown(null, errorKeys.failed)
    recorder.onstop = () => {
      const type = recorder.mimeType || mime || 'audio/webm'
      const blob = new Blob(chunksRef.current, { type })
      teardown(blob.size > 0 ? new File([blob], recordingFileName(filePrefix, type), { type: blob.type }) : null)
    }
    startedAtRef.current = Date.now()
    setSeconds(0)
    timerRef.current = window.setInterval(() => {
      if (mountedRef.current) setSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000))
    }, TIMER_INTERVAL_MS)
    recorder.start()
    setStatus('recording')
    return null
  }, [audioBitsPerSecond, errorKeys, filePrefix, releaseTracks, teardown])

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
      console.warn('[inkstone] Could not stop a voice recording cleanly', error)
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

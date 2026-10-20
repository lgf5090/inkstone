/**
 * The voice conversation, as a surface of its own.
 *
 * The composer's microphone types one sentence into the box; this panel holds a conversation. Two
 * engines sit behind it:
 *
 *  - **Realtime** speaks to a provider's full-duplex voice API over WebRTC. The Worker only mints a
 *    short-lived secret, so audio goes from the reader to the vendor and never through Inkstone. It has
 *    no notebook tools, and the screen says so.
 *  - **Assistant** is the ordinary turn: browser dictation, the full agent (notes, memory, tools), then
 *    browser speech. It is the more capable mode and works with the models a reader already has.
 *
 * The panel owns both engines for exactly as long as it is open. Closing it, pressing end, or unmounting
 * stops the microphone and the speaker; an open mic behind a closed panel is the one failure this file
 * cannot tolerate.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AudioLines, BookOpen, Loader2, Mic, PhoneOff, Settings2, Volume2, VolumeX } from 'lucide-react'
import type { MessageKey } from '../../lib/i18n'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { Button, IconButton } from '../../components/primitives'
import { Select, Segmented } from '../../components/form'
import { Modal } from '../../components/overlay'
import { api } from '../../lib/api'
import { useAssistant } from './assistant-store'
import { sendForAnswerDetailed } from './editor-ai'
import { saveReplyAsNote } from './save-to-note'
import { speak, stopSpeaking } from './speech'
import { speechRecognitionCtor, voiceBlocker, voiceBlockerReason } from './voice-engine'
import { VoiceTurnController } from './voice-turn'
import {
  RealtimeVoiceController,
  type RealtimeEvent,
  type RealtimeFailure,
  type RealtimeSession,
  type RealtimeStatus,
} from './voice-realtime'

type Engine = 'realtime' | 'turn'
type Phase = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error' | 'ended'
type RealtimeSupport = 'ready' | 'insecure' | 'unsupported'

interface Line {
  role: 'user' | 'assistant'
  text: string
  /** A realtime assistant line still being written into. */
  open?: boolean
}

const PHASE_KEYS: Record<Phase, MessageKey> = {
  idle: 'assistant.voice.ready',
  connecting: 'assistant.voice.connecting',
  listening: 'assistant.voice.listening',
  thinking: 'assistant.voice.thinking',
  speaking: 'assistant.voice.speaking',
  error: 'assistant.voice.failed',
  ended: 'assistant.voice.ended',
}

const REALTIME_STATUS: Record<RealtimeStatus, Phase> = {
  connecting: 'connecting',
  listening: 'listening',
  speaking: 'speaking',
  ended: 'ended',
  error: 'error',
}

const REALTIME_FAILURE_KEYS: Record<RealtimeFailure, MessageKey> = {
  playback: 'assistant.voice.audio_blocked',
  dropped: 'assistant.voice.connection_dropped',
  refused: 'assistant.voice.connection_refused',
  failed: 'assistant.voice.connect_failed',
}

/** Whether this browser can hold a WebRTC call, and which fact says it cannot. */
function realtimeSupport(): RealtimeSupport {
  if (typeof window === 'undefined'
    || typeof RTCPeerConnection === 'undefined'
    || typeof navigator === 'undefined'
    || !navigator.mediaDevices?.getUserMedia) return 'unsupported'
  if (window.isSecureContext === false) return 'insecure'
  return 'ready'
}

/** Why the browser refused the microphone, in words the reader can act on. */
function micFailure(error: unknown): string {
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name)
    : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return t('assistant.voice.mic_denied')
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return t('assistant.voice.mic_missing')
  if (name === 'NotReadableError' || name === 'AbortError') return t('assistant.voice.mic_busy')
  return t('assistant.voice.mic_failed')
}

export function VoiceMode({ onClose }: { onClose: () => void }) {
  const settings = useAssistant((state) => state.settings)
  const models = useAssistant((state) => state.models)
  const saveSettings = useAssistant((state) => state.saveSettings)
  const [engine, setEngine] = useState<Engine>('turn')
  const [phase, setPhase] = useState<Phase>('idle')
  const [lines, setLines] = useState<Line[]>([])
  const [error, setError] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  const mounted = useRef(true)
  const engineChosen = useRef(false)
  const turnRef = useRef<VoiceTurnController | null>(null)
  const realtimeRef = useRef<RealtimeVoiceController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const language = settings?.language ?? 'en-US'

  const realtimeModels = useMemo(
    () => models.filter((model) => model.enabled && model.purpose === 'realtime'),
    [models],
  )
  const realtimeModelId = settings?.realtimeModelId && realtimeModels.some((model) => model.id === settings.realtimeModelId)
    ? settings.realtimeModelId
    : realtimeModels[0]?.id ?? null
  const chatModel = models.find((model) => model.enabled && model.purpose === 'chat' && model.id === settings?.activeModelId)
  const turnReady = !!chatModel || settings?.offlineMode === true
  const blocker = voiceBlocker()
  const realtime = realtimeSupport()

  // The engine choice is a preference for this panel, not a setting. Realtime is offered first when
  // the reader has a model for it, until they say otherwise.
  useEffect(() => {
    if (!engineChosen.current) setEngine(realtimeModels.length ? 'realtime' : 'turn')
  }, [realtimeModels.length])

  useEffect(() => {
    // StrictMode's simulated unmount runs the cleanup below once before the real mount; the flag has
    // to come back up here or every callback after it is dropped and the panel never leaves Connecting.
    mounted.current = true
    return () => {
      mounted.current = false
      turnRef.current?.stop()
      realtimeRef.current?.stop()
      turnRef.current = null
      realtimeRef.current = null
    }
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  const addLine = (role: Line['role'], text: string): void => {
    if (!text.trim()) return
    setLines((current) => [...current.map((line) => (line.open ? { ...line, open: false } : line)), { role, text: text.trim() }])
  }

  const realtimeEvent = (event: RealtimeEvent): void => {
    if (event.kind === 'phase') {
      setPhase(event.phase)
      if (event.phase === 'listening') setLines((current) => current.map((line) => (line.open ? { ...line, open: false } : line)))
      return
    }
    if (event.kind === 'user') {
      addLine('user', event.text)
      return
    }
    if (event.kind === 'assistant-delta') {
      setLines((current) => {
        const last = current[current.length - 1]
        if (last?.role === 'assistant' && last.open) {
          return [...current.slice(0, -1), { ...last, text: last.text + event.delta }]
        }
        return [...current, { role: 'assistant', text: event.delta, open: true }]
      })
      return
    }
    if (event.kind === 'assistant-done') {
      setLines((current) => {
        const last = current[current.length - 1]
        if (last?.role === 'assistant' && last.open) return [...current.slice(0, -1), { role: 'assistant', text: event.text }]
        return [...current, { role: 'assistant', text: event.text }]
      })
      return
    }
    setError(event.message)
    setPhase('error')
  }

  const stop = (): void => {
    turnRef.current?.stop()
    realtimeRef.current?.stop()
    turnRef.current = null
    realtimeRef.current = null
    stopSpeaking()
  }

  const startTurn = (): void => {
    if (!settings) return
    stop()
    setError(null)
    setLines([])
    setMuted(false)
    setPhase('connecting')
    const controller = new VoiceTurnController({
      language,
      createRecognition: () => {
        const Recognition = speechRecognitionCtor()
        return Recognition ? new Recognition() : null
      },
      send: (text) => sendForAnswerDetailed(text),
      speak: (text, lang, handlers) => speak(text, lang, handlers),
      cancelSpeech: stopSpeaking,
      onPhase: (next) => {
        if (!mounted.current) return
        setPhase(next === 'idle' ? 'ended' : next)
      },
      onLine: addLine,
      onError: (message) => {
        if (!mounted.current) return
        turnRef.current?.stop()
        turnRef.current = null
        setError(message)
        setPhase('error')
      },
    })
    turnRef.current = controller
    controller.start()
  }

  const startRealtime = async (): Promise<void> => {
    if (!realtimeModelId) {
      setError(t('assistant.voice.no_realtime'))
      setPhase('error')
      return
    }
    stop()
    setError(null)
    setLines([])
    setMuted(false)
    setPhase('connecting')
    const controller = new RealtimeVoiceController({
      mint: async (): Promise<RealtimeSession> => {
        const { session } = await api.assistant.realtimeSession(realtimeModelId)
        return session
      },
      getMedia: async (constraints) => {
        try {
          return await navigator.mediaDevices.getUserMedia(constraints)
        } catch (failure) {
          throw new Error(micFailure(failure))
        }
      },
      createPeer: () => new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }),
      fetchSdp: (url, init) => fetch(url, init),
      createAudio: () => {
        const audio = document.createElement('audio')
        audio.autoplay = true
        audio.setAttribute('playsinline', '')
        return audio
      },
      onEvent: (event) => { if (mounted.current) realtimeEvent(event) },
      onStatus: (status) => { if (mounted.current) setPhase(REALTIME_STATUS[status]) },
      onError: (failure, detail) => {
        if (!mounted.current) return
        // A failed call must not leave the microphone running behind an error screen.
        realtimeRef.current?.stop()
        realtimeRef.current = null
        const base = failure === 'refused'
          ? t(REALTIME_FAILURE_KEYS[failure], { status: detail ?? '?' })
          : t(REALTIME_FAILURE_KEYS[failure])
        setError(failure === 'failed' && detail ? detail : base)
        setPhase('error')
      },
    })
    realtimeRef.current = controller
    await controller.start()
  }

  const start = (): void => {
    if (engine === 'realtime') void startRealtime()
    else startTurn()
  }

  const end = (): void => {
    stop()
    setPhase('ended')
  }

  const close = (): void => {
    stop()
    onClose()
  }

  const chooseEngine = (next: Engine): void => {
    engineChosen.current = true
    setEngine(next)
  }

  const fallbackToTurn = (): void => {
    engineChosen.current = true
    setEngine('turn')
    startTurn()
  }

  const toggleMute = (): void => {
    const next = !muted
    setMuted(next)
    realtimeRef.current?.setMuted(next)
  }

  const saveTranscript = (): void => {
    const body = lines
      .filter((line) => line.text.trim())
      .map((line) => `**${t(line.role === 'user' ? 'assistant.voice.you' : 'assistant.voice.assistant')}**: ${line.text.trim()}`)
      .join('\n\n')
    if (body) void saveReplyAsNote(body)
  }

  const active = phase !== 'idle' && phase !== 'ended' && phase !== 'error'
  const canStart = engine === 'realtime'
    ? realtime === 'ready' && !!realtimeModelId
    : blocker === 'none' && turnReady
  const startReason = engine === 'realtime'
    ? realtime === 'insecure'
      ? t('assistant.voice.insecure')
      : realtime === 'unsupported' ? t('assistant.voice.realtime_unsupported') : null
    : blocker !== 'none'
      ? t(voiceBlockerReason(blocker))
      : !turnReady ? t('assistant.voice.no_turn_model') : null

  return (
    <Modal
      open
      onClose={close}
      title={t('assistant.voice.title')}
      description={t('assistant.voice.hint')}
      width={620}
      footer={active
        ? <Button variant="danger" icon={<PhoneOff size={13} />} onClick={end}>{t('assistant.voice.end')}</Button>
        : <Button variant="ghost" onClick={close}>{t('common.close')}</Button>}
    >
      {!active && phase === 'idle' ? (
        <div className="flex flex-col gap-3">
          <Segmented
            value={engine}
            options={[
              { value: 'realtime', label: t('assistant.voice.engine_realtime') },
              { value: 'turn', label: t('assistant.voice.engine_turn') },
            ]}
            onChange={chooseEngine}
            label={t('assistant.voice.engine')}
          />
          <p className="text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">
            {t(engine === 'realtime' ? 'assistant.voice.realtime_desc' : 'assistant.voice.turn_desc')}
          </p>
          {engine === 'realtime' && realtimeModels.length > 0 && (
            <label className="flex flex-col gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('assistant.voice.realtime_model')}
              <Select
                value={realtimeModelId ?? ''}
                onChange={(event) => void saveSettings({ realtimeModelId: event.target.value || null })}
              >
                {realtimeModels.map((model) => (
                  <option key={model.id} value={model.id}>{model.label || model.model}</option>
                ))}
              </Select>
            </label>
          )}
          {engine === 'realtime' && !realtimeModels.length && (
            <div className="flex flex-col gap-2 rounded-[var(--r-md)] bg-[var(--bg-inset)] p-2.5">
              <p className="text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">{t('assistant.voice.no_realtime')}</p>
              <Button
                size="sm"
                variant="secondary"
                icon={<Settings2 size={12} />}
                onClick={() => {
                  close()
                  useAssistant.getState().setView('settings')
                }}
              >
                {t('assistant.voice.open_model_settings')}
              </Button>
            </div>
          )}
          {startReason && (
            <p role="status" className="text-[length:var(--text-11)] leading-relaxed text-[var(--warning)]">{startReason}</p>
          )}
          <div className="flex items-center gap-2">
            <Button variant="primary" icon={<Mic size={14} />} disabled={!canStart} onClick={start}>
              {t('assistant.voice.start')}
            </Button>
            <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              {t(engine === 'realtime' ? 'assistant.voice.realtime_privacy' : 'assistant.voice.turn_privacy')}
            </span>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-col gap-3">
          <div className="flex flex-col items-center gap-2 py-2">
            <div
              aria-hidden
              className={cn(
                'flex size-20 items-center justify-center rounded-full border border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]',
                phase === 'listening' || phase === 'speaking' ? 'animate-pulse motion-reduce:animate-none' : '',
              )}
            >
              {phase === 'connecting' || phase === 'thinking'
                ? <Loader2 size={26} className="animate-spin motion-reduce:animate-none" />
                : <AudioLines size={28} />}
            </div>
            <p aria-live="polite" className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {t(PHASE_KEYS[phase])}
            </p>
            <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              {t(engine === 'realtime' ? 'assistant.voice.engine_realtime' : 'assistant.voice.engine_turn')}
            </p>
          </div>
          <div
            ref={scrollRef}
            role="log"
            aria-label={t('assistant.voice.transcript')}
            className="max-h-[38vh] min-h-[120px] overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2"
          >
            {lines.length === 0
              ? <p className="py-8 text-center text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t(active ? 'assistant.voice.empty' : 'assistant.voice.no_lines')}</p>
              : (
                  <ul className="flex flex-col gap-2">
                    {lines.map((line, index) => (
                      <li key={`${line.role}-${index}`} className={cn('flex', line.role === 'user' ? 'justify-end' : 'justify-start')}>
                        <p className={cn(
                          'max-w-[85%] whitespace-pre-wrap break-words rounded-[var(--r-md)] px-2.5 py-1.5 text-[length:var(--text-12)] leading-relaxed',
                          line.role === 'user'
                            ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
                            : 'bg-[var(--bg-surface)] text-[var(--text-secondary)]',
                        )}>
                          {line.text}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
          </div>
          {error && (
            <div role="alert" className="flex flex-wrap items-center gap-2 rounded-[var(--r-md)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[length:var(--text-11)] text-[var(--danger)]">
              <span className="min-w-0 flex-1">{error}</span>
              <Button size="sm" variant="secondary" onClick={start} disabled={!canStart}>{t('assistant.voice.retry')}</Button>
              {engine === 'realtime' && turnReady && (
                <Button size="sm" variant="secondary" onClick={fallbackToTurn}>{t('assistant.voice.fallback')}</Button>
              )}
            </div>
          )}
          <div className="flex items-center gap-1">
            {engine === 'realtime' && active && (
              <IconButton
                label={t(muted ? 'assistant.voice.unmute' : 'assistant.voice.mute')}
                size="sm"
                onClick={toggleMute}
              >
                {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
              </IconButton>
            )}
            <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              {t(engine === 'realtime' ? 'assistant.voice.realtime_privacy' : 'assistant.voice.turn_privacy')}
            </span>
          </div>
        </div>
      )}
      {(phase === 'ended' || (phase === 'error' && lines.length > 0)) && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-2">
          {lines.length > 0 && (
            <Button size="sm" variant="ghost" icon={<BookOpen size={12} />} onClick={saveTranscript}>
              {t('assistant.voice.save_note')}
            </Button>
          )}
          {phase === 'ended' && (
            <Button size="sm" variant="secondary" onClick={start} disabled={!canStart}>{t('assistant.voice.again')}</Button>
          )}
        </div>
      )}
    </Modal>
  )
}

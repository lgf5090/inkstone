import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react'
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  FileText,
  ImageOff,
  Music,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
} from 'lucide-react'
import type { MemoAttachment } from '@shared/memos/types'
import { Modal } from '../../../components/overlay'
import { Button, IconButton } from '../../../components/primitives'
import { copyText } from '../../../lib/clipboard'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { formatBytes } from '../../../lib/time'
import { useUi } from '../../../store/ui'
import { memoAi, memoTranscriptionTarget, type MemoAiProvider } from '../ai-client'
import { memoErrorMessage, memoIsAbortError } from '../errors'
import { attachmentDimensions, formatMediaDuration } from '../media'
import { useMemoPreferences } from '../use-memo-preferences'

export interface AttachmentImageSource {
  src: string
  failed: boolean
  onError: () => void
}

export function useAttachmentImageSource(attachment: MemoAttachment): AttachmentImageSource {
  const initial = attachment.thumbnailUrl ?? attachment.url
  const [src, setSrc] = useState(initial)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setSrc(attachment.thumbnailUrl ?? attachment.url)
    setFailed(false)
  }, [attachment.id, attachment.thumbnailUrl, attachment.url])
  return {
    src,
    failed,
    onError: () => {
      if (src !== attachment.url) setSrc(attachment.url)
      else setFailed(true)
    },
  }
}

export function AttachmentUnavailable({ attachment, message, className }: {
  attachment: MemoAttachment
  message: ReactNode
  className?: string
}): ReactElement {
  const label = t('memos.attachments.download', { name: attachment.filename })
  return (
    <div
      role="status"
      className={cn(
        'flex min-h-10 min-w-0 flex-wrap items-center gap-2 rounded-[var(--r-sm)] border border-dashed border-[var(--border-subtle)]',
        'bg-[var(--bg-inset)] px-2 py-1.5 text-[length:var(--text-11-5)]',
        className,
      )}
    >
      <ImageOff size={14} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[var(--text-secondary)]" title={attachment.filename}>{attachment.filename}</p>
        <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{message}</p>
      </div>
      <a
        href={attachment.url}
        download={attachment.filename}
        aria-label={label}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] md:size-7"
      >
        <Download size={13} aria-hidden="true" />
      </a>
    </div>
  )
}

export function AttachmentMotionBadge(): ReactElement {
  return (
    <span className="pointer-events-none absolute bottom-1 left-1 inline-flex items-center gap-1 rounded-full bg-[var(--media-scrim)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--media-text-strong)]">
      <Play size={9} aria-hidden="true" />
      {t('memos.media.live_photo')}
    </span>
  )
}

export function AttachmentVideo({ attachment, className }: {
  attachment: MemoAttachment
  className?: string
}): ReactElement {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (failedSrc === attachment.url) {
    return (
      <AttachmentUnavailable
        attachment={attachment}
        message={t('memos.media.video_failed')}
        className={className}
      />
    )
  }
  const dimensions = attachmentDimensions(attachment)
  return (
    <video
      src={attachment.url}
      poster={attachment.thumbnailUrl ?? undefined}
      controls
      preload="metadata"
      playsInline
      aria-label={attachment.filename}
      width={dimensions.width}
      height={dimensions.height}
      onError={() => setFailedSrc(attachment.url)}
      className={cn(
        'w-full rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-inset)]',
        className,
      )}
    />
  )
}

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.5, 2] as const
type PlaybackRate = (typeof PLAYBACK_RATES)[number]
const SKIP_SECONDS = 10

function playbackRateLabel(rate: PlaybackRate): string {
  return `${rate}\u00d7`
}

function AttachmentTranscriber({ attachment, providers }: {
  attachment: MemoAttachment
  providers: MemoAiProvider[]
}): ReactElement {
  const preferences = useMemoPreferences().preferences
  const [transcribing, setTranscribing] = useState(false)
  const [transcript, setTranscript] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const target = memoTranscriptionTarget(providers, {
    providerId: preferences.transcriptionProviderId,
    model: preferences.transcriptionModel,
  })

  useEffect(() => () => {
    abortRef.current?.abort()
  }, [])

  const transcribe = async (): Promise<void> => {
    if (!target || transcribing) return
    const controller = new AbortController()
    abortRef.current?.abort()
    abortRef.current = controller
    setTranscribing(true)
    setCopied(false)
    setCopyFailed(false)
    try {
      const response = await fetch(attachment.url, { signal: controller.signal })
      if (!response.ok) throw new Error(`Audio download failed with HTTP ${response.status}`)
      const blob = await response.blob()
      const file = new File([blob], attachment.filename, {
        type: attachment.mime || blob.type || 'audio/mpeg',
      })
      const form = new FormData()
      form.set('file', file)
      form.set('providerId', target.providerId)
      form.set('model', target.model)
      if (preferences.transcriptionLanguage) form.set('language', preferences.transcriptionLanguage)
      if (preferences.transcriptionPrompt) form.set('prompt', preferences.transcriptionPrompt)
      const result = await memoAi.transcribe(form, controller.signal)
      if (controller.signal.aborted) return
      const text = result.text.trim()
      if (!text) {
        useUi.getState().toast({ title: t('memos.media.transcribe_empty'), tone: 'warning' })
        return
      }
      setTranscript(text)
    } catch (error) {
      if (controller.signal.aborted || memoIsAbortError(error)) return
      useUi.getState().toast({
        title: t('memos.media.transcribe_failed'),
        description: memoErrorMessage(error),
        tone: 'danger',
      })
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setTranscribing(false)
    }
  }

  const copyTranscript = async (): Promise<void> => {
    if (!transcript) return
    const ok = await copyText(transcript)
    setCopied(ok)
    setCopyFailed(!ok)
  }

  const closeTranscript = (): void => {
    setTranscript(null)
    setCopied(false)
    setCopyFailed(false)
  }

  const footer = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button
        size="sm"
        variant="secondary"
        icon={copied ? <Check size={13} /> : <Copy size={13} />}
        onClick={() => void copyTranscript()}
      >
        {copied ? t('common.copied') : t('common.copy')}
      </Button>
      <Button size="sm" onClick={closeTranscript}>{t('common.close')}</Button>
    </div>
  )

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        loading={transcribing}
        disabled={transcribing || target === null}
        onClick={() => void transcribe()}
      >
        {t('memos.media.transcribe')}
      </Button>
      <Modal
        open={transcript !== null}
        onClose={closeTranscript}
        title={t('memos.media.transcript_title')}
        description={attachment.filename}
        width={520}
        footer={footer}
      >
        <p className="whitespace-pre-wrap break-words text-[length:var(--text-13)] leading-relaxed text-[var(--text-primary)]">
          {transcript}
        </p>
        <p role="status" aria-live="polite" className="mt-2 text-[length:var(--text-11)] text-[var(--text-secondary)]">
          {copied ? t('common.copied') : ''}
        </p>
        {copyFailed ? (
          <p role="alert" className="mt-1 text-[length:var(--text-11)] text-[var(--danger)]">
            {t('memos.media.transcript_copy_failed')}
          </p>
        ) : null}
      </Modal>
    </>
  )
}

export function AttachmentAudio({ attachment, action, caption, className }: {
  attachment: MemoAttachment
  action?: ReactNode
  caption?: ReactNode
  className?: string
}): ReactElement {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState<PlaybackRate>(1)
  const [providers, setProviders] = useState<MemoAiProvider[]>([])
  const [providersReady, setProvidersReady] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)
  const noProviderHintId = useId()
  const failed = failedSrc === attachment.url
  const hasProvider = memoTranscriptionTarget(providers) !== null

  useEffect(() => {
    const controller = new AbortController()
    setProvidersReady(false)
    memoAi.providers(controller.signal)
      .then((listed) => {
        if (controller.signal.aborted) return
        setProviders(listed)
        setProvidersReady(true)
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || memoIsAbortError(error)) return
        setProviders([])
        setProvidersReady(true)
        console.warn('[inkstone] Memo transcription providers could not be listed', error)
      })
    return () => controller.abort()
  }, [])

  const syncDuration = (): void => {
    const audio = audioRef.current
    setDuration(audio && Number.isFinite(audio.duration) ? audio.duration : 0)
  }

  const togglePlayback = async (): Promise<void> => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
      setPlaying(false)
      return
    }
    try {
      const attempt = audio.play()
      if (attempt && typeof attempt.then === 'function') await attempt
      setPlaying(true)
    } catch (error) {
      console.warn('[inkstone] Audio playback could not start', error)
    }
  }

  const seekTo = (seconds: number): void => {
    const audio = audioRef.current
    if (!audio) return
    const limit = Number.isFinite(audio.duration) ? audio.duration : duration
    const next = Math.max(0, Math.min(seconds, limit > 0 ? limit : seconds))
    audio.currentTime = next
    setCurrentTime(next)
  }

  const skipBy = (delta: number): void => {
    const audio = audioRef.current
    if (!audio) return
    seekTo(audio.currentTime + delta)
  }

  const cycleRate = (): void => {
    const index = PLAYBACK_RATES.indexOf(rate)
    const next = PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length]!
    setRate(next)
    if (audioRef.current) audioRef.current.playbackRate = next
  }

  const currentLabel = formatMediaDuration(currentTime) || '0:00'
  const durationLabel = formatMediaDuration(duration) || '0:00'
  const downloadLabel = t('memos.attachments.download', { name: attachment.filename })
  const rateLabel = t('memos.media.audio_speed', { speed: playbackRateLabel(rate) })

  return (
    <div className={cn('min-w-0 rounded-[var(--r-sm)] border border-[var(--border-subtle)] p-2', className)}>
      <div className="flex min-h-10 items-center gap-2 text-[length:var(--text-11-5)] text-[var(--text-secondary)] md:min-h-0">
        <Music size={13} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
        <span className="min-w-0 flex-1 truncate" title={attachment.filename}>{attachment.filename}</span>
        <span className="shrink-0 text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">
          {formatBytes(attachment.size)}
        </span>
        {action}
      </div>
      {caption ? (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          {caption}
        </div>
      ) : null}
      {failed ? (
        <p role="alert" className="mt-1 flex flex-wrap items-center gap-1.5 text-[length:var(--text-11)] text-[var(--danger)]">
          <AlertTriangle size={12} aria-hidden="true" />
          <span className="min-w-0 flex-1">{t('memos.media.audio_failed')}</span>
          <a
            href={attachment.url}
            download={attachment.filename}
            aria-label={downloadLabel}
            className="inline-flex size-8 items-center justify-center rounded-[var(--r-md)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          >
            <Download size={12} aria-hidden="true" />
          </a>
        </p>
      ) : (
        <div className="mt-1.5 space-y-1">
          <audio
            ref={audioRef}
            preload="metadata"
            src={attachment.url}
            aria-hidden="true"
            onLoadedMetadata={syncDuration}
            onDurationChange={syncDuration}
            onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime ?? 0)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => {
              setPlaying(false)
              setCurrentTime(0)
            }}
            onError={() => {
              setFailedSrc(attachment.url)
              setPlaying(false)
            }}
            className="hidden"
          />
          <input
            type="range"
            min={0}
            max={duration > 0 ? duration : 0}
            step={0.1}
            value={duration > 0 ? Math.min(currentTime, duration) : 0}
            disabled={duration <= 0}
            aria-label={t('memos.media.audio_seek')}
            aria-valuetext={`${currentLabel} / ${durationLabel}`}
            onChange={(event) => seekTo(Number(event.target.value))}
            className="w-full accent-[var(--accent)]"
          />
          <div className="flex flex-wrap items-center gap-0.5">
            <IconButton
              label={playing ? t('memos.media.audio_pause') : t('memos.media.audio_play')}
              size="sm"
              onClick={() => void togglePlayback()}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </IconButton>
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw size={12} />}
              aria-label={t('memos.media.audio_back', { seconds: SKIP_SECONDS })}
              onClick={() => skipBy(-SKIP_SECONDS)}
              className="px-1.5"
            >
              {SKIP_SECONDS}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCw size={12} />}
              aria-label={t('memos.media.audio_forward', { seconds: SKIP_SECONDS })}
              onClick={() => skipBy(SKIP_SECONDS)}
              className="px-1.5"
            >
              {SKIP_SECONDS}
            </Button>
            <span className="px-1 text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">
              {currentLabel} / {durationLabel}
            </span>
            <Button
              size="sm"
              variant="ghost"
              aria-label={rateLabel}
              onClick={cycleRate}
              className="px-1.5 tabular"
            >
              {playbackRateLabel(rate)}
            </Button>
            <span className="ml-auto flex items-center gap-1">
              {providersReady && hasProvider ? (
                <AttachmentTranscriber attachment={attachment} providers={providers} />
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled
                  aria-describedby={providersReady && !hasProvider ? noProviderHintId : undefined}
                >
                  {t('memos.media.transcribe')}
                </Button>
              )}
              <a
                href={attachment.url}
                download={attachment.filename}
                aria-label={downloadLabel}
                className="inline-flex size-8 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              >
                <Download size={13} aria-hidden="true" />
              </a>
            </span>
            {providersReady && !hasProvider ? (
              <span id={noProviderHintId} className="sr-only">{t('memos.media.transcribe_no_provider')}</span>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}

export function AttachmentDocument({ attachment, action, caption, className }: {
  attachment: MemoAttachment
  action?: ReactNode
  caption?: ReactNode
  className?: string
}): ReactElement {
  const openLabel = t('memos.attachments.open', { name: attachment.filename })
  const downloadLabel = t('memos.attachments.download', { name: attachment.filename })
  return (
    <div
      className={cn(
        'flex min-h-10 min-w-0 items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border-subtle)]',
        'px-2 py-1.5 text-[length:var(--text-11-5)] md:min-h-0',
        className,
      )}
    >
      <FileText size={13} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
      <div className="min-w-0 flex-1">
        <a
          href={attachment.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={openLabel}
          title={attachment.filename}
          className="block truncate text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          {attachment.filename}
        </a>
        {caption ? (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
            {caption}
          </div>
        ) : null}
      </div>
      <span className="shrink-0 text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">
        {formatBytes(attachment.size)}
      </span>
      <a
        href={attachment.url}
        download={attachment.filename}
        aria-label={downloadLabel}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] md:size-7"
      >
        <Download size={12} aria-hidden="true" />
      </a>
      {action}
    </div>
  )
}

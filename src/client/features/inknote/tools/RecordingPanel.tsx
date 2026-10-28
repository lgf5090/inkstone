/** Audio recordings attached to one ink note. */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Mic, RotateCcw, Square, Trash2, X } from 'lucide-react'
import type { InknoteRecording } from '@shared/inknote/types'
import { useVoiceRecorder } from '../../../lib/use-voice-recorder'
import { t, type MessageKey } from '../../../lib/i18n'
import { IconButton } from '../../../components/primitives'
import { Tooltip } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { inknoteApi } from '../api'
import { useInknoteStore } from '../store'
import type { InknoteEngineApi } from '../engine/inknote-engine'
import { applyTimelineEvent, snapshotReplayPages, strokeEventsForCommit, trimTimeline, type InknoteTimelineEvent } from '../../../lib/inknote/timeline'
import { INKNOTE_LIMITS } from '@shared/inknote/constants'
import { computeAudioPeaks } from '../../../lib/inknote/audio-peaks'
import { Waveform } from './Waveform'
import { cn } from '../../../lib/cn'

export function RecordingPanel({ open, noteId, onClose, getEngine, onPage }: { open: boolean; noteId: string | null; onClose: () => void; getEngine: () => InknoteEngineApi | null; onPage: (pageId: string) => void }) {
  const [items, setItems] = useState<InknoteRecording[]>([])
  const [playing, setPlaying] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const recordingRef = useRef<{ start: number; events: InknoteTimelineEvent[] } | null>(null)
  const [replayId, setReplayId] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [speed, setSpeed] = useState(1)
  const replayTimers = useRef<number[]>([])
  const replaySnapshot = useRef<Map<string, ReturnType<typeof JSON.parse>> | null>(null)
  const toast = useUi((state) => state.toast)
  const recorder = useVoiceRecorder({
    filePrefix: 'inknote-recording',
    audioBitsPerSecond: 64_000,
    errorKeys: {
      unsupported: 'inknote.recording.unsupported',
      denied: 'inknote.recording.denied',
      noMic: 'inknote.recording.unsupported',
      failed: 'inknote.recording.unsupported',
    },
  })
  const load = () => { if (noteId) void inknoteApi.recordings(noteId).then((response) => setItems(response.recordings)).catch(() => setItems([])) }
  useEffect(load, [noteId, open])
  useEffect(() => {
    if (!recorder.error) return
    toast({ title: t(recorder.error as MessageKey), tone: 'danger' })
    recorder.clearError()
  }, [recorder, toast])
  useEffect(() => {
    const active = (event: Event) => {
      const timing = recordingRef.current
      if (!timing) return
      const detail = (event as CustomEvent<{ pageId: string; before: string; after: string; at: number }>).detail
      if (!detail?.pageId) return
      timing.events.push(...strokeEventsForCommit(detail.before, detail.after, detail.pageId, Math.max(0, detail.at - timing.start)))
    }
    const page = (event: Event) => {
      const timing = recordingRef.current
      if (!timing) return
      const detail = (event as CustomEvent<{ pageId: string; to: number; at: number }>).detail
      if (!detail?.pageId) return
      timing.events.push({ t: Math.max(0, detail.at - timing.start), type: 'page', pageId: detail.pageId, data: { to: detail.to } })
    }
    window.addEventListener('inknote:content', active)
    window.addEventListener('inknote:page', page)
    return () => {
      window.removeEventListener('inknote:content', active)
      window.removeEventListener('inknote:page', page)
    }
  }, [])

  const stopReplay = () => {
    for (const timer of replayTimers.current) window.clearTimeout(timer)
    replayTimers.current = []
    audioRef.current?.pause()
    audioRef.current = null
    getEngine()?.setPlaybackLock(false)
    const snapshot = replaySnapshot.current
    replaySnapshot.current = null
    if (snapshot) useInknoteStore.getState().endReplay(snapshot)
    setReplayId(null)
    setPlaying(null)
  }

  useEffect(() => {
    if (!open) stopReplay()
    return () => stopReplay()
  }, [open, noteId])

  const toggle = async () => {
    if (recorder.status === 'recording') {
      const file = await recorder.stop()
      const timeline = recordingRef.current ? trimTimeline(recordingRef.current.events, INKNOTE_LIMITS.timelineMaxBytes) : []
      recordingRef.current = null
      if (!file || !noteId) return
      try {
        const peaks = await computeAudioPeaks(file).catch((error) => { console.warn('[inkstone] Could not read the recording waveform:', error); return [] as number[] })
        const asset = await inknoteApi.uploadAsset(file, 'audio', noteId)
        await inknoteApi.createRecording({ noteId, title: `Recording ${items.length + 1}`, durationMs: recorder.seconds * 1000, audioAssetId: asset.id, timeline, peaks })
        load()
      } catch (error) {
        toast({ title: String(error), tone: 'danger' })
      }
      return
    }
    if (!noteId) { toast({ title: t('inknote.recording.no_note'), tone: 'danger' }); return }
    const failure = await recorder.start()
    if (failure) { toast({ title: t(failure as MessageKey), tone: 'danger' }); return }
    recordingRef.current = { start: Date.now(), events: [] }
  }
  const replay = async (item: InknoteRecording) => {
    if (replayId) { stopReplay(); return }
    try {
      const response = await inknoteApi.timeline(item.id)
      const events = [...response.events].sort((a, b) => a.t - b.t)
      if (events.length === 0) { toast({ title: t('inknote.recording.no_timeline') }); return }
      const store = useInknoteStore.getState()
      const snapshot = snapshotReplayPages(store.pages) as Map<string, ReturnType<typeof JSON.parse>>
      replaySnapshot.current = snapshot
      store.beginReplay()
      getEngine()?.setPlaybackLock(true)
      const first = events[0]!.pageId
      onPage(first)
      const audio = new Audio(item.audioUrl)
      audioRef.current = audio
      void audio.play().catch((error) => { console.warn('[inkstone] Recording playback refused to start:', error) })
      setPlaying(item.id)
      setReplayId(item.id)
      const apply = (event: InknoteTimelineEvent) => {
        if (event.type === 'page') { onPage(event.pageId); return }
        const page = useInknoteStore.getState().pages.find((entry) => entry.id === event.pageId)
        if (!page) return
        const next = applyTimelineEvent(page.content, event)
        if (next !== page.content) useInknoteStore.getState().applyReplayContent(event.pageId, next)
      }
      for (const event of events) replayTimers.current.push(window.setTimeout(() => apply(event), Math.max(0, event.t)))
      const last = events[events.length - 1]!.t
      replayTimers.current.push(window.setTimeout(() => stopReplay(), last + 600))
    } catch (error) {
      toast({ title: String(error), tone: 'danger' })
    }
  }

  const play = (item: InknoteRecording) => {
    if (playing === item.id) {
      audioRef.current?.pause()
      audioRef.current = null
      setPlaying(null)
      return
    }
    stopReplay()
    audioRef.current?.pause()
    const audio = new Audio(item.audioUrl)
    audio.playbackRate = speed
    audio.ontimeupdate = () => setProgress(audio.duration ? audio.currentTime / audio.duration : 0)
    audio.onended = () => { setPlaying(null); setProgress(0) }
    audio.onerror = () => { setPlaying(null); setProgress(0) }
    audioRef.current = audio
    setProgress(0)
    void audio.play().catch((error) => { console.warn('[inkstone] Recording playback refused to start:', error); setPlaying(null) })
    setPlaying(item.id)
  }

  const seek = (item: InknoteRecording, fraction: number) => {
    const audio = audioRef.current
    if (!audio || playing !== item.id) return
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : item.durationMs / 1000
    audio.currentTime = Math.max(0, Math.min(duration, fraction * duration))
    setProgress(fraction)
  }

  const changeSpeed = (next: number) => {
    setSpeed(next)
    if (audioRef.current) audioRef.current.playbackRate = next
  }
  const close = () => {
    if (recorder.status === 'recording') return
    stopReplay()
    onClose()
  }
  useEffect(() => {
    if (!open) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      close()
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  })
  if (!open) return null
  return createPortal(
    <aside role="dialog" aria-modal="false" aria-label={t('inknote.recording.title')} className="fixed bottom-0 right-0 top-0 z-[var(--z-panel)] flex w-[min(360px,100vw)] flex-col border-l border-[var(--border-default)] bg-[var(--bg-surface)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow-modal)]">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-3">
        <span className="text-[length:var(--text-13)] font-semibold">{t('inknote.recording.title')}</span>
        <Tooltip label={t('common.close')}><IconButton label={t('common.close')} size="sm" onClick={close} disabled={recorder.status === 'recording'}><X size={15}/></IconButton></Tooltip>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-2 p-3" data-replay={replayId ?? ''}>
        <div className="flex items-center gap-2">
          <IconButton label={recorder.status === 'recording' ? t('inknote.recording.stop') : t('inknote.recording.start')} size="lg" active={recorder.status === 'recording'} onClick={() => void toggle()}>
            {recorder.status === 'recording' ? <Square size={16}/> : <Mic size={16}/>}
          </IconButton>
          <span className="text-[length:var(--text-13)] tabular-nums">{Math.floor(recorder.seconds / 60)}:{String(recorder.seconds % 60).padStart(2, '0')}</span>
          <span className="ml-auto flex items-center gap-0.5" role="group" aria-label={t('inknote.recording.speed')}>
            {[1, 1.5, 2].map((value) => (
              <button key={value} type="button" aria-pressed={speed === value} onClick={() => changeSpeed(value)} className={cn('rounded-[var(--r-xs)] px-1 py-0.5 text-[length:var(--text-10-5)]', speed === value ? 'bg-[var(--bg-active)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]')}>{`${value}x`}</button>
            ))}
          </span>
        </div>
        {items.length === 0 && <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('inknote.recording.empty')}</p>}
        {items.map((item) => (
          <div key={item.id} className="space-y-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] p-2">
            <div className="flex items-center gap-2">
              <button type="button" className="min-w-0 flex-1 truncate text-left text-[length:var(--text-12)]" onClick={() => play(item)}>{playing === item.id ? '■ ' : '▶ '}{item.title}</button>
              <span className="text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{`${Math.floor(item.durationMs / 1000)}s`}</span>
              <IconButton label={t('inknote.recording.replay')} size="xs" active={replayId === item.id} onClick={() => void replay(item)}><RotateCcw size={11}/></IconButton>
              <IconButton label={t('inknote.recording.export')} size="xs" onClick={() => { const anchor = document.createElement('a'); anchor.href = item.audioUrl; anchor.download = `${item.title}.webm`; anchor.click() }}>⤓</IconButton>
              <IconButton label={t('inknote.delete')} size="xs" onClick={() => void inknoteApi.deleteRecording(item.id).then(load)}><Trash2 size={11}/></IconButton>
            </div>
            {item.peaks.length > 0 && <Waveform peaks={item.peaks} progress={playing === item.id ? progress : 0} label={t('inknote.recording.seek', { title: item.title })} onSeek={(fraction) => seek(item, fraction)}/>}
          </div>
        ))}
      </div>
      </div>
    </aside>,
    document.body,
  )
}

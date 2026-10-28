/** Audio recordings attached to one ink note. */
import { useEffect, useRef, useState } from 'react'
import { Mic, Square, Trash2 } from 'lucide-react'
import type { InknoteRecording } from '@shared/inknote/types'
import { useVoiceRecorder } from '../../../lib/use-voice-recorder'
import { t, type MessageKey } from '../../../lib/i18n'
import { IconButton } from '../../../components/primitives'
import { Drawer } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { inknoteApi } from '../api'

export function RecordingPanel({ open, noteId, onClose }: { open: boolean; noteId: string | null; onClose: () => void }) {
  const [items, setItems] = useState<InknoteRecording[]>([])
  const [playing, setPlaying] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
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
  const toggle = async () => {
    if (recorder.status === 'recording') {
      const file = await recorder.stop()
      if (!file || !noteId) return
      try {
        const asset = await inknoteApi.uploadAsset(file, 'audio', noteId)
        await inknoteApi.createRecording({ noteId, title: `Recording ${items.length + 1}`, durationMs: recorder.seconds * 1000, audioAssetId: asset.id, timeline: [], peaks: [] })
        load()
      } catch (error) {
        toast({ title: String(error), tone: 'danger' })
      }
      return
    }
    const failure = await recorder.start()
    if (failure) toast({ title: t(failure as MessageKey), tone: 'danger' })
  }
  const play = (item: InknoteRecording) => {
    audioRef.current?.pause()
    const audio = new Audio(item.audioUrl)
    audio.onended = () => setPlaying(null)
    audioRef.current = audio
    void audio.play().catch(() => setPlaying(null))
    setPlaying(item.id)
  }
  return (
    <Drawer open={open} onClose={onClose} title={t('inknote.recording.title')} width={360}>
      <div className="space-y-2 p-3">
        <div className="flex items-center gap-2">
          <IconButton label={recorder.status === 'recording' ? t('inknote.recording.stop') : t('inknote.recording.start')} size="lg" active={recorder.status === 'recording'} onClick={() => void toggle()}>
            {recorder.status === 'recording' ? <Square size={16}/> : <Mic size={16}/>}
          </IconButton>
          <span className="text-[length:var(--text-13)] tabular-nums">{Math.floor(recorder.seconds / 60)}:{String(recorder.seconds % 60).padStart(2, '0')}</span>
        </div>
        {items.length === 0 && <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('inknote.recording.empty')}</p>}
        {items.map((item) => (
          <div key={item.id} className="flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border-subtle)] p-2">
            <button type="button" className="min-w-0 flex-1 truncate text-left text-[length:var(--text-12)]" onClick={() => play(item)}>{playing === item.id ? '■ ' : '▶ '}{item.title}</button>
            <span className="text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{`${Math.floor(item.durationMs / 1000)}s`}</span>
            <IconButton label={t('inknote.recording.export')} size="xs" onClick={() => { const anchor = document.createElement('a'); anchor.href = item.audioUrl; anchor.download = `${item.title}.webm`; anchor.click() }}>⤓</IconButton>
            <IconButton label={t('inknote.delete')} size="xs" onClick={() => void inknoteApi.deleteRecording(item.id).then(load)}><Trash2 size={11}/></IconButton>
          </div>
        ))}
      </div>
    </Drawer>
  )
}

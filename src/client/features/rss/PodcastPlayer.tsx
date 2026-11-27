import { useEffect, useRef, useState } from 'react'
import { AudioLines, Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import type { RssEntry } from '@shared/rss/model'
import { Button, IconButton } from '../../components/primitives'
import { Slider } from '../../components/form'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { playableAudio } from './media'

const SPEEDS = [1, 1.25, 1.5, 2]
const SAVE_EVERY_MS = 5000

interface SavedProgress {
  time: number
  duration?: number
  speed?: number
}

function progressKey(id: string): string {
  return `rss-audio-progress:${id}`
}

function readProgress(id: string): SavedProgress | null {
  try {
    const value = JSON.parse(localStorage.getItem(progressKey(id)) ?? 'null') as SavedProgress | null
    return value && Number.isFinite(value.time) ? value : null
  }
  catch {
    // A stale or hand-edited media cache must not stop playback.
    return null
  }
}

function writeProgress(id: string, value: SavedProgress): void {
  try {
    localStorage.setItem(progressKey(id), JSON.stringify(value))
  }
  catch (error) {
    console.warn('[inkstone] RSS playback progress could not be saved', error)
  }
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function PodcastPlayer({ entry, queue, onSelect }: {
  entry: RssEntry
  queue: RssEntry[]
  onSelect: (entryId: string) => void
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const lastSaved = useRef(0)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(entry.duration ?? 0)
  const [speed, setSpeed] = useState(1)
  const index = queue.findIndex(item => item.id === entry.id)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const saved = readProgress(entry.id)
    setTime(saved?.time ?? 0)
    setDuration(saved?.duration ?? entry.duration ?? 0)
    setSpeed(saved?.speed && SPEEDS.includes(saved.speed) ? saved.speed : 1)
    lastSaved.current = 0
    audio.load()
  }, [entry.id, entry.duration])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.playbackRate = speed
  }, [speed])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !playing) return
    void audio.play().catch((error: unknown) => {
      console.warn('[inkstone] RSS audio playback was refused', error)
      setPlaying(false)
    })
  }, [playing, entry.id])

  useEffect(() => () => {
    const audio = audioRef.current
    if (audio) writeProgress(entry.id, { time: audio.currentTime, duration: audio.duration || duration, speed })
  }, [entry.id, duration, speed])

  const toggle = (): void => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) setPlaying(true)
    else {
      audio.pause()
      setPlaying(false)
    }
  }

  const move = (delta: number): void => {
    const next = queue[index + delta]
    if (next) onSelect(next.id)
  }

  const cycleSpeed = (): void => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1
    setSpeed(next)
    if (audioRef.current) audioRef.current.playbackRate = next
  }

  return (
    <figure className="mb-5 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
      <audio
        ref={audioRef}
        src={api.rss.relayUrl(playableAudio(entry.audioUrl))}
        preload="metadata"
        className="sr-only"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={() => {
          const audio = audioRef.current
          if (!audio) return
          const saved = readProgress(entry.id)
          const length = Number.isFinite(audio.duration) ? audio.duration : entry.duration ?? 0
          setDuration(length)
          if (saved && saved.time < length) audio.currentTime = saved.time
          audio.playbackRate = speed
        }}
        onTimeUpdate={() => {
          const audio = audioRef.current
          if (!audio) return
          setTime(audio.currentTime)
          if (Date.now() - lastSaved.current >= SAVE_EVERY_MS) {
            lastSaved.current = Date.now()
            writeProgress(entry.id, { time: audio.currentTime, duration: audio.duration || duration, speed })
          }
        }}
        onEnded={() => move(1)}
      >
        {t('rss.audio_failed')}
      </audio>
      <div className="flex items-center gap-2">
        <IconButton label={playing ? t('rss.audio_pause') : t('rss.audio_play')} size="sm" onClick={toggle}>
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </IconButton>
        <IconButton label={t('rss.audio_previous')} size="sm" disabled={index <= 0} onClick={() => move(-1)}>
          <SkipBack size={15} />
        </IconButton>
        <IconButton label={t('rss.audio_next')} size="sm" disabled={index < 0 || index >= queue.length - 1} onClick={() => move(1)}>
          <SkipForward size={15} />
        </IconButton>
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          {index >= 0 ? t('rss.audio_queue', { index: index + 1, total: queue.length }) : t('rss.audio')}
        </span>
        <Button size="sm" variant="ghost" onClick={cycleSpeed} aria-label={t('rss.audio_speed')}>{speed}×</Button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className="w-10 text-right text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]">{clock(time)}</span>
        <Slider
          className="min-w-0 flex-1"
          value={time}
          min={0}
          max={Math.max(1, duration)}
          step={1}
          showValue={false}
          valueText={`${clock(time)} / ${clock(duration)}`}
          label={t('rss.audio_progress')}
          onChange={value => {
            if (audioRef.current) audioRef.current.currentTime = value
            setTime(value)
          }}
        />
        <span className="w-10 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]">{clock(duration)}</span>
      </div>
      <figcaption className="mt-1 flex items-center gap-1 text-[0.7em] text-[var(--text-quaternary)]">
        <AudioLines size={12} aria-hidden="true" />
        {entry.duration ? `${t('rss.audio')} · ${clock(entry.duration)}` : t('rss.audio')}
      </figcaption>
    </figure>
  )
}

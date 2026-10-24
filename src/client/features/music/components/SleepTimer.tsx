/**
 * The sleep timer: a deadline or the end of the queue, then a short fade and a pause.
 *
 * The timer lives outside React so closing the panel does not cancel it. It persists for the session
 * only; a deadline surviving a reload would be a surprise the reader cannot see, and the panel is the
 * only place that explains one.
 *
 * The fade is deliberately short and ends with the player's own pause. It runs through the store so
 * the volume the fade writes is the volume the next launch restores, and the original level is put
 * back before the pause so waking the app does not start silent.
 */
import { useEffect, useId, useState, useSyncExternalStore, type FormEvent, type ReactElement } from 'react'
import { ListEnd, Timer } from 'lucide-react'
import { formatDuration } from '@shared/music/format'
import { Button } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { cn } from '../../../lib/cn'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'
import { musicText } from './labels'

export const MUSIC_SLEEP_PRESETS_MINUTES = [15, 30, 60, 90] as const
export const MUSIC_SLEEP_MIN_MINUTES = 1
export const MUSIC_SLEEP_MAX_MINUTES = 720

const FADE_STEPS = 8
const FADE_STEP_MS = 150
const END_OF_QUEUE_POLL_MS = 1_000

export interface MusicSleepTimerState {
  /** Epoch milliseconds, or null when no deadline is set. */
  endsAt: number | null
  untilQueueEnd: boolean
}

export function sleepTimerRemainingMs(state: MusicSleepTimerState, now: number): number | null {
  if (state.endsAt === null) return null
  return Math.max(0, state.endsAt - now)
}

class MusicSleepTimer {
  private state: MusicSleepTimerState = { endsAt: null, untilQueueEnd: false }
  private listeners = new Set<() => void>()
  private deadlineTimer: number | null = null
  private queuePoll: number | null = null
  private fadeTimer: number | null = null
  private fadeRestore: { volume: number; muted: boolean } | null = null

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): MusicSleepTimerState => this.state

  /** Start a countdown of `minutes`. Values outside the offered range are ignored. */
  start(minutes: number): void {
    if (typeof window === 'undefined') return
    if (!Number.isFinite(minutes) || minutes < MUSIC_SLEEP_MIN_MINUTES || minutes > MUSIC_SLEEP_MAX_MINUTES) return
    this.clearTimers(true)
    const endsAt = Date.now() + Math.round(minutes * 60_000)
    this.publish({ endsAt, untilQueueEnd: false })
    this.deadlineTimer = window.setTimeout(() => this.finish(), Math.max(0, endsAt - Date.now()))
  }

  /** Pause when the current queue reaches its natural end. */
  startUntilQueueEnd(): void {
    if (typeof window === 'undefined') return
    if (!selectCurrentTrack(useMusicPlayer.getState())) return
    this.clearTimers(true)
    this.publish({ endsAt: null, untilQueueEnd: true })
    this.queuePoll = window.setInterval(() => {
      const player = useMusicPlayer.getState()
      if (!selectCurrentTrack(player) || player.status === 'ended' || player.status === 'idle') this.finish()
    }, END_OF_QUEUE_POLL_MS)
  }

  cancel(): void {
    this.clearTimers(true)
    this.publish({ endsAt: null, untilQueueEnd: false })
  }

  private publish(next: MusicSleepTimerState): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }

  private clearTimers(restoreVolume: boolean): void {
    if (typeof window !== 'undefined') {
      if (this.deadlineTimer !== null) window.clearTimeout(this.deadlineTimer)
      if (this.queuePoll !== null) window.clearInterval(this.queuePoll)
      if (this.fadeTimer !== null) window.clearTimeout(this.fadeTimer)
    }
    this.deadlineTimer = null
    this.queuePoll = null
    this.fadeTimer = null
    if (restoreVolume && this.fadeRestore) {
      useMusicPlayer.getState().setVolume(this.fadeRestore.volume)
      useMusicPlayer.getState().setMuted(this.fadeRestore.muted)
      this.fadeRestore = null
    }
  }

  private finish(): void {
    if (typeof window === 'undefined') return
    const player = useMusicPlayer.getState()
    const status = player.status
    this.clearTimers(false)
    this.publish({ endsAt: null, untilQueueEnd: false })
    if (status !== 'playing' && status !== 'loading') return

    const restore = { volume: player.volume, muted: player.muted }
    this.fadeRestore = restore
    let step = 0
    const fade = (): void => {
      step += 1
      useMusicPlayer.getState().setVolume(restore.volume * (1 - step / FADE_STEPS))
      if (step < FADE_STEPS) {
        this.fadeTimer = window.setTimeout(fade, FADE_STEP_MS)
        return
      }
      this.fadeTimer = null
      useMusicPlayer.getState().pause()
      useMusicPlayer.getState().setVolume(restore.volume)
      if (restore.muted) useMusicPlayer.getState().setMuted(true)
      this.fadeRestore = null
    }
    fade()
  }
}

export const musicSleepTimer = new MusicSleepTimer()

function useSleepTimerState(): MusicSleepTimerState {
  return useSyncExternalStore(
    musicSleepTimer.subscribe,
    musicSleepTimer.getSnapshot,
    musicSleepTimer.getSnapshot,
  )
}

export interface SleepTimerProps {
  className?: string
}

export function SleepTimer({ className }: SleepTimerProps): ReactElement {
  const state = useSleepTimerState()
  const current = useMusicPlayer(selectCurrentTrack)
  const customId = useId()
  const hintId = useId()
  const [minutes, setMinutes] = useState('45')
  const [error, setError] = useState<'invalid' | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (state.endsAt === null) return
    setNow(Date.now())
    const tick = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(tick)
  }, [state.endsAt])

  const remaining = sleepTimerRemainingMs(state, now)

  const startCustom = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const value = Number(minutes)
    if (!Number.isFinite(value) || value < MUSIC_SLEEP_MIN_MINUTES || value > MUSIC_SLEEP_MAX_MINUTES) {
      setError('invalid')
      return
    }
    setError(null)
    musicSleepTimer.start(value)
  }

  return (
    <section aria-label={musicText('music.sleep.title')} className={cn('flex flex-col gap-3', className)}>
      <header className="flex items-start gap-2">
        <Timer size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" />
        <div className="min-w-0">
          <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {musicText('music.sleep.title')}
          </h3>
          <p className="mt-0.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
            {musicText('music.sleep.description')}
          </p>
        </div>
      </header>

      {remaining !== null && (
        <div role="timer" className="flex items-center justify-between gap-3 rounded-[var(--r-md)] bg-[var(--bg-inset)] px-3 py-2">
          <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {musicText('music.sleep.remaining')} <span className="tabular-nums text-[var(--text-primary)]">{formatDuration(remaining)}</span>
          </span>
          <Button size="sm" variant="ghost" onClick={() => musicSleepTimer.cancel()}>
            {musicText('music.sleep.cancel')}
          </Button>
        </div>
      )}

      {state.untilQueueEnd && (
        <div role="status" className="flex items-center justify-between gap-3 rounded-[var(--r-md)] bg-[var(--bg-inset)] px-3 py-2">
          <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {musicText('music.sleep.end_of_list_active')}
          </span>
          <Button size="sm" variant="ghost" onClick={() => musicSleepTimer.cancel()}>
            {musicText('music.sleep.cancel')}
          </Button>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {MUSIC_SLEEP_PRESETS_MINUTES.map((value) => (
          <Button key={value} size="sm" variant="secondary" onClick={() => musicSleepTimer.start(value)}>
            {musicText('music.sleep.minutes', { minutes: value })}
          </Button>
        ))}
      </div>

      <form onSubmit={startCustom} className="flex flex-col gap-1.5">
        <label htmlFor={customId} className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {musicText('music.sleep.custom_minutes')}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id={customId}
            type="number"
            inputMode="numeric"
            min={MUSIC_SLEEP_MIN_MINUTES}
            max={MUSIC_SLEEP_MAX_MINUTES}
            step={1}
            value={minutes}
            aria-describedby={hintId}
            invalid={error !== null}
            onChange={(event) => {
              setMinutes(event.target.value)
              setError(null)
            }}
            className="w-24"
          />
          <Button type="submit" size="sm" variant="secondary">
            {musicText('music.sleep.start')}
          </Button>
        </div>
        <p id={hintId} className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
          {musicText('music.sleep.custom_hint', {
            min: MUSIC_SLEEP_MIN_MINUTES,
            max: MUSIC_SLEEP_MAX_MINUTES,
          })}
        </p>
        {error === 'invalid' && (
          <p role="alert" className="text-[length:var(--text-11)] text-[var(--danger)]">
            {musicText('music.sleep.invalid')}
          </p>
        )}
      </form>

      <Button
        size="sm"
        variant={state.untilQueueEnd ? 'primary' : 'secondary'}
        icon={<ListEnd size={14} />}
        disabled={!current}
        onClick={() => musicSleepTimer.startUntilQueueEnd()}
      >
        {musicText('music.sleep.end_of_list')}
      </Button>
    </section>
  )
}

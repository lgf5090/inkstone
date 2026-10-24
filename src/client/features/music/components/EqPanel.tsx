/**
 * The ten-band equalizer panel.
 *
 * The sliders write the same `EqSettings` the engine reads, so a change is audible on the next frame
 * rather than on a save. Availability is reported, never assumed: a browser without an `AudioContext`
 * or a cross-origin stream keeps playing, and the panel says the curve is not being applied instead
 * of showing a switch that does nothing.
 */
import { useId, type ReactElement } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '../../../components/primitives'
import { Select, SettingRow, Switch } from '../../../components/form'
import { cn } from '../../../lib/cn'
import {
  EQ_FREQUENCIES,
  EQ_GAIN_RANGE,
  EQ_PRESET_NAMES,
  eqPresetGains,
  musicEqualizer,
  type EqPresetName,
  type EqUnavailableReason,
} from '../player/eq'
import { useMusicPlayer } from '../store/player'
import { useMusicSettings } from '../store/settings'
import { musicText } from './labels'

const UNAVAILABLE_KEYS: Record<EqUnavailableReason, string> = {
  unsupported: 'music.eq.unavailable.unsupported',
  'cross-origin': 'music.eq.unavailable.cross_origin',
  failed: 'music.eq.unavailable.failed',
}

function formatFrequency(hertz: number): string {
  return hertz >= 1000 ? `${hertz / 1000}k` : String(hertz)
}

function spokenFrequency(hertz: number): string {
  return hertz >= 1000 ? `${hertz / 1000} kHz` : `${hertz} Hz`
}

export interface EqPanelProps {
  className?: string
}

export function EqPanel({ className }: EqPanelProps): ReactElement {
  const equalizer = useMusicSettings((state) => state.local.eq)
  const setEq = useMusicSettings((state) => state.setEq)
  const status = useMusicPlayer((state) => state.status)
  const presetId = useId()
  const noteId = useId()

  // Reading the singleton during render is enough: every transport state change re-renders the
  // panel, and the graph is attached before the first `loading` state settles.
  const available = musicEqualizer.available
  const reason = musicEqualizer.unavailableReason
  const running = status === 'playing' || status === 'loading'

  const note = reason
    ? UNAVAILABLE_KEYS[reason]
    : !available && !running
      ? 'music.eq.waiting'
      : available
        ? 'music.eq.active'
        : null

  const changeBand = (index: number, gain: number): void => {
    const gains = equalizer.gains.map((value, band) => (band === index ? gain : value))
    setEq({ preset: 'custom', gains })
  }

  return (
    <section
      aria-label={musicText('music.eq.title')}
      aria-describedby={note ? noteId : undefined}
      className={cn('flex flex-col gap-3', className)}
    >
      <header className="flex items-center justify-between gap-3">
        <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {musicText('music.eq.title')}
        </h3>
        <span className="flex items-center gap-2 text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
          {musicText('music.eq.enabled')}
          <Switch
            checked={equalizer.enabled}
            label={musicText('music.eq.enabled')}
            onChange={(enabled) => setEq({ enabled })}
          />
        </span>
      </header>

      {note && (
        <p id={noteId} role="note" className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
          {musicText(note)}
        </p>
      )}

      <SettingRow title={musicText('music.eq.leveling')} description={musicText('music.eq.leveling_hint')}>
        <Switch
          checked={equalizer.leveling}
          label={musicText('music.eq.leveling')}
          onChange={(leveling) => setEq({ leveling })}
        />
      </SettingRow>

      <SettingRow title={musicText('music.eq.preset')} controlId={presetId}>
        <Select
          id={presetId}
          value={equalizer.preset}
          onChange={(event) => setEq({ preset: event.target.value as EqPresetName })}
        >
          {EQ_PRESET_NAMES.map((preset) => (
            <option key={preset} value={preset}>
              {musicText(`music.eq.preset.${preset}`)}
            </option>
          ))}
        </Select>
      </SettingRow>

      <div
        role="group"
        aria-label={musicText('music.eq.bands')}
        className="flex items-end justify-between gap-1 overflow-x-auto pb-1"
      >
        {EQ_FREQUENCIES.map((frequency, index) => {
          const gain = equalizer.gains[index] ?? 0
          const label = musicText('music.eq.band', { hz: spokenFrequency(frequency) })
          return (
            <div key={frequency} className="flex min-w-[26px] flex-1 flex-col items-center gap-1">
              <span className="text-[length:var(--text-10)] tabular-nums text-[var(--text-quaternary)]">
                {gain > 0 ? `+${gain}` : gain}
              </span>
              <input
                type="range"
                min={EQ_GAIN_RANGE.min}
                max={EQ_GAIN_RANGE.max}
                step={0.5}
                value={gain}
                aria-label={label}
                aria-valuetext={`${gain} dB`}
                onChange={(event) => changeBand(index, Number(event.target.value))}
                className={cn(
                  'h-28 w-6 cursor-pointer accent-[var(--accent)]',
                  '[direction:rtl] [writing-mode:vertical-lr]',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]',
                )}
              />
              <span aria-hidden="true" className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                {formatFrequency(frequency)}
              </span>
            </div>
          )
        })}
      </div>

      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          icon={<RotateCcw size={13} />}
          onClick={() => setEq({ enabled: false, leveling: false, preset: 'flat', gains: eqPresetGains('flat') })}
        >
          {musicText('music.eq.reset')}
        </Button>
      </div>
    </section>
  )
}

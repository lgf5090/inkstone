/**
 * The three FM tastes, as a segmented control.
 *
 * The group is a set of real buttons rather than a styled row of divs: each option is in the tab
 * order, Space and Enter work, and `aria-pressed` tells a screen reader which station is chosen.
 */
import type { ReactElement } from 'react'
import type { MusicFmMode } from '@shared/music/model'
import { cn } from '../../../lib/cn'
import { musicText } from '../components/labels'
import './radio.css'

export const RADIO_MODE_LABEL_KEYS: Record<MusicFmMode, string> = {
  DEFAULT: 'music.radio.mode.default',
  FAMILIAR: 'music.radio.mode.familiar',
  EXPLORE: 'music.radio.mode.explore',
}

const FM_MODES: readonly MusicFmMode[] = ['DEFAULT', 'FAMILIAR', 'EXPLORE']

export interface RadioModeMenuProps {
  value: MusicFmMode
  onChange: (mode: MusicFmMode) => void
  disabled?: boolean
  className?: string
}

export function RadioModeMenu({
  value,
  onChange,
  disabled = false,
  className,
}: RadioModeMenuProps): ReactElement {
  return (
    <div
      className={cn('music-radio-modes', className)}
      role="group"
      aria-label={musicText('music.radio.mode.label')}
    >
      {FM_MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          className="music-radio-modes__option"
          aria-pressed={mode === value}
          disabled={disabled}
          onClick={() => onChange(mode)}
        >
          {musicText(RADIO_MODE_LABEL_KEYS[mode])}
        </button>
      ))}
    </div>
  )
}

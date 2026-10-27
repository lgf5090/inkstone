/**
 * The station label above the Now Playing title: what is growing this queue, a dislike for FM, and
 * the way out.
 *
 * Exiting drops the station but not the track: the reader keeps listening to the song that is already
 * playing, and the queue simply stops growing at its end. Dislike is only offered for FM because the
 * provider's trash endpoint is the FM signal, not a heart-mode control.
 */
import type { ReactElement } from 'react'
import { Radio, ThumbsDown, X } from 'lucide-react'
import { IconButton } from '../../../components/primitives'
import { musicText } from '../components/labels'
import { useMusicPlayer } from '../store/player'
import { RADIO_MODE_LABEL_KEYS } from './RadioModeMenu'
import './radio.css'

export function RadioChip(): ReactElement | null {
  const radio = useMusicPlayer((state) => state.radio)
  const radioLoading = useMusicPlayer((state) => state.radioLoading)
  const detachRadio = useMusicPlayer((state) => state.detachRadio)
  const fmTrash = useMusicPlayer((state) => state.fmTrash)

  if (!radio) return null
  const label = radio.mode === 'heart'
    ? musicText('music.mode.intelligence')
    : `${radio.name} · ${musicText(RADIO_MODE_LABEL_KEYS[radio.mode])}`

  return (
    <div className="music-radio-chip">
      <Radio size={13} className="music-radio-chip__icon" aria-hidden="true" />
      <span className="music-radio-chip__name">{label}</span>
      {radio.mode !== 'heart' && (
        <IconButton
          label={musicText('music.radio.dislike')}
          size="xs"
          disabled={radioLoading}
          onClick={() => {
            void fmTrash()
          }}
        >
          <ThumbsDown size={13} aria-hidden="true" />
        </IconButton>
      )}
      <IconButton
        label={musicText('music.radio.exit')}
        size="xs"
        onClick={detachRadio}
      >
        <X size={13} aria-hidden="true" />
      </IconButton>
    </div>
  )
}

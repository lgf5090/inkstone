/**
 * The badge that names the level the stream actually served.
 *
 * The requested quality is not the answer: NetEase may fall back to a lower level, so the player reads
 * the level from the stream's HEAD answer rather than from the setting. Only lossless levels are
 * worth a badge; a compressed fallback is already visible in the disabled options of the picker.
 */
import type { ReactElement } from 'react'
import { musicQualityLabelKey } from '@shared/music/format'
import type { MusicQuality } from '@shared/music/model'
import { musicText } from '../components/labels'
import { useMusicPlayer } from '../store/player'

const BADGED = new Set(['lossless', 'hires', 'jyeffect', 'sky', 'jymaster'])

export function NowPlayingQualityBadge(): ReactElement | null {
  const quality = useMusicPlayer((state) => state.streamQuality)
  if (!quality || !BADGED.has(quality)) return null
  const key = musicQualityLabelKey(quality as MusicQuality)
  return (
    <span className="music-np__quality" title={musicText(key)}>
      {musicText(key)}
    </span>
  )
}

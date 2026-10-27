/**
 * The About pane of a podcast episode: what it is and where its podcast lives.
 *
 * An episode is not a song, so Now Playing replaces lyrics and the stage with this description and
 * the comments thread. The description is the provider's own text, rendered as text.
 */
import type { ReactElement } from 'react'
import { Radio } from 'lucide-react'
import { musicArtistNames } from '@shared/music/format'
import { navigateToAddress } from '../../../lib/app-history'
import { musicText } from '../components/labels'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'

export function ProgramPane(): ReactElement {
  const current = useMusicPlayer(selectCurrentTrack)
  if (!current) {
    return (
      <div className="music-np__pane-body music-np__empty">
        <Radio size={24} aria-hidden="true" />
        <p>{musicText('music.nowplaying.empty')}</p>
      </div>
    )
  }
  return (
    <article className="music-np__pane-body music-program" aria-label={musicText('music.program.title')}>
      <h2 className="music-program__title">{current.title}</h2>
      <p className="music-program__meta">
        {current.albumId
          ? (
            <button
              type="button"
              className="music-np__artist"
              onClick={() => navigateToAddress(`/music/podcast/${encodeURIComponent(current.albumId)}`)}
            >
              {current.album || musicArtistNames(current)}
            </button>
          )
          : (current.album || musicArtistNames(current))}
      </p>
      {current.description
        ? <p className="music-program__body">{current.description}</p>
        : <p className="music-program__empty">{musicText('music.podcast.no_programs_hint')}</p>}
    </article>
  )
}

/**
 * The About pane of a podcast episode: what it is, where its podcast lives, and the way into its
 * comments thread.
 *
 * An episode is not a song, so Now Playing replaces lyrics and the stage with this description and
 * the comments thread. The description is the provider's own text, rendered as text. The comments
 * tab owns the thread; this pane only opens it, and an old row without a programme id says why it
 * cannot be opened instead of failing in the thread.
 */
import type { ReactElement } from 'react'
import { MessageCircle, Radio } from 'lucide-react'
import { musicArtistNames } from '@shared/music/format'
import { Button } from '../../../components/primitives'
import { navigateToAddress } from '../../../lib/app-history'
import { musicText } from '../components/labels'
import { musicPathFor } from '../music-address'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'
import { useMusicUi } from '../store/ui'

export function ProgramPane(): ReactElement {
  const current = useMusicPlayer(selectCurrentTrack)
  const setNowPlayingTab = useMusicUi((state) => state.setNowPlayingTab)
  if (!current) {
    return (
      <div className="music-np__pane-body music-np__empty">
        <Radio size={24} aria-hidden="true" />
        <p>{musicText('music.nowplaying.empty')}</p>
      </div>
    )
  }
  const commentsReady = Boolean(current.programId)
  const podcastId = current.albumId
  return (
    <article className="music-np__pane-body music-program" aria-label={musicText('music.program.title')}>
      <h2 className="music-program__title">{current.title}</h2>
      <p className="music-program__meta">
        {podcastId
          ? (
            <button
              type="button"
              className="music-np__artist"
              onClick={() => navigateToAddress(musicPathFor({ kind: 'podcastDetail', id: podcastId }))}
            >
              {current.album || musicArtistNames(current)}
            </button>
          )
          : (current.album || musicArtistNames(current))}
      </p>
      {current.description
        ? <p className="music-program__body">{current.description}</p>
        : <p className="music-program__empty">{musicText('music.program.no_description')}</p>}
      <div className="flex flex-wrap items-center gap-[var(--sp-2)] pt-[var(--sp-2)]">
        <Button
          size="sm"
          variant="secondary"
          icon={<MessageCircle size={14} />}
          disabled={!commentsReady}
          onClick={() => setNowPlayingTab('comments')}
        >
          {musicText('music.comments.title')}
        </Button>
      </div>
      {!commentsReady && (
        <p className="music-program__empty">{musicText('music.program.comments_unavailable')}</p>
      )}
    </article>
  )
}

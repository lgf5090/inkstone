/**
 * The left column of Now Playing: artwork, credits, progress and the full transport.
 *
 * The column is the only place the player shows its own volume; the bar's popover remains for quick
 * changes while browsing. A track with no artist id renders the name as text rather than a dead link.
 */
import type { ReactElement } from 'react'
import { Heart, Sparkles, Volume2, VolumeX } from 'lucide-react'
import { musicArtistNames } from '@shared/music/format'
import { Button, IconButton } from '../../../components/primitives'
import { Slider } from '../../../components/form'
import { navigateToAddress } from '../../../lib/app-history'
import { cn } from '../../../lib/cn'
import { useUi as useAppUi } from '../../../store/ui'
import { Cover } from '../components/Cover'
import { musicText } from '../components/labels'
import { RadioChip } from '../radio/RadioChip'
import { NowPlayingQualityBadge } from './QualityBadge'
import { useMusicLibrary } from '../store/library'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'
import { NowPlayingScrubber } from './Scrubber'
import { NowPlayingTransport } from './NowPlayingTransport'

export function NowPlayingSidebar({ onClose }: { onClose: () => void }): ReactElement {
  const current = useMusicPlayer(selectCurrentTrack)
  const status = useMusicPlayer((state) => state.status)
  const positionMs = useMusicPlayer((state) => state.positionMs)
  const durationMs = useMusicPlayer((state) => state.durationMs)
  const volume = useMusicPlayer((state) => state.volume)
  const muted = useMusicPlayer((state) => state.muted)
  const seek = useMusicPlayer((state) => state.seek)
  const setVolume = useMusicPlayer((state) => state.setVolume)
  const toggleMute = useMusicPlayer((state) => state.toggleMute)
  const favorites = useMusicLibrary((state) => state.favorites)
  const toggleFavorite = useMusicLibrary((state) => state.toggleFavorite)

  if (!current) {
    return (
      <div className="music-np__empty">
        <p className="music-np__empty-title">{musicText('music.nowplaying.empty')}</p>
        <Button variant="secondary" onClick={onClose}>{musicText('common.close')}</Button>
      </div>
    )
  }

  const favorite = favorites.some((entry) => entry.id === current.id)
  const openAssistant = (): void => {
    const app = useAppUi.getState()
    if (!app.assistantDockOpen) app.toggleAssistantDock()
    onClose()
  }

  return (
    <section aria-label={musicText('music.nowplaying.title')} className="music-np__sidebar">
      <Cover
        trackId={current.id}
        src={current.coverUrl || undefined}
        version={current.updatedAt}
        size="hero"
        radius="lg"
        className="music-np__cover"
      />
      <RadioChip />
      <div className="music-np__heading">
        <h2 className="music-np__title" title={current.title}>{current.title}</h2>
        <p className="music-np__artists">
          {current.artists.length > 0
            ? current.artists.map((artist, index) => (
              <span key={`${artist.id}-${index}`}>
                {artist.id
                  ? (
                    <button
                      type="button"
                      className="music-np__artist"
                      onClick={() => navigateToAddress(`/music/artist/${encodeURIComponent(artist.id)}`)}
                    >
                      {artist.name}
                    </button>
                  )
                  : artist.name}
                {index < current.artists.length - 1 ? ' / ' : ''}
              </span>
            ))
            : musicArtistNames(current)}
        </p>
      </div>

      <div className="music-np__actions">
        <NowPlayingQualityBadge />
        <IconButton
          label={musicText(favorite ? 'music.song.unfavorite' : 'music.song.favorite')}
          active={favorite}
          onClick={() => { void toggleFavorite(current) }}
        >
          <Heart size={17} className={favorite ? 'fill-current' : undefined} />
        </IconButton>
        <Button size="sm" variant="secondary" icon={<Sparkles size={14} />} onClick={openAssistant}>
          {musicText('music.nav.assistant')}
        </Button>
      </div>

      <NowPlayingScrubber
        positionMs={positionMs}
        durationMs={durationMs || current.durationMs}
        onSeek={seek}
      />

      <NowPlayingTransport />

      <div className={cn('music-np__volume', status === 'idle' && 'opacity-50')}>
        <IconButton
          label={musicText(muted ? 'music.playbar.unmute' : 'music.playbar.mute')}
          size="sm"
          onClick={toggleMute}
        >
          {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
        </IconButton>
        <Slider
          className="music-np__volume-slider flex-1"
          label={musicText('music.playbar.volume')}
          value={Math.round((muted ? 0 : volume) * 100)}
          min={0}
          max={100}
          step={1}
          onChange={(value) => setVolume(value / 100)}
        />
      </div>
    </section>
  )
}

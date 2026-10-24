/**
 * The full-screen listening surface: artwork, track information, a lyric area and the transport.
 *
 * Lyrics are a container here, not a renderer: the timed lines, translation rows and the current-line
 * highlight belong to the lyric task, and drawing a fake line list in the meantime would make the
 * empty state indistinguishable from a track without lyrics. The layer itself is the shared full
 * screen `Modal`, so focus moves in, Escape and the backdrop close it, and the queue drawer and this
 * surface cannot be open together (the UI store enforces that).
 */
import type { ReactElement } from 'react'
import { Pause, Play, SkipBack, SkipForward, X } from 'lucide-react'
import { formatDuration, musicArtistNames } from '@shared/music/format'
import { IconButton } from '../../../components/primitives'
import { Slider } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'
import { useMusicUi } from '../store/ui'
import { Cover } from './Cover'
import { musicText } from './labels'

export function NowPlaying(): ReactElement {
  const open = useMusicUi((state) => state.lyricsOpen)
  const setLyricsOpen = useMusicUi((state) => state.setLyricsOpen)
  const current = useMusicPlayer(selectCurrentTrack)
  const status = useMusicPlayer((state) => state.status)
  const positionMs = useMusicPlayer((state) => state.positionMs)
  const durationMs = useMusicPlayer((state) => state.durationMs)
  const toggle = useMusicPlayer((state) => state.toggle)
  const next = useMusicPlayer((state) => state.next)
  const prev = useMusicPlayer((state) => state.prev)
  const seek = useMusicPlayer((state) => state.seek)

  const playing = status === 'playing'
  const totalMs = durationMs || current?.durationMs || 0
  const totalSeconds = Math.max(1, Math.round(totalMs / 1000))
  const positionSeconds = Math.min(totalSeconds, Math.max(0, Math.round(positionMs / 1000)))
  const close = (): void => setLyricsOpen(false)

  return (
    <Modal
      open={open}
      onClose={close}
      variant="fullscreen"
      ariaLabel={musicText('music.nowplaying.title')}
      bodyClassName="music-nowplaying__body"
    >
      <div className="music-nowplaying">
        <div className="music-nowplaying__header">
          <span className="music-nowplaying__eyebrow">{musicText('music.nowplaying.title')}</span>
          <IconButton
            className="music-nowplaying__close"
            label={musicText('common.close')}
            size="sm"
            onClick={close}
          >
            <X size={16} />
          </IconButton>
        </div>

        {current ? (
          <>
            <div className="music-nowplaying__stage">
              <div className="music-nowplaying__art">
                <Cover trackId={current.id} src={current.coverUrl || undefined} size="xl" radius="lg" alt={current.title} />
              </div>
              <div className="music-nowplaying__info">
                <h2 className="music-nowplaying__title">{current.title}</h2>
                <p className="music-nowplaying__artist">{musicArtistNames(current)}</p>
                {current.album && <p className="music-nowplaying__album">{current.album}</p>}
              </div>
              <div
                className="music-nowplaying__lyrics"
                role="group"
                aria-label={musicText('music.lyrics.title')}
              >
                <p className="music-lyrics__empty">{musicText('music.lyrics.placeholder')}</p>
              </div>
            </div>

            <div className="music-nowplaying__controls">
              <div className="music-nowplaying__progress">
                <span className="music-playbar__time">{formatDuration(positionMs)}</span>
                <Slider
                  className="music-playbar__slider"
                  label={musicText('music.playbar.progress')}
                  value={positionSeconds}
                  min={0}
                  max={totalSeconds}
                  step={1}
                  suffix="s"
                  immediate
                  onChange={(value) => seek(value * 1000)}
                />
                <span className="music-playbar__time music-playbar__time--end">
                  {formatDuration(totalMs)}
                </span>
              </div>
              <div className="music-nowplaying__transport">
                <IconButton
                  label={musicText('music.playbar.previous')}
                  size="lg"
                  onClick={() => {
                    void prev()
                  }}
                >
                  <SkipBack size={18} />
                </IconButton>
                <IconButton
                  className="music-playbar__play"
                  label={musicText(playing ? 'music.playbar.pause' : 'music.playbar.play')}
                  size="lg"
                  active={playing}
                  onClick={() => {
                    void toggle()
                  }}
                >
                  {playing ? <Pause size={18} /> : <Play size={18} />}
                </IconButton>
                <IconButton
                  label={musicText('music.playbar.next')}
                  size="lg"
                  onClick={() => {
                    void next()
                  }}
                >
                  <SkipForward size={18} />
                </IconButton>
              </div>
            </div>
          </>
        ) : (
          <div className="music-nowplaying__empty">
            <p className="music-lyrics__empty">{musicText('music.nowplaying.empty')}</p>
          </div>
        )}
      </div>
    </Modal>
  )
}

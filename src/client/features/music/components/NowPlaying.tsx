/**
 * Now Playing: one immersive surface over the whole window, with a cover-derived backdrop.
 *
 * The shell owns the layer and the pane registry; each pane owns its own scroll and loading states.
 * Songs offer lyrics, the stage, the queue, the wall and comments; a podcast substitutes an About
 * pane for the lyric surfaces. The chosen lyric/stage pane is remembered on this device, while the
 * tab itself is session-only.
 */
import { useEffect, useRef, type ReactElement } from 'react'
import { Music2, X } from 'lucide-react'
import { IconButton } from '../../../components/primitives'
import { Modal } from '../../../components/overlay'
import { cn } from '../../../lib/cn'
import { musicApi } from '../api'
import { applyMusicThemeColors, loadCoverThemeColors } from '../player/theme-color'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'
import { useMusicSettings } from '../store/settings'
import { useMusicUi, type MusicNowPlayingTab } from '../store/ui'
import { CommentsPane } from '../comments/CommentsPane'
import { LyricsPane } from '../lyrics/LyricsPane'
import { StagePane } from '../stage/StagePane'
import { WallPane } from '../wall/WallPane'
import { musicText } from '../components/labels'
import { MusicTabs, type MusicTabItem } from '../components/Tabs'
import { NowPlayingSidebar } from '../now-playing/NowPlayingSidebar'
import { NowPlayingSlimBar } from '../now-playing/NowPlayingSlimBar'
import { ProgramPane } from '../now-playing/ProgramPane'
import { QueuePane } from '../now-playing/QueuePane'
import '../now-playing/now-playing.css'

export function NowPlaying(): ReactElement | null {
  const open = useMusicUi((state) => state.nowPlayingOpen)
  return open ? <NowPlayingLayer /> : null
}

function NowPlayingLayer(): ReactElement {
  const open = useMusicUi((state) => state.nowPlayingOpen)
  const tab = useMusicUi((state) => state.nowPlayingTab)
  const setNowPlayingOpen = useMusicUi((state) => state.setNowPlayingOpen)
  const setNowPlayingTab = useMusicUi((state) => state.setNowPlayingTab)
  const current = useMusicPlayer(selectCurrentTrack)
  const status = useMusicPlayer((state) => state.status)
  const queue = useMusicPlayer((state) => state.queue)
  const preferred = useMusicSettings((state) => state.local.preferredLyricsPane)
  const setLocal = useMusicSettings((state) => state.setLocal)
  const rootRef = useRef<HTMLDivElement>(null)
  const podcast = current?.kind === 'podcast'
  const tabs: readonly MusicTabItem<MusicNowPlayingTab>[] = podcast
    ? [
        { value: 'program', label: musicText('music.program.title') },
        { value: 'comments', label: musicText('music.comments.title') },
        { value: 'queue', label: musicText('music.queue.title') },
      ]
    : [
        { value: 'lyrics', label: musicText('music.lyrics.title') },
        { value: 'stage', label: musicText('music.stage.title') },
        { value: 'queue', label: musicText('music.queue.title'), count: queue.tracks.length },
        { value: 'wall', label: musicText('music.wall.title') },
        { value: 'comments', label: musicText('music.comments.title') },
      ]
  const immersive = !podcast && (tab === 'stage' || tab === 'wall')

  // A podcast owns the programme panes; a song never shows one. Switching selection is derived from
  // what actually plays rather than from the previous tab, so a restored queue cannot open "About".
  useEffect(() => {
    if (!current) return
    if (current.kind === 'podcast') {
      if (tab !== 'program' && tab !== 'comments' && tab !== 'queue') setNowPlayingTab('program')
      return
    }
    if (tab === 'program') setNowPlayingTab(preferred)
  }, [current?.id, current?.kind, preferred, setNowPlayingTab, tab])

  const coverUrl = current ? musicApi.coverUrl(current.id) : ''
  useEffect(() => {
    const element = rootRef.current
    if (!open || !element || !coverUrl) return
    let active = true
    void loadCoverThemeColors(coverUrl).then((colors) => {
      if (active) applyMusicThemeColors(element, colors)
    })
    return () => {
      active = false
      applyMusicThemeColors(element, null)
    }
  }, [coverUrl, open])

  const close = (): void => setNowPlayingOpen(false)
  const selectTab = (next: MusicNowPlayingTab): void => {
    setNowPlayingTab(next)
    if (next === 'lyrics' || next === 'stage') setLocal({ preferredLyricsPane: next })
  }

  const pane = ((): ReactElement => {
    switch (tab) {
      case 'stage':
        return <StagePane />
      case 'queue':
        return <QueuePane />
      case 'wall':
        return <WallPane />
      case 'comments':
        return <CommentsPane />
      case 'program':
        return <ProgramPane />
      case 'lyrics':
      default:
        return <LyricsPane />
    }
  })()

  return (
    <Modal
      open={open}
      onClose={close}
      variant="fullscreen"
      ariaLabel={musicText('music.nowplaying.title')}
      className="music-np-modal"
      bodyClassName="music-np__body"
    >
      <div
        ref={rootRef}
        className={cn('music-np', `music-np--${tab}`)}
        data-playing={status === 'playing' || undefined}
      >
        <div className="music-np__backdrop" aria-hidden="true">
          {coverUrl && (
            <div
              className="music-np__backdrop-image"
              style={{ backgroundImage: `url(${JSON.stringify(coverUrl)})` }}
            />
          )}
          <div className="music-np__backdrop-wash" />
        </div>

        <header className="music-np__topbar">
          <p className="music-np__brand">{musicText('music.nowplaying.title')}</p>
          {current && (
            <MusicTabs
              value={tab}
              items={tabs}
              onChange={selectTab}
              label={musicText('music.nowplaying.panes')}
              className="music-np__tabs"
            />
          )}
          <IconButton className="music-np__close" size="sm" label={musicText('common.close')} onClick={close}>
            <X size={17} />
          </IconButton>
        </header>

        {!current ? (
          <div className="music-np__empty">
            <Music2 size={28} aria-hidden="true" />
            <p className="music-np__empty-title">{musicText('music.nowplaying.empty')}</p>
            <p className="music-np__empty-hint">{musicText('music.playbar.hint')}</p>
          </div>
        ) : immersive ? (
          <div className="music-np__immersive">
            {pane}
            <NowPlayingSlimBar />
          </div>
        ) : (
          <div className="music-np__content">
            <NowPlayingSidebar onClose={close} />
            <div
              role="tabpanel"
              aria-label={musicText(
                tab === 'lyrics'
                  ? 'music.lyrics.title'
                  : tab === 'stage'
                    ? 'music.stage.title'
                    : tab === 'queue'
                      ? 'music.queue.title'
                      : tab === 'wall'
                        ? 'music.wall.title'
                        : tab === 'comments'
                          ? 'music.comments.title'
                          : 'music.program.title',
              )}
              className="music-np__pane"
            >
              {pane}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

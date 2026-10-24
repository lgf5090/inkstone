/**
 * One track in a list, a compact stack or a card grid.
 *
 * The row is a `<li>` holding a real `<button>`: the button is the press target that starts the
 * track, and the favourite and overflow controls are its siblings rather than children, so the row
 * never nests one control inside another. A right-click on the row opens the same menu at the
 * pointer; the overflow button opens it under itself.
 *
 * Enter and Space are handled explicitly because the tests drive keydown directly and because the row
 * must start playback even when a future variant is not a native button; the default action is
 * cancelled so the browser does not fire the click a second time.
 */
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import { AudioLines, Download, FileDown, Heart, ListPlus, MoreHorizontal, Play, Plus, ThumbsDown } from 'lucide-react'
import { formatDuration, musicArtistNames } from '@shared/music/format'
import type { MusicTrack } from '@shared/music/model'
import { cn } from '../../../lib/cn'
import { Button, IconButton } from '../../../components/primitives'
import { Menu, Modal, Tooltip, useContextMenu, type MenuItem } from '../../../components/overlay'
import { useMusicLibrary } from '../store/library'
import { musicApi } from '../api'
import { useMusicSettings } from '../store/settings'
import { useUi } from '../../../store/ui'
import { buildExportFilename } from '@shared/music/format'
import { useMusicPlayer } from '../store/player'
import { Cover } from './Cover'
import { musicText } from './labels'

export type SongRowVariant = 'list' | 'compact' | 'card'

export interface SongRowProps {
  track: MusicTrack
  /** Zero-based position in the list the row was rendered from. */
  index?: number
  variant?: SongRowVariant
  /** The track the player is pointed at, whether or not it is sounding. */
  active?: boolean
  /** The player is loading or sounding this track, which the state cell shows. */
  playing?: boolean
  /** A row a page cannot offer right now, with the sentence that explains why. */
  disabledReason?: string
  /** Extra or replacement menu rows. Omitted means the built-in "play next" row. */
  menuItems?: MenuItem[]
  onPlay: (track: MusicTrack) => void
  className?: string
}

export function SongRow({
  track,
  index,
  variant = 'list',
  active = false,
  playing = false,
  disabledReason,
  menuItems,
  onPlay,
  className,
}: SongRowProps): ReactElement {
  const favorite = useMusicLibrary((state) => state.favorites.some((entry) => entry.id === track.id))
  const toggleFavorite = useMusicLibrary((state) => state.toggleFavorite)
  const playlists = useMusicLibrary((state) => state.playlists)
  const addPlaylistTracks = useMusicLibrary((state) => state.addPlaylistTracks)
  const requestDownload = useMusicLibrary((state) => state.requestDownload)
  const settings = useMusicSettings((state) => state.server)
  const context = useContextMenu()
  const [moreOpen, setMoreOpen] = useState(false)
  const [playlistOpen, setPlaylistOpen] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  const fail = (title: string, error: unknown): void => {
    useUi.getState().toast({ title, description: error instanceof Error ? error.message : String(error), tone: 'danger' })
  }
  const addToPlaylist = (playlistId: string): void => {
    void addPlaylistTracks(playlistId, [track]).then(() => {
      useUi.getState().toast({ title: musicText('music.song.added_to_playlist'), tone: 'success' })
      setPlaylistOpen(false)
    }).catch((error: unknown) => fail(musicText('music.song.action_failed'), error))
  }
  const downloadLyrics = (): void => {
    void musicApi.lyrics(track.id).then((lyric) => {
      const text = [lyric.lrc.trim(), lyric.tlyric.trim()].filter(Boolean).join('\n\n')
      if (!text) {
        useUi.getState().toast({ title: musicText('music.song.lyrics_unavailable'), tone: 'warning' })
        return
      }
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = buildExportFilename(settings.downloadNameFormat, track, 'lrc')
      anchor.click()
      URL.revokeObjectURL(url)
    }).catch((error: unknown) => fail(musicText('music.song.download_lyrics_failed'), error))
  }

  const items = menuItems ?? [
    {
      id: 'play',
      label: musicText('music.song.play'),
      icon: <Play size={14} />,
      onSelect: () => onPlay(track),
    },
    {
      id: 'play-next',
      label: musicText('music.song.play_next'),
      icon: <ListPlus size={14} />,
      onSelect: () => {
        useMusicPlayer.getState().addNext(track)
      },
    },
    {
      id: 'download',
      label: musicText('music.song.download'),
      icon: <Download size={14} />,
      disabled: track.provider !== 'netease',
      separatorBefore: true,
      onSelect: () => {
        void requestDownload(track, settings.downloadQuality, settings.downloadFormat)
          .then(() => useUi.getState().toast({ title: musicText('music.song.download_started'), tone: 'success' }))
          .catch((error: unknown) => fail(musicText('music.song.action_failed'), error))
      },
    },
    {
      id: 'download-lyrics',
      label: musicText('music.song.download_lyrics'),
      icon: <FileDown size={14} />,
      onSelect: downloadLyrics,
    },
    {
      id: 'playlist',
      label: musicText('music.song.add_to_playlist'),
      icon: <Plus size={14} />,
      disabled: playlists.length === 0,
      onSelect: () => setPlaylistOpen(true),
    },
    {
      id: 'favorite',
      label: musicText(favorite ? 'music.song.unfavorite' : 'music.song.favorite'),
      icon: <Heart size={14} />,
      separatorBefore: true,
      onSelect: () => {
        void toggleFavorite(track)
      },
    },
    {
      id: 'dislike',
      label: musicText('music.song.dislike'),
      icon: <ThumbsDown size={14} />,
      disabled: track.provider !== 'netease',
      onSelect: () => {
        void musicApi.fmTrash(track.providerId)
          .then(() => useUi.getState().toast({ title: musicText('music.song.disliked'), tone: 'success' }))
          .catch((error: unknown) => fail(musicText('music.song.action_failed'), error))
      },
    },
  ]
  const hasMenu = items.length > 0
  const menuOpen = moreOpen || context.point !== null

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    if (event.repeat) return
    // Both keys are the button's own activation; cancelling the default keeps the browser from
    // firing the click a second time after this handler (Enter on keydown, Space on keyup).
    event.preventDefault()
    if (!disabledReason) onPlay(track)
  }

  const rowButton = (
    <button
      type="button"
      className="music-row__main"
      aria-disabled={disabledReason ? true : undefined}
      onClick={() => {
        if (!disabledReason) onPlay(track)
      }}
      onKeyDown={onKeyDown}
    >
      <span
        className={cn('music-row__state', active && 'music-row__state--active')}
        aria-hidden="true"
      >
        {active ? (
          <AudioLines size={14} className={playing ? undefined : 'opacity-50'} />
        ) : index === undefined ? (
          '-'
        ) : (
          index + 1
        )}
      </span>
      <Cover trackId={track.id} src={track.coverUrl || undefined} size="sm" radius="sm" />
      <span className="music-row__text">
        <span className="music-row__title" title={track.title}>{track.title}</span>
        <span className="music-row__meta" title={musicArtistNames(track)}>{musicArtistNames(track)}</span>
      </span>
      <span className="music-row__album" title={track.album}>{track.album}</span>
      <span className="music-row__duration">{formatDuration(track.durationMs)}</span>
    </button>
  )

  return (
    <li
      className={cn(
        'music-row',
        `music-row--${variant}`,
        active && 'music-row--active',
        disabledReason && 'music-row--disabled',
        className,
      )}
      onContextMenu={hasMenu ? context.onContextMenu : undefined}
    >
      {disabledReason ? <Tooltip label={disabledReason}>{rowButton}</Tooltip> : rowButton}

      <div className="music-row__actions">
        <IconButton
          label={musicText(favorite ? 'music.song.unfavorite' : 'music.song.favorite')}
          size="xs"
          active={favorite}
          onClick={() => {
            void toggleFavorite(track)
          }}
        >
          <Heart size={14} className={favorite ? 'fill-current' : undefined} />
        </IconButton>
        {hasMenu && (
          <IconButton
            ref={moreRef}
            label={musicText('music.song.more')}
            size="xs"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMoreOpen(true)}
          >
            <MoreHorizontal size={15} />
          </IconButton>
        )}
      </div>

      {hasMenu && (
        <Menu
          anchor={context.point ?? moreRef}
          open={menuOpen}
          onClose={() => {
            setMoreOpen(false)
            context.close()
          }}
          items={items}
          align="end"
          width={220}
          label={musicText('music.song.menu')}
        />
      )}
      <Modal
        open={playlistOpen}
        onClose={() => setPlaylistOpen(false)}
        title={musicText('music.song.add_to_playlist')}
        width={420}
      >
        {playlists.length === 0 ? (
          <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{musicText('music.song.playlist_empty')}</p>
        ) : (
          <div className="flex flex-col gap-1">
            {playlists.map((playlist) => (
              <Button key={playlist.id} variant="ghost" className="justify-start" onClick={() => addToPlaylist(playlist.id)}>
                {playlist.name}
              </Button>
            ))}
          </div>
        )}
      </Modal>
    </li>
  )
}

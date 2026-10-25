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
import { useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import {
  AudioLines,
  Check,
  CloudUpload,
  Download,
  FileDown,
  GripVertical,
  HardDriveDownload,
  Heart,
  ListEnd,
  ListPlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  Server,
  Square,
  Trash2,
} from 'lucide-react'
import { formatBytes, formatDuration, musicArtistNames, buildExportFilename } from '@shared/music/format'
import type { MusicTrack } from '@shared/music/model'
import { cn } from '../../../lib/cn'
import { Button, IconButton } from '../../../components/primitives'
import { Menu, Modal, Tooltip, confirm, useContextMenu, type MenuItem } from '../../../components/overlay'
import { useMusicLibrary } from '../store/library'
import { musicApi } from '../api'
import { useMusicSettings } from '../store/settings'
import { useUi } from '../../../store/ui'
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
  /** A page that owns an edit dialog can add the metadata action to the default menu. */
  onEditTrack?: (track: MusicTrack) => void
  /** A page that can remove a library row adds the destructive action to the default menu. */
  onRemoveTrack?: (track: MusicTrack) => void
  /** The library table's selection mode: pressing a row toggles it instead of starting playback. */
  selectionMode?: boolean
  selected?: boolean
  onToggleSelect?: () => void
  /** Show the source and size cells used by the merged "all music" table. */
  columns?: { source?: boolean; size?: boolean }
  /** The library table's drag handle; keyboard users get the move actions in the menu. */
  reorderable?: boolean
  onDragStart?: (event: DragEvent<HTMLElement>) => void
  onDragEnd?: () => void
  onDragOver?: (event: DragEvent<HTMLLIElement>) => void
  onDrop?: (event: DragEvent<HTMLLIElement>) => void
  dragging?: boolean
  dropTarget?: boolean
  onMoveTrack?: (direction: -1 | 1) => void
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
  onEditTrack,
  onRemoveTrack,
  selectionMode = false,
  selected = false,
  onToggleSelect,
  columns,
  reorderable = false,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  dragging = false,
  dropTarget = false,
  onMoveTrack,
  className,
}: SongRowProps): ReactElement {
  const favoriteEntry = useMusicLibrary((state) => state.favorites.find((entry) => entry.id === track.id))
  const favorite = Boolean(favoriteEntry)
  const toggleFavorite = useMusicLibrary((state) => state.toggleFavorite)
  const setFavoritePinned = useMusicLibrary((state) => state.setFavoritePinned)
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

  const downloadToDevice = async (): Promise<void> => {
    const url = musicApi.streamUrl(track.id)
    let preview = false
    let refused = false
    try {
      // A preview is playable but must not be saved as the song; the stream route marks it before
      // the browser follows the provider's redirect.
      const probe = await fetch(url, { headers: { Range: 'bytes=0-0' } })
      preview = probe.headers.get('x-music-free-trial') === '1'
      refused = !probe.ok && probe.status !== 206
      await probe.body?.cancel().catch((error: unknown) => {
        console.warn('[inkstone] Music preview probe body could not be cancelled:', error)
      })
    } catch (error) {
      // The probe can fail when the worker hands playback to a provider CDN; the anchor below is
      // still the browser's own request and may work, so a probe failure must not block it.
      console.warn('[inkstone] Music preview probe failed; the device download will be attempted:', error)
    }
    if (preview) {
      useUi.getState().toast({ title: musicText('music.song.preview_only'), tone: 'warning' })
      return
    }
    if (refused) {
      useUi.getState().toast({ title: musicText('music.song.action_failed'), tone: 'danger' })
      return
    }
    const extension = track.format || 'mp3'
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = buildExportFilename(settings.downloadNameFormat, track, extension)
    anchor.rel = 'noopener'
    anchor.click()
  }

  const transferTo = (target: 'r2' | 'webdav' | 'alist'): void => {
    const label = target === 'r2' ? 'R2' : target === 'webdav' ? 'WebDAV' : 'Alist'
    useUi.getState().toast({ title: musicText('music.song.transferring', { target: label }) })
    if (target === 'r2') {
      void requestDownload(track, settings.downloadQuality, settings.downloadFormat)
        .then(() => useUi.getState().toast({
          title: musicText('music.song.transfer_queued', { target: label }),
          tone: 'success',
        }))
        .catch((error: unknown) => fail(musicText('music.song.transfer_failed'), error))
      return
    }
    // A search row has not been saved yet, and the transfer route names a library row rather than a
    // provider identity. Save the snapshot first, exactly as the download queue does.
    void musicApi.upsertTracks([track])
      .then((answer) => {
        const libraryTrack = answer.tracks[0]
        if (!libraryTrack) throw new Error(musicText('music.song.transfer_failed'))
        return musicApi.transferTrack(libraryTrack.id, target)
      })
      .then((answer) => {
        useMusicLibrary.getState().bumpTrackRevision()
        const where = answer.mountName ? `${label} · ${answer.mountName}` : label
        useUi.getState().toast({
          title: musicText('music.song.transferred', { target: where }),
          tone: 'success',
        })
      })
      .catch((error: unknown) => fail(musicText('music.song.transfer_failed'), error))
  }

  const removeFromLibrary = async (): Promise<void> => {
    if (!onRemoveTrack) return
    const approved = await confirm({
      title: musicText('music.song.remove_confirm_title'),
      description: musicText(
        track.provider === 'upload'
          ? 'music.song.remove_confirm_upload'
          : track.provider === 'netease'
            ? 'music.song.remove_confirm_online'
            : 'music.song.remove_confirm_reference',
        { title: track.title },
      ),
      confirmLabel: musicText('music.song.remove'),
      tone: 'danger',
    })
    if (!approved) return
    try {
      const answer = await musicApi.deleteTracks([track.id])
      if (!answer.removed.includes(track.id)) {
        throw new Error(musicText('music.song.remove_failed'))
      }
      await useMusicPlayer.getState().removeFromQueue(track.id)
      useMusicLibrary.getState().bumpTrackRevision()
      onRemoveTrack(track)
      useUi.getState().toast({ title: musicText('music.song.removed'), tone: 'success' })
    } catch (error) {
      fail(musicText('music.song.remove_failed'), error)
    }
  }

  const sourceLabel = track.r2Key
    ? musicText('music.song.source_r2')
    : track.provider === 'webdav'
      ? musicText('music.song.source_webdav')
      : track.provider === 'alist'
        ? musicText('music.song.source_alist')
        : ''
  const sourceKind = track.r2Key ? 'upload' : track.provider

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
      id: 'add-queue',
      label: musicText('music.song.add_to_queue'),
      icon: <ListEnd size={14} />,
      onSelect: () => {
        useMusicPlayer.getState().appendToQueue(track)
        useUi.getState().toast({ title: musicText('music.song.added_to_queue'), tone: 'success' })
      },
    },
    {
      id: 'play-from-here',
      label: musicText('music.song.play_from_here'),
      icon: <Play size={14} />,
      onSelect: () => onPlay(track),
    },
    ...(track.provider === 'netease'
      ? [
          ...(track.r2Key
            ? []
            : [{
                id: 'transfer-r2',
                label: musicText('music.song.transfer_r2'),
                icon: <HardDriveDownload size={14} />,
                separatorBefore: true,
                onSelect: () => transferTo('r2'),
              }]),
          {
            id: 'transfer-webdav',
            label: musicText('music.song.transfer_webdav'),
            icon: <CloudUpload size={14} />,
            separatorBefore: !track.r2Key,
            onSelect: () => transferTo('webdav'),
          },
          {
            id: 'transfer-alist',
            label: musicText('music.song.transfer_alist'),
            icon: <Server size={14} />,
            onSelect: () => transferTo('alist'),
          },
        ]
      : []),
    {
      id: 'download-device',
      label: musicText('music.song.download_device'),
      icon: <Download size={14} />,
      onSelect: () => { void downloadToDevice() },
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
    ...(favoriteEntry
      ? [{
          id: 'pin',
          label: musicText(favoriteEntry.pinnedAt ? 'music.song.unpin' : 'music.song.pin'),
          icon: favoriteEntry.pinnedAt ? <PinOff size={14} /> : <Pin size={14} />,
          checked: Boolean(favoriteEntry.pinnedAt),
          onSelect: () => {
            const next = !favoriteEntry.pinnedAt
            void setFavoritePinned(track.id, next).then((saved) => {
              if (!saved) {
                fail(musicText('music.song.action_failed'), new Error(musicText('music.library.error.favorite')))
                return
              }
              useUi.getState().toast({
                title: musicText(next ? 'music.song.pinned' : 'music.song.unpinned'),
                tone: 'success',
              })
            })
          },
        }]
      : []),
    ...(onEditTrack
      ? [{
          id: 'edit',
          label: musicText('music.song.edit'),
          icon: <Pencil size={14} />,
          onSelect: () => onEditTrack(track),
        }]
      : []),
    ...(onMoveTrack
      ? [
          {
            id: 'move-up',
            label: musicText('music.song.move_up'),
            icon: <GripVertical size={14} />,
            onSelect: () => onMoveTrack(-1),
          },
          {
            id: 'move-down',
            label: musicText('music.song.move_down'),
            icon: <GripVertical size={14} />,
            onSelect: () => onMoveTrack(1),
          },
        ]
      : []),
    ...(onRemoveTrack
      ? [{
          id: 'remove',
          label: musicText('music.song.remove'),
          icon: <Trash2 size={14} />,
          separatorBefore: true,
          onSelect: () => { void removeFromLibrary() },
        }]
      : []),
    {
      id: 'favorite',
      label: musicText(favorite ? 'music.song.unfavorite' : 'music.song.favorite'),
      icon: <Heart size={14} />,
      separatorBefore: !onRemoveTrack,
      onSelect: () => {
        void toggleFavorite(track)
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
    if (selectionMode) {
      onToggleSelect?.()
      return
    }
    if (!disabledReason) onPlay(track)
  }

  const rowButton = (
    <button
      type="button"
      className="music-row__main"
      aria-disabled={disabledReason ? true : undefined}
      aria-pressed={selectionMode ? selected : undefined}
      onClick={() => {
        if (selectionMode) {
          onToggleSelect?.()
          return
        }
        if (!disabledReason) onPlay(track)
      }}
      onKeyDown={onKeyDown}
    >
      <span
        className={cn(
          'music-row__state',
          active && !selectionMode && 'music-row__state--active',
          selectionMode && selected && 'music-row__state--selected',
        )}
        aria-hidden="true"
      >
        {selectionMode ? (
          selected ? <Check size={15} /> : <Square size={15} />
        ) : active ? (
          <AudioLines size={14} className={playing ? undefined : 'opacity-50'} />
        ) : index === undefined ? (
          '-'
        ) : (
          index + 1
        )}
      </span>
      <Cover trackId={track.id} src={track.coverUrl || undefined} version={track.updatedAt} size="sm" radius="sm" />
      <span className="music-row__text">
        <span className="music-row__title" title={track.title}>
          {track.title}
          {favoriteEntry?.pinnedAt && (
            <Pin
              size={11}
              aria-label={musicText('music.song.pinned')}
              className="ms-1 inline-block text-[var(--accent)] align-[-1px]"
            />
          )}
        </span>
        <span className="music-row__meta" title={musicArtistNames(track)}>{musicArtistNames(track)}</span>
      </span>
      <span className="music-row__album" title={track.album}>{track.album}</span>
      {columns?.source && (
        <span className="music-row__source" data-source={sourceKind}>
          <span className="music-row__source-dot" aria-hidden="true" />
          {sourceLabel}
        </span>
      )}
      {columns?.size && (
        <span className="music-row__size">{track.size === null ? '—' : formatBytes(track.size)}</span>
      )}
      <span className="music-row__duration">{formatDuration(track.durationMs)}</span>
    </button>
  )

  return (
    <li
      className={cn(
        'music-row',
        `music-row--${variant}`,
        (columns?.source || columns?.size) && 'music-row--library',
        selected && 'music-row--selected',
        dragging && 'music-row--dragging',
        dropTarget && 'music-row--drop-target',
        active && 'music-row--active',
        disabledReason && 'music-row--disabled',
        className,
      )}
      onContextMenu={hasMenu ? context.onContextMenu : undefined}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {reorderable && !selectionMode && (
        <span
          className="music-row__grip"
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          aria-hidden="true"
        >
          <GripVertical size={14} />
        </span>
      )}
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

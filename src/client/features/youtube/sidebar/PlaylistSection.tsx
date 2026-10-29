/** The saved playlists: pin/reorder, a right-click menu, and a touch-reachable more button. */
import { useRef, useState, type DragEvent } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, Copy, ExternalLink, ListVideo, MoreHorizontal, Pin, Plus, Trash2 } from 'lucide-react'
import type { SavedYouTubePlaylist } from '@shared/youtube/model'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { confirm, Menu, Tooltip, useContextMenu, type MenuItem } from '../../../components/overlay'
import { Button, IconButton } from '../../../components/primitives'
import { useUi } from '../../../store/ui'
import { useYoutubeStore } from '../store'
import { SidebarLink } from './SidebarLink'

export function PlaylistSection({
  playlists,
  activePlaylistId,
  expanded,
  onToggle,
  onOpenAdd,
  onSelect,
}: {
  playlists: SavedYouTubePlaylist[]
  activePlaylistId: string | null
  expanded: boolean
  onToggle: () => void
  onOpenAdd: () => void
  onSelect: (playlistId: string) => void
}) {
  const reorderPlaylists = useYoutubeStore((state) => state.reorderPlaylists)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const ordered = playlists
    .slice()
    .sort((left, right) => Number(right.pinned) - Number(left.pinned)
      || left.sortOrder - right.sortOrder
      || right.updatedAt - left.updatedAt)

  const move = (playlist: SavedYouTubePlaylist, direction: -1 | 1) => {
    const group = ordered.filter((entry) => entry.pinned === playlist.pinned)
    const index = group.findIndex((entry) => entry.id === playlist.id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= group.length) return
    const ids = group.map((entry) => entry.id)
    ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
    void reorderPlaylists(ids).catch(reportFailure)
  }

  const drop = (sourceId: string, target: SavedYouTubePlaylist) => {
    setDraggingId(null)
    const source = ordered.find((entry) => entry.id === sourceId)
    if (!source || source.id === target.id || source.pinned !== target.pinned) return
    const sourceIndex = ordered.findIndex((entry) => entry.id === sourceId)
    const targetIndex = ordered.findIndex((entry) => entry.id === target.id)
    const rest = ordered.filter((entry) => entry.id !== sourceId)
    const restTarget = rest.findIndex((entry) => entry.id === target.id)
    if (restTarget < 0) return
    rest.splice(sourceIndex < targetIndex ? restTarget + 1 : restTarget, 0, source)
    void reorderPlaylists(rest.map((entry) => entry.id)).catch(reportFailure)
  }

  return (
    <section className="mt-2">
      <div className="flex items-center gap-1 px-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-[var(--r-sm)] px-1 py-1 text-[length:var(--text-10-5)] font-semibold tracking-[0.075em] text-[var(--text-quaternary)] uppercase hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          <ChevronRight
            size={12}
            aria-hidden="true"
            className={cn('shrink-0 transition-transform duration-[var(--dur-fast)]', expanded && 'rotate-90')}
          />
          <span className="truncate">{t('youtube.sidebar.playlists')}</span>
        </button>
        <IconButton label={t('youtube.sidebar.add_playlist')} size="xs" onClick={onOpenAdd}>
          <Plus size={13} />
        </IconButton>
      </div>
      {expanded && (
        <div className="space-y-0.5 px-1 pt-0.5">
          {ordered.length === 0 ? (
            <div className="px-1 py-1">
              <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                {t('youtube.sidebar.no_playlists')}
              </p>
              <Button size="sm" variant="ghost" className="mt-1 px-0" onClick={onOpenAdd}>
                {t('youtube.sidebar.add_playlist')}
              </Button>
            </div>
          ) : (
            ordered.map((playlist) => {
              const group = ordered.filter((entry) => entry.pinned === playlist.pinned)
              return (
              <PlaylistRow
                key={playlist.id}
                playlist={playlist}
                active={activePlaylistId === playlist.id}
                first={group[0]?.id === playlist.id}
                last={group[group.length - 1]?.id === playlist.id}
                dragging={draggingId === playlist.id}
                onSelect={onSelect}
                onMove={move}
                onDragStart={() => setDraggingId(playlist.id)}
                onDragEnd={() => setDraggingId(null)}
                onDrop={drop}
              />
              )
            })
          )}
        </div>
      )}
    </section>
  )
}

function PlaylistRow({
  playlist,
  active,
  first,
  last,
  dragging,
  onSelect,
  onMove,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  playlist: SavedYouTubePlaylist
  active: boolean
  first: boolean
  last: boolean
  dragging: boolean
  onSelect: (playlistId: string) => void
  onMove: (playlist: SavedYouTubePlaylist, direction: -1 | 1) => void
  onDragStart: () => void
  onDragEnd: () => void
  onDrop: (sourceId: string, target: SavedYouTubePlaylist) => void
}) {
  const updatePlaylist = useYoutubeStore((state) => state.updatePlaylist)
  const removePlaylist = useYoutubeStore((state) => state.removePlaylist)
  const menu = useContextMenu()
  const rowRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const title = playlist.data.title || playlist.id

  const togglePin = () => {
    void updatePlaylist({ ...playlist, pinned: !playlist.pinned, updatedAt: Date.now() }).catch(reportFailure)
  }

  const remove = async () => {
    const confirmed = await confirm({
      title: t('youtube.sidebar.delete_playlist_title'),
      description: t('youtube.sidebar.delete_playlist_desc', { name: title }),
    })
    if (!confirmed) return
    try {
      await removePlaylist(playlist.id)
    } catch (error) {
      reportFailure(error)
    }
  }

  const link = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlist.id)}`

  const copyLink = () => {
    if (!navigator.clipboard?.writeText) {
      reportFailure(new Error(t('youtube.sidebar.copy_link')))
      return
    }
    void navigator.clipboard.writeText(link).then(() => {
      useUi.getState().toast({ title: t('common.copied'), tone: 'success' })
    }).catch(reportFailure)
  }

  const items: MenuItem[] = [
    {
      id: 'pin',
      label: playlist.pinned ? t('youtube.sidebar.unpin') : t('youtube.sidebar.pin'),
      icon: <Pin size={13} />,
      onSelect: togglePin,
    },
    {
      id: 'up',
      label: t('youtube.sidebar.move_up'),
      icon: <ArrowUp size={13} />,
      disabled: first,
      onSelect: () => onMove(playlist, -1),
    },
    {
      id: 'down',
      label: t('youtube.sidebar.move_down'),
      icon: <ArrowDown size={13} />,
      disabled: last,
      onSelect: () => onMove(playlist, 1),
    },
    {
      id: 'copy',
      label: t('youtube.sidebar.copy_link'),
      icon: <Copy size={13} />,
      onSelect: copyLink,
    },
    {
      id: 'open',
      label: t('youtube.sidebar.open_youtube'),
      icon: <ExternalLink size={13} />,
      onSelect: () => window.open(link, '_blank', 'noopener'),
    },
    {
      id: 'remove',
      label: t('youtube.sidebar.remove_playlist'),
      icon: <Trash2 size={13} />,
      tone: 'danger',
      separatorBefore: true,
      onSelect: () => { void remove() },
    },
  ]

  return (
    <div
      ref={rowRef}
      className={cn(
        'yt-sidebar-row group relative flex min-w-0 items-center rounded-[var(--r-sm)]',
        dropActive && 'ring-1 ring-[var(--accent)] bg-[var(--accent-soft)]',
        dragging && 'opacity-45',
      )}
      draggable
      onContextMenu={(event) => {
        setMenuOpen(false)
        menu.onContextMenu(event)
      }}
      onDragStart={(event: DragEvent<HTMLDivElement>) => {
        event.dataTransfer.setData('application/x-inkstone-youtube-row', playlist.id)
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={() => {
        setDropActive(false)
        onDragEnd()
      }}
      onDragOver={(event) => {
        event.preventDefault()
        setDropActive(true)
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDropActive(false)
        if (!event.dataTransfer.types.includes('application/x-inkstone-youtube-row')) return
        const source = event.dataTransfer.getData('application/x-inkstone-youtube-row')
        if (source) onDrop(source, playlist)
      }}
    >
      <SidebarLink
        href={`/youtube/playlists/${encodeURIComponent(playlist.id)}`}
        label={title}
        icon={<PlaylistThumb playlist={playlist} />}
        badge={playlist.pinned ? <Pin size={10} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" /> : undefined}
        active={active}
        onActivate={() => onSelect(playlist.id)}
        className="pr-8"
      />
      <Tooltip label={t('common.more_actions')} side="left">
        <IconButton
          label={t('common.more_actions')}
          size="xs"
          onClick={(event) => {
            event.stopPropagation()
            menu.close()
            setMenuOpen(true)
          }}
          className="absolute right-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100"
        >
          <MoreHorizontal size={12} />
        </IconButton>
      </Tooltip>
      {menuOpen && <Menu anchor={rowRef} open onClose={() => setMenuOpen(false)} items={items} align="end" />}
      {menu.point && <Menu anchor={menu.point} open onClose={menu.close} items={items} />}
    </div>
  )
}

function PlaylistThumb({ playlist }: { playlist: SavedYouTubePlaylist }) {
  const [failed, setFailed] = useState(false)
  if (failed || !playlist.data.thumbnailUrl) return <ListVideo size={14} />
  return (
    <img
      src={playlist.data.thumbnailUrl}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="h-4 w-4 shrink-0 rounded-[var(--r-xs)] object-cover"
    />
  )
}

function reportFailure(error: unknown): void {
  useUi.getState().toast({
    title: t('youtube.failed'),
    description: error instanceof Error ? error.message : String(error),
    tone: 'danger',
  })
}

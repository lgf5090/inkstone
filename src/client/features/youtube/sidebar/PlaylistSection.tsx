import { ChevronRight, ListVideo, Pin, Plus, Trash2 } from 'lucide-react'
import type { SavedYouTubePlaylist } from '@shared/youtube/model'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { confirm } from '../../../components/overlay'
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
  const updatePlaylist = useYoutubeStore((state) => state.updatePlaylist)
  const removePlaylist = useYoutubeStore((state) => state.removePlaylist)
  const ordered = playlists
    .slice()
    .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt)

  const togglePin = async (playlist: SavedYouTubePlaylist) => {
    try {
      await updatePlaylist({ ...playlist, pinned: !playlist.pinned, updatedAt: Date.now() })
    } catch (error) {
      reportFailure(error)
    }
  }

  const remove = async (playlist: SavedYouTubePlaylist) => {
    const title = playlist.data.title || playlist.id
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
            ordered.map((playlist) => (
              <div key={playlist.id} className="yt-sidebar-row relative flex min-w-0 items-center">
                <SidebarLink
                  href={`/youtube/playlists/${encodeURIComponent(playlist.id)}`}
                  label={playlist.data.title || playlist.id}
                  icon={<ListVideo size={14} />}
                  badge={
                    playlist.pinned ? (
                      <Pin size={10} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
                    ) : undefined
                  }
                  active={activePlaylistId === playlist.id}
                  onActivate={() => onSelect(playlist.id)}
                  className="pr-14"
                />
                <div className="yt-row-actions absolute right-0.5 flex items-center gap-0.5">
                  <IconButton
                    label={playlist.pinned ? t('youtube.sidebar.unpin') : t('youtube.sidebar.pin')}
                    size="xs"
                    active={playlist.pinned}
                    onClick={(event) => {
                      event.stopPropagation()
                      void togglePin(playlist)
                    }}
                  >
                    <Pin size={12} />
                  </IconButton>
                  <IconButton
                    label={t('youtube.sidebar.remove_playlist')}
                    size="xs"
                    onClick={(event) => {
                      event.stopPropagation()
                      void remove(playlist)
                    }}
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  )
}

function reportFailure(error: unknown): void {
  useUi.getState().toast({
    title: t('youtube.failed'),
    description: error instanceof Error ? error.message : String(error),
    tone: 'danger',
  })
}

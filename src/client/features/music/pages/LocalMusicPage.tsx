/** The tracks this deployment owns: uploads first, then remote WebDAV references, as real library rows. */
import { useEffect, useId, useMemo, useState, type ReactElement } from 'react'
import { formatBytes, formatDuration } from '@shared/music/format'
import type { MusicTrack } from '@shared/music/model'
import { Clock3, HardDrive, ListChecks, Music, Search, Trash2, X } from 'lucide-react'
import { Button } from '../../../components/primitives'
import { Input, Segmented } from '../../../components/form'
import { Empty } from '../../../components/feedback'
import { Modal, confirm } from '../../../components/overlay'
import { navigateToAddress } from '../../../lib/app-history'
import { useUi } from '../../../store/ui'
import { musicApi } from '../api'
import { useMusicQuery } from '../query'
import { useMusicLibrary } from '../store/library'
import { useMusicPlayer } from '../store/player'
import { SongList, type MusicTrackSort, type MusicTrackSortKey } from '../components/SongList'
import { EditTrackDialog } from '../components/EditTrackDialog'
import { M3UActions } from '../components/M3UActions'
import { MusicStatCard } from './parts/StatCard'
import { SectionHeader } from '../components/SectionHeader'
import { musicText } from '../components/labels'
import { PageError } from './parts/PageState'
import { PAGE_STACK } from './parts/P2QueryState'

type SourceFilter = 'all' | 'upload' | 'webdav' | 'alist'

const ORDER_KEY = 'inkstone.music.localOrder'
const SOURCE_OPTIONS: ReadonlyArray<{ value: SourceFilter; key: 'music.local.source_all' | 'music.song.source_r2' | 'music.song.source_webdav' | 'music.song.source_alist' }> = [
  { value: 'all', key: 'music.local.source_all' },
  { value: 'upload', key: 'music.song.source_r2' },
  { value: 'webdav', key: 'music.song.source_webdav' },
  { value: 'alist', key: 'music.song.source_alist' },
]

function readOrder(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    // A corrupted or unavailable local preference falls back to the server order.
    return []
  }
}

function saveOrder(ids: readonly string[]): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids))
  } catch {
    // The order is a per-device convenience; a full or unavailable storage keeps the in-memory list.
  }
}

function compareTracks(left: MusicTrack, right: MusicTrack, key: MusicTrackSortKey): number {
  switch (key) {
    case 'title': return left.title.localeCompare(right.title)
    case 'album': return left.album.localeCompare(right.album)
    case 'duration': return left.durationMs - right.durationMs
    case 'size': return (left.size ?? 0) - (right.size ?? 0)
    case 'source': {
      const rank: Record<string, number> = { upload: 0, webdav: 1, alist: 2 }
      return (rank[trackSource(left)] ?? 3) - (rank[trackSource(right)] ?? 3)
    }
  }
}

/** A downloaded online track is an R2 file even though its snapshot keeps the provider identity. */
function trackSource(track: MusicTrack): SourceFilter {
  if (track.r2Key) return 'upload'
  if (track.provider === 'webdav' || track.provider === 'alist') return track.provider
  return 'upload'
}

export function LocalMusicPage(): ReactElement {
  const headingId = useId()
  const [editing, setEditing] = useState<MusicTrack | null>(null)
  const [filter, setFilter] = useState('')
  const [source, setSource] = useState<SourceFilter>('all')
  const [sort, setSort] = useState<MusicTrackSort | null>(null)
  const [manualOrder, setManualOrder] = useState<string[]>(readOrder)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [playlistOpen, setPlaylistOpen] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  const trackRevision = useMusicLibrary((state) => state.trackRevision)
  const playlists = useMusicLibrary((state) => state.playlists)
  const addPlaylistTracks = useMusicLibrary((state) => state.addPlaylistTracks)
  const query = useMusicQuery(async () => {
    const [uploads, downloads, webdav, alist] = await Promise.all([
      musicApi.tracks('upload'),
      musicApi.tracks('download'),
      musicApi.tracks('webdav'),
      musicApi.tracks('alist'),
    ])
    return [...uploads.items, ...downloads.items, ...webdav.items, ...alist.items]
  }, [trackRevision])
  const tracks = query.data ?? []
  const totalDuration = tracks.reduce((sum, track) => sum + track.durationMs, 0)
  const totalSize = tracks.reduce((sum, track) => sum + (track.size ?? 0), 0)

  const visible = useMemo(() => {
    const keyword = filter.trim().toLowerCase()
    let list = source === 'all' ? tracks : tracks.filter((track) => trackSource(track) === source)
    if (keyword) {
      list = list.filter((track) => {
        const haystack = `${track.title} ${track.artists.map((artist) => artist.name).join(' ')} ${track.album}`.toLowerCase()
        return haystack.includes(keyword)
      })
    }
    if (sort) {
      const direction = sort.direction === 'asc' ? 1 : -1
      return [...list].sort((left, right) => direction * compareTracks(left, right, sort.key))
    }
    if (manualOrder.length > 0) {
      const rank = new Map(manualOrder.map((id, index) => [id, index]))
      return [...list].sort((left, right) => (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER))
    }
    return list
  }, [tracks, filter, source, sort, manualOrder])

  const selectedTracks = useMemo(
    () => visible.filter((track) => selectedIds.has(track.id)),
    [visible, selectedIds],
  )
  const allVisibleSelected = visible.length > 0 && visible.every((track) => selectedIds.has(track.id))

  useEffect(() => {
    setSelectedIds(new Set())
  }, [filter, source])

  const play = (track: MusicTrack, queue: readonly MusicTrack[]): void => {
    void useMusicPlayer.getState().playTrack(track, { queue })
  }

  const cycleSort = (key: MusicTrackSortKey): void => {
    setSort((current) => {
      if (!current || current.key !== key) return { key, direction: 'asc' }
      if (current.direction === 'asc') return { key, direction: 'desc' }
      return null
    })
  }

  const applyOrder = (ids: string[]): void => {
    setSort(null)
    setManualOrder(ids)
    saveOrder(ids)
  }

  const reorder = (fromId: string, toId: string): void => {
    const ids = visible.map((track) => track.id)
    const from = ids.indexOf(fromId)
    const to = ids.indexOf(toId)
    if (from < 0 || to < 0) return
    const next = ids.slice()
    const [moved] = next.splice(from, 1)
    if (!moved) return
    next.splice(to, 0, moved)
    applyOrder(next)
  }

  const moveTrack = (trackId: string, direction: -1 | 1): void => {
    const ids = visible.map((track) => track.id)
    const index = ids.indexOf(trackId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= ids.length) return
    const next = ids.slice()
    const [moved] = next.splice(index, 1)
    if (!moved) return
    next.splice(target, 0, moved)
    applyOrder(next)
  }

  const resetOrder = (): void => {
    setSort(null)
    setManualOrder([])
    saveOrder([])
  }

  const toggleSelection = (track: MusicTrack): void => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(track.id)) next.delete(track.id)
      else next.add(track.id)
      return next
    })
  }

  const toggleSelectAll = (): void => {
    setSelectedIds(allVisibleSelected ? new Set() : new Set(visible.map((track) => track.id)))
  }

  const leaveSelection = (): void => {
    setSelectionMode(false)
    setSelectedIds(new Set())
  }

  const removeSelected = async (): Promise<void> => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    const approved = await confirm({
      title: musicText('music.local.batch_remove_title'),
      description: musicText('music.local.batch_remove_body', { count: ids.length }),
      confirmLabel: musicText('music.local.remove_selected'),
      tone: 'danger',
    })
    if (!approved) return
    setBatchBusy(true)
    try {
      const answer = await musicApi.deleteTracks(ids)
      for (const id of answer.removed) await useMusicPlayer.getState().removeFromQueue(id)
      useMusicLibrary.getState().bumpTrackRevision()
      setSelectedIds(new Set())
      useUi.getState().toast({
        title: musicText('music.local.batch_removed', { count: answer.removed.length }),
        description: answer.skipped.length > 0
          ? musicText('music.local.batch_remove_partial', { count: answer.skipped.length })
          : undefined,
        tone: answer.skipped.length > 0 ? 'warning' : 'success',
      })
    } catch (error) {
      useUi.getState().toast({
        title: musicText('music.local.batch_remove_failed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    } finally {
      setBatchBusy(false)
    }
  }

  const addSelectedToPlaylist = (playlistId: string): void => {
    void addPlaylistTracks(playlistId, selectedTracks)
      .then(() => {
        useUi.getState().toast({ title: musicText('music.song.added_to_playlist'), tone: 'success' })
        setPlaylistOpen(false)
        setSelectedIds(new Set())
      })
      .catch((error: unknown) => {
        useUi.getState().toast({
          title: musicText('music.song.action_failed'),
          description: error instanceof Error ? error.message : String(error),
          tone: 'danger',
        })
      })
  }

  const clearFilters = (): void => {
    setFilter('')
    setSource('all')
  }

  const sourceOptions = SOURCE_OPTIONS.map((option) => ({ value: option.value, label: musicText(option.key) }))

  return (
    <section aria-labelledby={headingId} className={PAGE_STACK}>
      <SectionHeader
        level={1}
        id={headingId}
        title={musicText('music.page.local')}
        description={musicText('music.local.description', { count: tracks.length })}
      />

      <div className="flex flex-wrap items-center gap-[var(--sp-2)]">
        <Input
          value={filter}
          leading={<Search size={14} aria-hidden="true" />}
          trailing={filter ? (
            <button
              type="button"
              aria-label={musicText('music.local.clear_filter')}
              className="grid h-5 w-5 place-items-center rounded-[var(--r-sm)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              onClick={() => setFilter('')}
            >
              <X size={13} aria-hidden="true" />
            </button>
          ) : undefined}
          placeholder={musicText('music.local.filter_placeholder')}
          aria-label={musicText('music.local.filter_placeholder')}
          className="w-full sm:max-w-[280px]"
          onChange={(event) => setFilter(event.target.value)}
        />
        <Segmented
          value={source}
          options={sourceOptions}
          onChange={(value) => setSource(value)}
          size="sm"
          label={musicText('music.local.source_filter')}
        />
        <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-tertiary)]">
          {musicText('music.local.filter_count', { shown: visible.length, total: tracks.length })}
        </span>
        {(sort || manualOrder.length > 0) && (
          <Button size="sm" variant="ghost" onClick={resetOrder}>
            {musicText('music.local.reset_order')}
          </Button>
        )}
        <div className="ms-auto flex items-center gap-[var(--sp-1)]">
          {selectionMode ? (
            <>
              <Button size="sm" variant="secondary" disabled={visible.length === 0} onClick={toggleSelectAll}>
                {musicText(allVisibleSelected ? 'music.local.clear_selection' : 'music.local.select_all')}
              </Button>
              <Button size="sm" variant="ghost" onClick={leaveSelection}>
                {musicText('music.local.leave_selection')}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setSelectionMode(true)}>
              <ListChecks size={14} aria-hidden="true" />
              {musicText('music.local.select')}
            </Button>
          )}
        </div>
      </div>

      {tracks.length > 0 && (
        <div className="grid gap-[var(--sp-3)] sm:grid-cols-3">
          <MusicStatCard icon={<Music size={16} aria-hidden="true" />} label={musicText('music.local.stats.songs')} value={String(tracks.length)} />
          <MusicStatCard icon={<Clock3 size={16} aria-hidden="true" />} label={musicText('music.local.stats.duration')} value={formatDuration(totalDuration)} />
          <MusicStatCard icon={<HardDrive size={16} aria-hidden="true" />} label={musicText('music.local.stats.size')} value={formatBytes(totalSize)} />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-[var(--sp-2)]">
        <M3UActions tracks={visible} />
        <Button variant="secondary" size="sm" onClick={() => navigateToAddress('/music/uploads')}>
          {musicText('music.cloud.manage_uploads')}
        </Button>
      </div>

      {selectionMode && (
        <div className="flex flex-wrap items-center gap-[var(--sp-2)] rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-[var(--sp-3)] py-[var(--sp-2)]">
          <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {musicText('music.local.selected_count', { count: selectedTracks.length })}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={selectedTracks.length === 0 || playlists.length === 0}
            onClick={() => setPlaylistOpen(true)}
          >
            {musicText('music.local.add_selected_playlist')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={selectedTracks.length === 0 || batchBusy}
            loading={batchBusy}
            onClick={() => { void removeSelected() }}
          >
            <Trash2 size={14} aria-hidden="true" />
            {musicText('music.local.remove_selected')}
          </Button>
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {musicText('music.local.selection_hint')}
          </span>
        </div>
      )}

      {query.status === 'error' && !query.data ? (
        <PageError error={query.error} onRetry={query.reload} />
      ) : query.status === 'loading' && !query.data ? (
        <SongList loading onPlay={() => undefined} />
      ) : tracks.length === 0 ? (
        <Empty
          art="folder"
          title={musicText('music.local.empty')}
          description={musicText('music.local.empty_hint')}
          action={<Button variant="primary" onClick={() => navigateToAddress('/music/uploads')}>{musicText('music.cloud.manage_uploads')}</Button>}
        />
      ) : visible.length === 0 ? (
        <Empty
          art="search"
          compact
          title={musicText('music.local.no_filter_match')}
          description={musicText('music.local.no_filter_hint')}
          action={<Button variant="secondary" onClick={clearFilters}>{musicText('music.local.clear_filters')}</Button>}
        />
      ) : (
        <SongList
          tracks={visible}
          onPlay={play}
          onEditTrack={setEditing}
          onRemoveTrack={() => setSelectedIds(new Set())}
          columns={{ source: true, size: true }}
          sort={sort}
          onSort={cycleSort}
          selectionMode={selectionMode}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelection}
          reorderable
          onReorder={reorder}
          onMoveTrack={moveTrack}
        />
      )}

      <Modal
        open={playlistOpen}
        onClose={() => setPlaylistOpen(false)}
        title={musicText('music.local.add_selected_playlist')}
        width={420}
      >
        {playlists.length === 0 ? (
          <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{musicText('music.song.playlist_empty')}</p>
        ) : (
          <div className="flex flex-col gap-1">
            {playlists.map((playlist) => (
              <Button key={playlist.id} variant="ghost" className="justify-start" onClick={() => addSelectedToPlaylist(playlist.id)}>
                {playlist.name}
              </Button>
            ))}
          </div>
        )}
      </Modal>

      <EditTrackDialog
        track={editing}
        open={editing !== null}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          useMusicLibrary.getState().bumpTrackRevision()
        }}
      />
    </section>
  )
}

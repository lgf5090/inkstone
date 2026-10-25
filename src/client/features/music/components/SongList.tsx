/**
 * A list of tracks, optionally split into sticky-titled groups.
 *
 * The player state is read once here rather than in every row: a hundred rows subscribing to the
 * queue would each re-render when the position moves. Rows stay presentational; this component
 * tells them which one is current and hands them the press and menu callbacks.
 *
 * The library table turns on optional source/size cells, sortable headers, row selection and drag
 * reordering. Those switches are opt-in so the discovery shelves keep their smaller five-column
 * layout and their decorative header.
 */
import { useId, useState, type DragEvent, type ReactElement, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import type { MusicTrack } from '@shared/music/model'
import { cn } from '../../../lib/cn'
import { Empty, Skeleton } from '../../../components/feedback'
import type { MenuItem } from '../../../components/overlay'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'
import { SongRow, type SongRowVariant } from './SongRow'
import { musicText } from './labels'
import type { MusicTrackSort, MusicTrackSortKey } from '../track-order'

export interface MusicSongGroup {
  key: string
  title: string
  tracks: readonly MusicTrack[]
}

export interface SongListProps {
  /** One flat list. Ignored when `groups` is passed. */
  tracks?: readonly MusicTrack[]
  groups?: readonly MusicSongGroup[]
  variant?: SongRowVariant
  /** Draw placeholder rows instead of the list; the page owns the error state above it. */
  loading?: boolean
  /** `queue` is the list the pressed track started from, so the player can continue through it. */
  onPlay: (track: MusicTrack, queue: readonly MusicTrack[]) => void
  menuItemsFor?: (track: MusicTrack) => MenuItem[]
  onEditTrack?: (track: MusicTrack) => void
  onRemoveTrack?: (track: MusicTrack) => void
  /** The merged library table adds source and size cells. */
  columns?: { source?: boolean; size?: boolean }
  sort?: MusicTrackSort | null
  onSort?: (key: MusicTrackSortKey) => void
  selectionMode?: boolean
  selectedIds?: ReadonlySet<string>
  onToggleSelect?: (track: MusicTrack) => void
  reorderable?: boolean
  onReorder?: (fromId: string, toId: string) => void
  onMoveTrack?: (trackId: string, direction: -1 | 1) => void
  emptyAction?: ReactNode
  className?: string
}

const SKELETON_ROWS = 8

function SongListSkeleton(): ReactElement {
  return (
    <div className="music-songlist__skeleton" role="status" aria-busy="true" aria-label={musicText('common.loading')}>
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div key={index} className="music-skeleton-row">
          <Skeleton className="music-skeleton-row__cover" />
          <div className="music-skeleton-row__text">
            <Skeleton className="music-skeleton-row__line" />
            <Skeleton className="music-skeleton-row__line music-skeleton-row__line--short" />
          </div>
          <Skeleton className="music-skeleton-row__duration" />
        </div>
      ))}
    </div>
  )
}

function HeaderCell({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string
  sortKey?: MusicTrackSortKey
  sort?: MusicTrackSort | null
  onSort?: (key: MusicTrackSortKey) => void
  className?: string
}): ReactElement {
  if (!sortKey || !onSort) return <span className={className}>{label}</span>
  const active = sort?.key === sortKey
  const direction = active ? sort?.direction : null
  return (
    <span
      className={className}
      role="columnheader"
      aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}
    >
      <button
        type="button"
        className="music-songlist__sort"
        title={musicText('music.songlist.sort_hint')}
        onClick={() => onSort(sortKey)}
      >
        {label}
        {direction === 'asc'
          ? <ArrowUp size={12} aria-hidden="true" />
          : direction === 'desc'
            ? <ArrowDown size={12} aria-hidden="true" />
            : <ArrowUpDown size={12} aria-hidden="true" className="music-songlist__sort-idle" />}
      </button>
    </span>
  )
}

export function SongList({
  tracks,
  groups,
  variant = 'list',
  loading = false,
  onPlay,
  menuItemsFor,
  onEditTrack,
  onRemoveTrack,
  columns,
  sort,
  onSort,
  selectionMode = false,
  selectedIds,
  onToggleSelect,
  reorderable = false,
  onReorder,
  onMoveTrack,
  emptyAction,
  className,
}: SongListProps): ReactElement {
  const current = useMusicPlayer(selectCurrentTrack)
  const status = useMusicPlayer((state) => state.status)
  const playing = status === 'playing' || status === 'loading'
  const idPrefix = useId()
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const library = Boolean(columns?.source || columns?.size)

  if (loading) return <SongListSkeleton />

  const buckets: readonly MusicSongGroup[] = groups ?? [{ key: 'all', title: '', tracks: tracks ?? [] }]
  const total = buckets.reduce((count, bucket) => count + bucket.tracks.length, 0)

  if (total === 0) {
    return (
      <Empty
        art="search"
        compact
        title={musicText('music.songlist.empty')}
        description={musicText('music.songlist.empty_hint')}
        action={emptyAction}
      />
    )
  }

  const beginDrag = (track: MusicTrack, event: DragEvent<HTMLElement>): void => {
    setDragId(track.id)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', track.id)
  }

  const dragOver = (track: MusicTrack, event: DragEvent<HTMLLIElement>): void => {
    if (!onReorder || !dragId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (overId !== track.id) setOverId(track.id)
  }

  const drop = (track: MusicTrack, event: DragEvent<HTMLLIElement>): void => {
    if (!onReorder) return
    event.preventDefault()
    const from = dragId ?? event.dataTransfer.getData('text/plain')
    setDragId(null)
    setOverId(null)
    if (from && from !== track.id) onReorder(from, track.id)
  }

  return (
    <div className={cn('music-songlist__frame', className)}>
      {buckets.map((bucket, bucketIndex) => {
        const headingId = `${idPrefix}-group-${bucketIndex}`
        return (
          <section
            key={bucket.key}
            className="music-songlist__section"
            aria-labelledby={bucket.title ? headingId : undefined}
          >
            {bucket.title && (
              <h3 id={headingId} className="music-songlist__group">
                {bucket.title}
              </h3>
            )}
            {variant === 'list' && (
              <div
                className={cn('music-songlist__head', library && 'music-songlist__head--library')}
                aria-hidden={library ? undefined : true}
              >
                {library && <span className="music-songlist__head-grip" aria-hidden="true" />}
                <span className="music-songlist__head-state">{musicText('music.songlist.number')}</span>
                <span className="music-songlist__head-cover" aria-hidden="true" />
                <HeaderCell label={musicText('music.songlist.title')} sortKey="title" sort={sort} onSort={onSort} />
                <HeaderCell
                  label={musicText('music.songlist.album')}
                  sortKey="album"
                  sort={sort}
                  onSort={onSort}
                  className="music-songlist__head-album"
                />
                {columns?.source && (
                  <HeaderCell
                    label={musicText('music.songlist.source')}
                    sortKey="source"
                    sort={sort}
                    onSort={onSort}
                    className="music-songlist__head-source"
                  />
                )}
                {columns?.size && (
                  <HeaderCell
                    label={musicText('music.songlist.size')}
                    sortKey="size"
                    sort={sort}
                    onSort={onSort}
                    className="music-songlist__head-size"
                  />
                )}
                <HeaderCell
                  label={musicText('music.songlist.duration')}
                  sortKey="duration"
                  sort={sort}
                  onSort={onSort}
                  className="music-songlist__head-duration"
                />
                <span aria-hidden="true" />
              </div>
            )}
            <ul className={cn('music-songlist', variant === 'card' && 'music-songlist--card')}>
              {bucket.tracks.map((track, index) => (
                <SongRow
                  key={track.id}
                  track={track}
                  index={index}
                  variant={variant}
                  active={current?.id === track.id}
                  playing={playing}
                  menuItems={menuItemsFor?.(track)}
                  onPlay={(next) => onPlay(next, bucket.tracks)}
                  onEditTrack={onEditTrack}
                  onRemoveTrack={onRemoveTrack}
                  columns={columns}
                  selectionMode={selectionMode}
                  selected={selectedIds?.has(track.id) ?? false}
                  onToggleSelect={() => onToggleSelect?.(track)}
                  reorderable={reorderable && Boolean(onReorder)}
                  onDragStart={(event) => beginDrag(track, event)}
                  onDragEnd={() => {
                    setDragId(null)
                    setOverId(null)
                  }}
                  onDragOver={(event) => dragOver(track, event)}
                  onDrop={(event) => drop(track, event)}
                  dragging={dragId === track.id}
                  dropTarget={overId === track.id && dragId !== track.id}
                  onMoveTrack={onMoveTrack ? (direction) => onMoveTrack(track.id, direction) : undefined}
                />
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

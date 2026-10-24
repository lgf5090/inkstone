/**
 * A list of tracks, optionally split into sticky-titled groups.
 *
 * The player state is read once here rather than in every row: a hundred rows subscribing to the
 * queue would each re-render when the position moves. Rows stay presentational; this component
 * tells them which one is current and hands them the press and menu callbacks.
 */
import { useId, type ReactElement, type ReactNode } from 'react'
import type { MusicTrack } from '@shared/music/model'
import { cn } from '../../../lib/cn'
import { Empty, Skeleton } from '../../../components/feedback'
import type { MenuItem } from '../../../components/overlay'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'
import { SongRow, type SongRowVariant } from './SongRow'
import { musicText } from './labels'

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

export function SongList({
  tracks,
  groups,
  variant = 'list',
  loading = false,
  onPlay,
  menuItemsFor,
  emptyAction,
  className,
}: SongListProps): ReactElement {
  const current = useMusicPlayer(selectCurrentTrack)
  const status = useMusicPlayer((state) => state.status)
  const playing = status === 'playing' || status === 'loading'
  const idPrefix = useId()

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
              <div className="music-songlist__head" aria-hidden="true">
                <span className="music-songlist__head-state">{musicText('music.songlist.number')}</span>
                <span className="music-songlist__head-cover" />
                <span>{musicText('music.songlist.title')}</span>
                <span className="music-songlist__head-album">{musicText('music.songlist.album')}</span>
                <span className="music-songlist__head-duration">{musicText('music.songlist.duration')}</span>
                <span />
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
                />
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

/**
 * The one card in every music grid: artwork, a two-line title, a fact line and an optional badge.
 *
 * The card is a `<button>`, not a `<div>` with a click handler: opening a playlist, an album, an
 * artist or a toplist is an action this app performs without a page load, and a native button keeps
 * Enter, Space, focus and the accessible name the title already provides.
 */
import type { ReactElement, ReactNode } from 'react'
import { cn } from '../../../../lib/cn'
import { Skeleton } from '../../../../components/feedback'
import { Cover } from '../../components/Cover'
import { musicText } from '../../components/labels'

export interface MusicCardProps {
  coverSrc?: string
  title: string
  meta?: ReactNode
  /** A small count or duration laid over the artwork's corner. */
  badge?: ReactNode
  /** Artist portraits are round; every other collection is square. */
  round?: boolean
  onOpen: () => void
  className?: string
}

export function MusicCard({
  coverSrc,
  title,
  meta,
  badge,
  round = false,
  onOpen,
  className,
}: MusicCardProps): ReactElement {
  return (
    <button
      type="button"
      className={cn(
        'music-card focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]',
        round && 'items-center text-center',
        className,
      )}
      onClick={onOpen}
    >
      <span className="relative flex w-full">
        <Cover
          src={coverSrc}
          size="lg"
          radius={round ? 'full' : 'md'}
          className="music-card__cover"
        />
        {badge && <span className="absolute right-1 bottom-1">{badge}</span>}
      </span>
      <span className="music-card__title">{title}</span>
      {meta && <span className="music-card__meta">{meta}</span>}
    </button>
  )
}

/** Placeholders with the card's own measure, used while a grid's first answer is in flight. */
export function CardGridSkeleton({
  count = 6,
  round = false,
}: {
  count?: number
  round?: boolean
}): ReactElement {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={musicText('common.loading')}
      className="music-card-grid"
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex flex-col gap-2 p-2" aria-hidden="true">
          <Skeleton
            className={cn('aspect-square w-full rounded-[var(--r-md)]', round && 'rounded-full')}
          />
          <Skeleton className="h-3 w-[70%]" />
          <Skeleton className="h-2.5 w-[45%]" />
        </div>
      ))}
    </div>
  )
}

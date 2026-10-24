/**
 * The header a collection page opens with: artwork, an eyebrow naming the kind of collection, the
 * title, a line of facts, an optional expandable description and the page's primary actions.
 *
 * Descriptions in the catalog run to several paragraphs. A clamped three lines plus an explicit
 * "more" button keeps the track list above the fold while leaving the full text one press away; the
 * button is a real `<button>` and reports its state with `aria-expanded`.
 */
import { useId, useState, type ReactElement, type ReactNode } from 'react'
import { cn } from '../../../../lib/cn'
import { Button } from '../../../../components/primitives'
import { Skeleton } from '../../../../components/feedback'
import { Cover } from '../../components/Cover'
import { musicText } from '../../components/labels'

/** Below this length the whole description fits the clamp, so the toggle would be noise. */
const DETAIL_DESCRIPTION_PREVIEW_CHARS = 220

export interface DetailHeroProps {
  coverSrc?: string
  /** Playlist and album artwork is square; an artist portrait is round. */
  coverShape?: 'square' | 'round'
  eyebrow?: string
  title: string
  meta?: ReactNode
  description?: string | null
  actions?: ReactNode
}

export function DetailHero({
  coverSrc,
  coverShape = 'square',
  eyebrow,
  title,
  meta,
  description,
  actions,
}: DetailHeroProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const descriptionId = useId()
  const text = description?.trim() ?? ''
  const collapsible = text.length > DETAIL_DESCRIPTION_PREVIEW_CHARS

  return (
    <header className="music-hero">
      <Cover src={coverSrc} size="xl" radius={coverShape === 'round' ? 'full' : 'lg'} />
      <div className="music-hero__text">
        {eyebrow && (
          <p className="text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-section)] text-[var(--text-quaternary)]">
            {eyebrow}
          </p>
        )}
        <h2 className="music-hero__title">{title}</h2>
        {meta && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {meta}
          </div>
        )}
        {text && (
          <p
            id={descriptionId}
            className={cn(
              'music-hero__description whitespace-pre-line',
              collapsible && !expanded && 'line-clamp-3',
            )}
          >
            {text}
          </p>
        )}
        {collapsible && (
          <Button
            size="sm"
            variant="ghost"
            className="-ml-2 self-start"
            aria-expanded={expanded}
            aria-controls={descriptionId}
            onClick={() => setExpanded((value) => !value)}
          >
            {musicText(expanded ? 'music.common.less' : 'music.common.more')}
          </Button>
        )}
        {actions && <div className="flex flex-wrap items-center gap-2 pt-1">{actions}</div>}
      </div>
    </header>
  )
}

/** The same header's geometry while the detail request is in flight, so the page does not jump. */
export function DetailHeroSkeleton({ round = false }: { round?: boolean }): ReactElement {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={musicText('common.loading')}
      className="music-hero"
    >
      <Skeleton
        className={cn(
          'size-[160px] shrink-0 rounded-[var(--r-lg)] md:size-[220px]',
          round && 'rounded-full',
        )}
      />
      <div className="music-hero__text flex-1 gap-3">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-8 w-[60%]" />
        <Skeleton className="h-3 w-[42%]" />
        <Skeleton className="h-9 w-32 rounded-[var(--r-md)]" />
      </div>
    </div>
  )
}

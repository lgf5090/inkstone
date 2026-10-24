/**
 * The states every music page shows before, instead of, or after its content.
 *
 * A page owns what a successful answer looks like; these pieces own the three answers that are not
 * content: a skeleton while the first request is in flight, an error with the one action that helps,
 * and the page-width column that keeps every screen on the same measure. The skeleton is the real
 * song list in its loading mode, so a page does not grow a second row rhythm beside the one it lists.
 */
import type { ReactElement, ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { cn } from '../../../../lib/cn'
import { Button } from '../../../../components/primitives'
import { musicText } from '../../components/labels'
import { SongList } from '../../components/SongList'

/** The page column: the same measure and rhythm for a home feed, a detail header and a result list. */
export function MusicPageBody({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}): ReactElement {
  return (
    <div className={cn('mx-auto flex w-full max-w-[1280px] flex-col gap-5 md:gap-6', className)}>
      {children}
    </div>
  )
}

/** A loader's message is already a string; a thrown value may not be. */
export function musicErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface PageErrorProps {
  error?: string | null
  onRetry: () => void
  /** A compact bar above content that is still readable, rather than a full-page answer. */
  compact?: boolean
  title?: string
  description?: string
  className?: string
}

/**
 * The one failure surface. It repeats the generic sentence in every page and only the route's own
 * message underneath: the message is diagnostic, the catalog line is what a reader is meant to act on.
 */
export function PageError({
  error,
  onRetry,
  compact = false,
  title,
  description,
  className,
}: PageErrorProps): ReactElement {
  const retry = musicText('music.error.retry')
  const resolvedTitle = title ?? musicText('music.error.title')
  const resolvedDescription = description ?? musicText('music.error.description')
  const retryButton = (
    <Button
      size={compact ? 'sm' : 'md'}
      variant="secondary"
      icon={<RotateCcw size={13} />}
      onClick={onRetry}
    >
      {retry}
    </Button>
  )

  if (compact) {
    return (
      <div
        role="alert"
        className={cn(
          'flex flex-wrap items-center gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-2',
          className,
        )}
      >
        <AlertTriangle size={15} className="shrink-0 text-[var(--danger)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">{resolvedTitle}</p>
          {error && (
            <p className="mt-0.5 line-clamp-2 break-words text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {error}
            </p>
          )}
        </div>
        {retryButton}
      </div>
    )
  }

  return (
    <div
      role="alert"
      className={cn(
        'flex min-h-[240px] flex-col items-center justify-center gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-6 py-10 text-center',
        className,
      )}
    >
      <AlertTriangle size={24} className="text-[var(--danger)]" aria-hidden="true" />
      <p className="text-[length:var(--text-13-5)] font-medium text-[var(--text-secondary)]">{resolvedTitle}</p>
      {resolvedDescription && (
        <p className="max-w-[50ch] text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">
          {resolvedDescription}
        </p>
      )}
      {error && (
        <p className="max-w-[70ch] break-words text-[length:var(--text-11)] text-[var(--text-quaternary)]">{error}</p>
      )}
      <div className="mt-1">{retryButton}</div>
    </div>
  )
}

/** The row skeleton SongList draws while loading; no row exists yet, so the press target is inert. */
export function TrackListSkeleton(): ReactElement {
  return <SongList tracks={[]} loading onPlay={() => undefined} />
}

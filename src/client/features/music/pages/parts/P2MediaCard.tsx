/**
 * The artwork card and the two images the library pages share.
 *
 * The card is an anchor because it navigates; the play control, where one exists, belongs to the
 * detail screen rather than being nested inside the link. Artwork falls back to a glyph instead of
 * the browser's broken-image box, and a blob URL is revoked with the blob it was made from.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { Music } from 'lucide-react'
import { Skeleton } from '../../../../components/feedback'
import { cn } from '../../../../lib/cn'
import { Cover } from '../../components/Cover'
import { musicText } from '../../components/labels'
import { onMusicLink } from './P2QueryState'

export interface MediaCardProps {
  href: string
  title: string
  meta?: string
  description?: string
  coverUrl?: string
  aspect?: 'square' | 'video'
  badge?: string
}

export function MediaCard({
  href,
  title,
  meta,
  description,
  coverUrl,
  aspect = 'square',
  badge,
}: MediaCardProps): ReactElement {
  return (
    <a
      href={href}
      onClick={(event) => onMusicLink(event, href)}
      className={cn(
        'music-card',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]',
      )}
    >
      <span className="relative block">
        <CardArtwork coverUrl={coverUrl} aspect={aspect} />
        {badge && (
          <span className="absolute end-[var(--sp-1-5)] bottom-[var(--sp-1-5)] rounded-[var(--r-sm)] bg-[var(--bg-overlay)] px-[var(--sp-1-5)] py-[1px] text-[length:var(--text-10-5)] font-medium tabular text-[var(--text-secondary)] shadow-[var(--shadow-pop)]">
            {badge}
          </span>
        )}
      </span>
      <span className="music-card__title">{title}</span>
      {meta && <span className="music-card__meta">{meta}</span>}
      {description && (
        <span className="line-clamp-2 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">
          {description}
        </span>
      )}
    </a>
  )
}

function CardArtwork({ coverUrl, aspect }: { coverUrl?: string; aspect: 'square' | 'video' }): ReactElement {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [coverUrl])

  return (
    <span
      className={cn(
        'relative flex w-full items-center justify-center overflow-hidden rounded-[var(--r-md)]',
        'bg-[var(--bg-sunken)] ring-1 ring-[var(--border-subtle)]',
        aspect === 'video' ? 'aspect-video' : 'aspect-square',
      )}
    >
      {coverUrl && !failed ? (
        <img
          src={coverUrl}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <Music aria-hidden="true" size={30} className="text-[var(--text-quaternary)] opacity-70" />
      )}
    </span>
  )
}

export function MediaGridSkeleton({
  count = 8,
  aspect = 'square',
}: {
  count?: number
  aspect?: 'square' | 'video'
}): ReactElement {
  return (
    <div className="music-card-grid" role="status" aria-busy="true" aria-label={musicText('common.loading')}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex flex-col gap-[var(--sp-2)] p-[var(--sp-2)]">
          <Skeleton
            className={cn(
              'w-full rounded-[var(--r-md)]',
              aspect === 'video' ? 'aspect-video' : 'aspect-square',
            )}
          />
          <Skeleton className="h-[13px] w-4/5" />
          <Skeleton className="h-[10px] w-1/2" />
        </div>
      ))}
    </div>
  )
}

/** A remote avatar (provider URLs are not the app's stored avatar format) with an initial fallback. */
export function RemoteAvatar({
  src,
  name,
  size = 72,
}: {
  src?: string
  name: string
  size?: number
}): ReactElement {
  const [failed, setFailed] = useState(false)
  const initial = name.trim().slice(0, 1).toLocaleUpperCase() || '?'

  useEffect(() => {
    setFailed(false)
  }, [src])

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--bg-raised)] text-[var(--text-secondary)] ring-1 ring-[var(--border-subtle)]"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
    >
      {src && !failed ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden="true">{initial}</span>
      )}
    </span>
  )
}

/** A cover the browser holds as bytes (an upload's extracted artwork). */
export function BlobCover({
  blob,
  size = 'md',
}: {
  blob: Blob | null
  size?: 'sm' | 'md' | 'lg'
}): ReactElement {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!blob) {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])

  return <Cover src={url ?? undefined} size={size} radius="md" />
}

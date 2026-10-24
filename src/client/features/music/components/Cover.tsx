/**
 * The square a track or playlist is drawn in.
 *
 * The artwork always comes from the music API's cover route, never from a provider URL: those expire,
 * leak the upstream host and are not reachable for uploads. A broken or missing image falls back to
 * the icon rather than the browser's broken-image glyph, and the fallback survives a `src` change so
 * a virtual list that reuses a row does not keep showing the previous track's failure.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { Music } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { musicApi } from '../api'

export type MusicCoverSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'hero'
export type MusicCoverRadius = 'sm' | 'md' | 'lg' | 'full'

export interface MusicCoverProps {
  /** The library track whose cover route is used when `src` is omitted. */
  trackId?: string
  /** An already-resolved URL. The default is `musicApi.coverUrl(trackId)`. */
  src?: string
  size?: MusicCoverSize
  radius?: MusicCoverRadius
  /** Empty by default: a title beside the artwork is the name, so the image must not repeat it. */
  alt?: string
  className?: string
}

export function Cover({
  trackId,
  src,
  size = 'sm',
  radius = 'sm',
  alt = '',
  className,
}: MusicCoverProps): ReactElement {
  const resolved = src ?? (trackId ? musicApi.coverUrl(trackId) : '')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [resolved])

  return (
    <span
      className={cn('music-cover', `music-cover--${size}`, `music-cover--r-${radius}`, className)}
    >
      {resolved && !failed ? (
        <img
          src={resolved}
          alt={alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="music-cover__img"
        />
      ) : (
        <Music aria-hidden="true" className="music-cover__glyph" />
      )}
    </span>
  )
}

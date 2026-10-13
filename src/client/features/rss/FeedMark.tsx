/**
 * A subscription's mark: its own picture if it has one, its initial if it does not.
 *
 * Favicons are the third-party asset an RSS reader cannot avoid, and they fail often — a host with
 * no `/favicon.ico`, a feed whose `image` is 512px of noise, an address the reader's own policy
 * says not to fetch. So the mark is always a circle of the right size with something in it, and the
 * picture only ever replaces the letter inside that circle once it has actually loaded.
 */
import { useEffect, useState } from 'react'
import { cn } from '../../lib/cn'
import { safeHttpUrl } from '@shared/rss/model'
import type { RssFeed } from '@shared/rss/model'

/** The best address for a feed's own icon: its site's favicon, since most feeds carry none. */
export function feedIconUrl(feed: RssFeed): string {
  const site = safeHttpUrl(feed.siteUrl) ?? safeHttpUrl(feed.url)
  if (!site) return ''
  if (/wechat2rss|weread|rsshub/i.test(site.hostname)) return ''
  return `${site.origin}/favicon.ico`
}

/** Leading brackets in either script the titles this reader holds are written in. */
const DECOR_PREFIX = new RegExp('^[\\s[({\\u3010\\uFF08\\u300A\\u300C\\u300E]+')

/** One grapheme for the fallback mark, in the script the title is actually written in. */
export function feedInitial(title: string): string {
  const trimmed = title.trim()
  if (!trimmed) return '?'
  const withoutDecor = trimmed.replace(DECOR_PREFIX, '')
  const chars = Array.from(withoutDecor || trimmed)
  const first = chars[0] ?? '?'
  return /[a-z]/i.test(first) ? first.toUpperCase() : first
}

export function FeedMark({ src, title, size = 20, className }: {
  src: string
  title: string
  size?: number
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  // A feed that gains an icon while the reader is looking at it should not keep showing the letter.
  useEffect(() => {
    setFailed(false)
  }, [src])
  const show = src && !failed
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--bg-hover)] text-[10px] font-semibold text-[var(--text-tertiary)]',
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.5)) }}
    >
      {show
        ? <img src={src} alt="" loading="lazy" className="size-full object-cover" onError={() => setFailed(true)} />
        : feedInitial(title)}
    </span>
  )
}

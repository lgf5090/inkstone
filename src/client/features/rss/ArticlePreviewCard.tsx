/**
 * The hover preview: what the row would become, without leaving the list.
 *
 * A reader scanning forty headlines decides whether an article is worth opening from three lines of
 * summary, and a feed that ships only three lines of summary is a coin flip. The card shows the
 * picture and the first paragraphs of the body the device already holds, which is enough to make the
 * decision without loading anything.
 *
 * It is a portal with `position: fixed` because the list is a scroll box: a card that is a descendant
 * of the row is clipped by it, and a card that is clipped is a card that never appears on the second
 * monitor. Placement is the wiki-link card's own rule — beside the row, flipped up when the viewport
 * runs out below — so the two popovers in this app do not disagree about the screen's edges.
 */
import { Z_INDEX } from '../../lib/z-index'
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink } from 'lucide-react'
import { t } from '../../lib/i18n'
import { shortSince } from '../../lib/time'
import { placeHoverCard } from '../preview/wiki-link-hover-card/position'
import type { RssEntry, RssFeed } from '@shared/rss/model'
import { api } from '../../lib/api'
import { displayImageUrl, htmlToText } from './sanitize'
import { FeedMark } from './FeedMark'

export function ArticlePreviewCard({ entry, feed, anchor, images, onDismiss }: {
  entry: RssEntry
  feed: RssFeed | undefined
  anchor: DOMRect
  images: 'relay' | 'direct' | 'off'
  onDismiss: () => void
}): ReactElement | null {
  const ref = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState<{ top: number, left: number } | null>(null)
  const picture = displayImageUrl(entry.imageUrl, { images, relay: url => api.rss.relayUrl(url) })
  const mark = displayImageUrl(feed?.imageUrl || '', { images, relay: url => api.rss.relayUrl(url) })
  const text = htmlToText(entry.content || entry.summary, 320)

  useEffect(() => {
    // A press anywhere, including on the row the card belongs to, retires the card. Leaving it up
    // while the reader works on something else is how a popover becomes wallpaper.
    const onDown = (): void => onDismiss()
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [onDismiss])

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const measure = node.getBoundingClientRect()
    const next = placeHoverCard(anchor, measure)
    if (box && Math.abs(box.top - next.top) < 1 && Math.abs(box.left - next.left) < 1) return
    setBox(next)
  })

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      aria-label={entry.title || t('rss.untitled')}
      className="fixed w-[320px] max-w-[calc(100vw-20px)] rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2 shadow-[var(--shadow-pop)]"
      style={{
        top: box?.top ?? anchor.bottom + 8,
        left: box?.left ?? anchor.left,
        zIndex: Z_INDEX.prompt,
        visibility: box ? 'visible' : 'hidden',
      }}
    >
      {picture && (
        <img
          src={picture}
          alt=""
          loading="lazy"
          decoding="async"
          className="mb-2 aspect-[16/9] w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] object-cover"
        />
      )}
      <div className="flex min-w-0 items-center gap-1.5">
        <FeedMark src={mark} title={feed?.title || entry.title} size={16} />
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">
          {feed?.title || t('rss.source_unknown')}
        </span>
        {entry.publishedTs && <span className="shrink-0 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]">{shortSince(entry.publishedTs)}</span>}
      </div>
      <p className="mt-1 line-clamp-3 text-[length:var(--text-13)] font-semibold leading-[19px] text-[var(--text-primary)]">
        {entry.title || t('rss.untitled')}
      </p>
      {text && <p className="mt-1 line-clamp-4 text-[length:var(--text-11-5)] leading-[16px] text-[var(--text-tertiary)]">{text}</p>}
      {entry.link && (
        <a
          href={entry.link}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="mt-2 inline-flex items-center gap-1 text-[length:var(--text-11-5)] font-medium text-[var(--accent)] hover:underline"
        >
          <ExternalLink size={11} aria-hidden="true" />
          {t('rss.open_original')}
        </a>
      )}
    </div>,
    document.body,
  )
}

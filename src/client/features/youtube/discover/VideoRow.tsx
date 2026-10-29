import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Eye, ExternalLink, Heart, MessageCircle, Pin, Play, ThumbsUp } from 'lucide-react'
import type { SavedYouTubeVideo, YouTubeTag, YouTubeVideo } from '@shared/youtube/model'
import { formatCount, formatPublished, parseDuration } from '@shared/youtube/model'
import { cn } from '../../../lib/cn'
import { getLocale, t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { IconButton } from '../../../components/primitives'
import { Menu, useContextMenu, type MenuItem } from '../../../components/overlay'
import { TagAssignBar } from '../tags/TagAssignBar'
import { thumbnailUrl } from '../api'
import { useYoutubeStore } from '../store'

export function VideoRow({
  video,
  saved,
  allTags,
  selected,
  onSelect,
}: {
  video: YouTubeVideo
  saved?: SavedYouTubeVideo
  allTags: YouTubeTag[]
  selected: boolean
  onSelect: (video: YouTubeVideo) => void
}) {
  const saveVideo = useYoutubeStore((state) => state.saveVideo)
  const [sourceIndex, setSourceIndex] = useState(0)
  const [copied, setCopied] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const rowRef = useRef<HTMLLIElement>(null)
  const menu = useContextMenu()
  const copyTimer = useRef(0)

  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  const sources = useMemo(
    () => [thumbnailUrl(video.id), video.thumbnailUrl, video.thumbnailHighUrl].filter((src): src is string => Boolean(src)),
    [video.id, video.thumbnailUrl, video.thumbnailHighUrl],
  )
  const imageSrc = sources[sourceIndex]
  const duration = parseDuration(video.duration) || (/^\d+(?::\d{2}){1,2}$/.test(video.duration) ? video.duration : '')
  const published = formatPublished(video.publishedAt, getLocale())
  const assignedTags = allTags.filter((tag) => saved?.tagIds.includes(tag.id))

  const fail = (error: unknown) => {
    useUi.getState().toast({
      title: t('youtube.failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
  }

  const togglePin = () => {
    void saveVideo(video, { pinned: !saved?.pinned }).catch(fail)
  }

  const toggleFavorite = () => {
    void saveVideo(video, { favorited: !saved?.favorited }).catch(fail)
  }

  const toggleTag = (tagId: string) => {
    const current = saved?.tagIds ?? []
    const tagIds = current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId]
    void saveVideo(video, { tagIds }).catch(fail)
  }

  const copy = async () => {
    const link = `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`
    try {
      if (!navigator.clipboard?.writeText) {
        useUi.getState().toast({
          title: t('youtube.failed'),
          description: t('youtube.video.copy'),
          tone: 'danger',
        })
        return
      }
      await navigator.clipboard.writeText(link)
      setCopied(true)
      window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      fail(error)
    }
  }

  const link = `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`
  const items: MenuItem[] = [
    {
      id: 'pin',
      label: saved?.pinned ? t('youtube.video.unpin') : t('youtube.video.pin'),
      icon: <Pin size={13} />,
      onSelect: togglePin,
    },
    {
      id: 'favorite',
      label: saved?.favorited ? t('youtube.video.unfavorite') : t('youtube.video.favorite'),
      icon: <Heart size={13} />,
      onSelect: toggleFavorite,
    },
    {
      id: 'copy',
      label: copied ? t('youtube.video.copied') : t('youtube.video.copy'),
      icon: <Copy size={13} />,
      onSelect: () => { void copy() },
    },
    {
      id: 'open',
      label: t('youtube.detail.open'),
      icon: <ExternalLink size={13} />,
      onSelect: () => window.open(link, '_blank', 'noopener'),
    },
  ]

  return (
    <li
      ref={rowRef}
      onContextMenu={(event) => {
        setMenuOpen(false)
        menu.onContextMenu(event)
      }}
      className={cn(
        'yt-row group relative flex gap-3 px-2 py-2 transition-colors duration-[var(--dur-fast)]',
        selected ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute inset-y-0 left-0 w-0.5 rounded-[var(--r-full)]',
          selected ? 'bg-[var(--youtube-brand)]' : 'bg-transparent',
        )}
      />
      <button
        type="button"
        aria-label={t('youtube.video.select', { title: video.title })}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(video)}
        className="absolute inset-0 z-0 rounded-[var(--r-sm)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      />
      <div className="pointer-events-none relative z-10 flex min-w-0 flex-1 gap-3">
        <div className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-[var(--r-sm)] bg-[var(--bg-hover)]">
          {imageSrc ? (
            <img
              src={imageSrc}
              alt={video.title}
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setSourceIndex((index) => index + 1)}
              className="size-full object-cover"
            />
          ) : (
            <span className="flex size-full items-center justify-center text-[var(--text-quaternary)]">
              <Play size={20} aria-hidden="true" />
            </span>
          )}
          {video.isLive && (
            <span className="absolute top-1 left-1 rounded-[var(--r-xs)] bg-[var(--yt-scrim)] px-1 text-[length:var(--text-10)] font-semibold text-[var(--yt-scrim-fg)]">
              {t('youtube.video.live')}
            </span>
          )}
          {duration && !video.isLive && (
            <span className="tabular absolute right-1 bottom-1 rounded-[var(--r-xs)] bg-[var(--yt-scrim)] px-1 text-[length:var(--text-10)] text-[var(--yt-scrim-fg)]">
              {duration}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1 sm:pr-20">
          <p className="line-clamp-2 text-[length:var(--text-13)] leading-snug font-medium text-[var(--text-primary)]">
            {video.title}
          </p>
          <p className="mt-0.5 truncate text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {video.channelTitle}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            {video.viewCount > 0 && (
              <span className="inline-flex items-center gap-1">
                <Eye size={11} aria-hidden="true" />
                <span className="sr-only">{t('youtube.video.views')}</span>
                <span className="tabular">{formatCount(video.viewCount)}</span>
              </span>
            )}
            {video.likeCount > 0 && (
              <span className="inline-flex items-center gap-1">
                <ThumbsUp size={11} aria-hidden="true" />
                <span className="sr-only">{t('youtube.video.likes')}</span>
                <span className="tabular">{formatCount(video.likeCount)}</span>
              </span>
            )}
            {video.commentCount > 0 && (
              <span className="inline-flex items-center gap-1">
                <MessageCircle size={11} aria-hidden="true" />
                <span className="sr-only">{t('youtube.video.comments')}</span>
                <span className="tabular">{formatCount(video.commentCount)}</span>
              </span>
            )}
            {published && (
              <time dateTime={video.publishedAt} className="inline-flex items-center gap-1">
                <span className="sr-only">{t('youtube.video.published')}</span>
                {published}
              </time>
            )}
          </div>

          <div className="yt-row-actions pointer-events-auto mt-1 flex items-center justify-end gap-0.5 sm:absolute sm:top-0 sm:right-0 sm:mt-0">
            <IconButton
              label={saved?.pinned ? t('youtube.video.unpin') : t('youtube.video.pin')}
              size="sm"
              active={Boolean(saved?.pinned)}
              onClick={togglePin}
            >
              <Pin size={13} />
            </IconButton>
            <IconButton
              label={saved?.favorited ? t('youtube.video.unfavorite') : t('youtube.video.favorite')}
              size="sm"
              active={Boolean(saved?.favorited)}
              onClick={toggleFavorite}
            >
              <Heart size={13} />
            </IconButton>
            <IconButton
              label={copied ? t('youtube.video.copied') : t('youtube.video.copy')}
              size="sm"
              onClick={() => void copy()}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </IconButton>
          </div>

          <div className="pointer-events-auto mt-1 flex flex-wrap items-center gap-1">
            <TagAssignBar video={video} assignedTags={assignedTags} allTags={allTags} onToggle={toggleTag} />
          </div>
        </div>
      </div>
      {menuOpen && <Menu anchor={rowRef} open onClose={() => setMenuOpen(false)} items={items} align="end" />}
      {menu.point && <Menu anchor={menu.point} open onClose={menu.close} items={items} />}
    </li>
  )
}

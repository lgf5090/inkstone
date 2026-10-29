/**
 * The selected video: player, the facts worth reading before the comments, and the thread itself.
 *
 * Every block is conditional on the data behind it. Upstream omits statistics for live or upcoming
 * videos and tags for most of them, and a saved row written by an older build can miss a field
 * outright — so a missing value draws nothing rather than the word "undefined" or an empty pill.
 */
import type { ReactNode } from 'react'
import {
  Calendar,
  ChevronLeft,
  Clock,
  ExternalLink,
  Eye,
  MessageCircle,
  ThumbsUp,
} from 'lucide-react'
import type { YouTubeVideo } from '@shared/youtube/model'
import { formatCount, formatPublished, parseDuration } from '@shared/youtube/model'
import { getLocale, t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Empty } from '../../../components/feedback'
import { TagPill } from '../../../components/TagChip'
import { CommentList } from './CommentList'
import { Player } from './Player'

export function VideoDetail({
  video,
  onBack,
}: {
  video: YouTubeVideo | null
  onBack?: () => void
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      {onBack && (
        <div className="shrink-0 border-b border-[var(--border-subtle)] p-[var(--sp-2)]">
          <Button size="sm" variant="ghost" icon={<ChevronLeft size={14} />} onClick={onBack}>
            {t('youtube.mobile.back')}
          </Button>
        </div>
      )}
      {video ? (
        <VideoBody video={video} />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Empty art="select" title={t('youtube.detail.empty')} compact />
        </div>
      )}
    </div>
  )
}

function VideoBody({ video }: { video: YouTubeVideo }) {
  const title = video.title?.trim() || video.id
  const channelTitle = video.channelTitle?.trim() || ''
  const channelId = video.channelId?.trim() || ''
  const description = typeof video.description === 'string' ? video.description : ''
  const published = formatPublished(video.publishedAt, getLocale())
  const duration = displayDuration(video.duration)
  const tags = Array.isArray(video.tags)
    ? video.tags
        .filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
        .slice(0, 15)
    : []
  const views = Number.isFinite(video.viewCount) && video.viewCount > 0 ? video.viewCount : 0
  const likes = Number.isFinite(video.likeCount) && video.likeCount > 0 ? video.likeCount : 0
  const comments =
    Number.isFinite(video.commentCount) && video.commentCount > 0 ? video.commentCount : 0

  return (
    <>
      <Player video={video} />

      <div className="border-b border-[var(--border-subtle)] p-[var(--sp-4)]">
        <h2 className="text-[length:var(--text-16)] leading-snug font-semibold break-words text-[var(--text-primary)]">
          {title}
        </h2>

        {channelTitle &&
          (channelId ? (
            <a
              href={`https://www.youtube.com/channel/${encodeURIComponent(channelId)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-[var(--sp-2)] inline-flex max-w-full items-center gap-[var(--sp-1)] text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline"
            >
              <span className="truncate">{channelTitle}</span>
              <ExternalLink size={11} aria-hidden="true" className="shrink-0" />
            </a>
          ) : (
            <p className="mt-[var(--sp-2)] truncate text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {channelTitle}
            </p>
          ))}

        {(views > 0 || published) && (
          <div className="mt-[var(--sp-1)] flex flex-wrap items-center gap-x-[var(--sp-3)] gap-y-[var(--sp-1)] text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {views > 0 && (
              <span className="inline-flex items-center gap-[var(--sp-1)]">
                <Eye size={12} aria-hidden="true" />
                <span className="sr-only">{t('youtube.video.views')}</span>
                <span className="tabular">{formatCount(views)}</span>
              </span>
            )}
            {published && (
              <time
                dateTime={video.publishedAt}
                className="inline-flex items-center gap-[var(--sp-1)]"
              >
                <Calendar size={12} aria-hidden="true" />
                <span className="sr-only">{t('youtube.video.published')}</span>
                {published}
              </time>
            )}
          </div>
        )}

        {(likes > 0 || comments > 0 || duration) && (
          <div className="mt-[var(--sp-3)] flex flex-wrap items-center gap-[var(--sp-2)]">
            {likes > 0 && (
              <StatPill
                icon={<ThumbsUp size={12} />}
                label={t('youtube.video.likes')}
                value={formatCount(likes)}
              />
            )}
            {comments > 0 && (
              <StatPill
                icon={<MessageCircle size={12} />}
                label={t('youtube.video.comments')}
                value={formatCount(comments)}
              />
            )}
            {duration && (
              <StatPill
                icon={<Clock size={12} />}
                label={t('youtube.video.duration')}
                value={duration}
              />
            )}
          </div>
        )}

        {tags.length > 0 && (
          <ul
            aria-label={t('youtube.detail.tags')}
            className="mt-[var(--sp-3)] flex flex-wrap gap-[var(--sp-1-5)]"
          >
            {tags.map((tag, index) => (
              <li key={`${tag}-${index}`} className="max-w-full">
                <TagPill label={tag} sigil title={tag} className="text-[length:var(--text-10-5)]" />
              </li>
            ))}
          </ul>
        )}

        {description.trim() && (
          <div
            role="region"
            aria-label={t('youtube.detail.description')}
            tabIndex={0}
            className="mt-[var(--sp-3)] max-h-48 overflow-y-auto whitespace-pre-wrap rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-[var(--sp-3)] text-[length:var(--text-12)] leading-relaxed break-words text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          >
            {description}
          </div>
        )}

        <a
          href={`https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-[var(--sp-3)] inline-flex items-center gap-[var(--sp-1)] text-[length:var(--text-11-5)] font-medium text-[var(--accent)] hover:underline"
        >
          <ExternalLink size={12} aria-hidden="true" />
          {t('youtube.detail.open')}
        </a>
      </div>

      <div className="p-[var(--sp-4)]">
        <CommentList key={video.id} videoId={video.id} commentCount={comments} />
      </div>
    </>
  )
}

function StatPill({
  icon,
  label,
  value,
}: {
  icon: ReactNode
  label: string
  value: string
}) {
  return (
    <span className="inline-flex items-center gap-[var(--sp-1)] rounded-[var(--r-full)] bg-[var(--bg-hover)] px-[var(--sp-2)] py-[var(--sp-1)] text-[length:var(--text-11)] text-[var(--text-secondary)]">
      <span aria-hidden="true" className="text-[var(--text-tertiary)]">
        {icon}
      </span>
      <span className="sr-only">{label}</span>
      <span className="tabular font-medium">{value}</span>
    </span>
  )
}

function displayDuration(value: string): string {
  if (!value) return ''
  const parsed = parseDuration(value)
  if (parsed) return parsed
  return /^\d+(?::\d{2}){1,2}$/.test(value) ? value : ''
}

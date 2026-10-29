import { ChevronLeft, ExternalLink } from 'lucide-react'
import type { YouTubeVideo } from '@shared/youtube/model'
import { t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Empty } from '../../../components/feedback'

export function VideoDetail({ video, onBack }: { video: YouTubeVideo | null; onBack?: () => void }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      {onBack && (
        <div className="shrink-0 border-b border-[var(--border-subtle)] p-2">
          <Button size="sm" variant="ghost" icon={<ChevronLeft size={14} />} onClick={onBack}>
            {t('youtube.mobile.back')}
          </Button>
        </div>
      )}
      {video ? (
        <div className="p-4">
          <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4">
            <h2 className="text-[length:var(--text-15)] leading-snug font-semibold text-[var(--text-primary)]">
              {video.title}
            </h2>
            <p className="mt-1 truncate text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {video.channelTitle}
            </p>
            <a
              href={`https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1 text-[length:var(--text-12)] text-[var(--accent)] hover:underline"
            >
              <ExternalLink size={12} aria-hidden="true" />
              {t('youtube.detail.open')}
            </a>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Empty art="select" title={t('youtube.detail.empty')} compact />
        </div>
      )}
    </div>
  )
}

import { Plus } from 'lucide-react'
import type { YouTubeTag, YouTubeVideo } from '@shared/youtube/model'
import { t } from '../../../lib/i18n'
import { TagPill } from '../../../components/TagChip'

export function TagAssignBar(props: {
  video: YouTubeVideo
  assignedTags: YouTubeTag[]
  allTags: YouTubeTag[]
  onToggle: (tagId: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {props.assignedTags.map((tag) => (
        <TagPill key={tag.id} label={tag.name} color={tag.color} />
      ))}
      <button
        type="button"
        disabled
        aria-label={t('youtube.tags.add_tag')}
        className="inline-flex items-center gap-1 rounded-[var(--r-full)] border border-dashed border-[var(--border-default)] px-[var(--sp-1-5)] py-[var(--sp-0-5)] text-[length:var(--text-11)] text-[var(--text-tertiary)] opacity-70"
      >
        <Plus size={11} aria-hidden="true" />
        {t('youtube.tags.add_tag')}
      </button>
    </div>
  )
}

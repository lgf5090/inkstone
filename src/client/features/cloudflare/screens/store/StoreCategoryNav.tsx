import { useState } from 'react'
import { Button } from '../../../../components/primitives'
import { Segmented } from '../../../../components/form'
import { useCfT } from '../../i18n'
import {
  templateTypeLabelKey,
  type CategoryCounts,
  type StoreCategory,
} from './helpers'

type CategoryValue = 'all' | StoreCategory

/** Tags beyond this count sit behind a toggle: forty chips pushed the template grid off the screen. */
const COLLAPSED_TAG_COUNT = 14

export function StoreCategoryNav({
  counts,
  tags,
  selectedType,
  selectedTags,
  onTypeChange,
  onToggleTag,
}: {
  counts: CategoryCounts
  tags: readonly string[]
  selectedType: StoreCategory | null
  selectedTags: readonly string[]
  onTypeChange: (type: StoreCategory | null) => void
  onToggleTag: (tag: string) => void
}) {
  const t = useCfT()
  const [expanded, setExpanded] = useState(false)
  const overflow = tags.length > COLLAPSED_TAG_COUNT
  const shownTags = !overflow || expanded
    ? tags
    : tags.filter((tag, index) => index < COLLAPSED_TAG_COUNT || selectedTags.includes(tag))
  const options: Array<{ value: CategoryValue; label: string }> = [
    { value: 'all', label: t('cloudflare.store_category_nav.all', { count: counts.all }) },
    { value: 'worker', label: `${t(templateTypeLabelKey('worker'))} (${counts.worker})` },
    { value: 'pages', label: `${t(templateTypeLabelKey('pages'))} (${counts.pages})` },
    { value: 'hybrid', label: `${t(templateTypeLabelKey('hybrid'))} (${counts.hybrid})` },
  ]

  return (
    <div className="flex flex-col gap-2">
      <Segmented
        label={t('cloudflare.store.title')}
        value={selectedType ?? 'all'}
        onChange={(value) => onTypeChange(value === 'all' ? null : value)}
        options={options}
      />
      {tags.length > 0 ? (
        <div role="group" aria-label={t('cloudflare.worker_settings.tags')} className="flex flex-wrap gap-1.5">
          {shownTags.map((tag) => {
            const selected = selectedTags.includes(tag)
            return (
              <Button
                key={tag}
                size="sm"
                variant={selected ? 'primary' : 'secondary'}
                aria-pressed={selected}
                onClick={() => onToggleTag(tag)}
              >
                {tag}
              </Button>
            )
          })}
          {overflow ? (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded
                ? t('cloudflare.store.collapse_tags')
                : t('cloudflare.store.expand_tags', { count: tags.length })}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

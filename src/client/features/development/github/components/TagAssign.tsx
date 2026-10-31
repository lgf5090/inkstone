import { useRef, useState } from 'react'
import { Tag as TagIcon, X } from 'lucide-react'
import type { GithubTag } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { Button } from '../../../../components/primitives'
import { Menu, type MenuItem } from '../../../../components/overlay'
import { TagPill } from '../../../../components/TagChip'
import { tagDepth } from '../lib/tags'

export function AssignedTagChips({ tags, onRemove }: { tags: GithubTag[]; onRemove?: (id: string) => void }) {
  if (tags.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.map((tag) => (
        <TagPill
          key={tag.id}
          label={tag.name}
          color={tag.color}
          trailing={onRemove ? (
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onRemove(tag.id)
              }}
              aria-label={t('development.github.tags.remove_tag')}
              className="rounded-full p-0.5 hover:bg-[var(--bg-hover)]"
            >
              <X size={10} />
            </button>
          ) : undefined}
        />
      ))}
    </div>
  )
}

export function TagAssign({
  assignedTags,
  allTags,
  onToggle,
}: {
  assignedTags: GithubTag[]
  allTags: GithubTag[]
  onToggle: (id: string) => void
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const assigned = new Set(assignedTags.map((tag) => tag.id))
  const items: MenuItem[] = allTags.map((tag) => ({
    id: tag.id,
    label: `${'\u00a0'.repeat(tagDepth(allTags, tag) * 2)}${tag.name}`,
    icon: <span className="size-2.5 rounded-full" style={{ backgroundColor: tag.color }} />,
    checked: assigned.has(tag.id),
    onSelect: () => onToggle(tag.id),
  }))
  return (
    <>
      <Button
        ref={anchor}
        variant="secondary"
        size="sm"
        className="h-6 gap-1 border-dashed px-2 text-[length:var(--text-11)]"
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setOpen(true)
        }}
      >
        <TagIcon size={10} />
        {assignedTags.length === 0 ? t('development.github.tags.assign') : `+${assignedTags.length}`}
      </Button>
      <Menu
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        items={items.length > 0 ? items : [{
          id: 'empty',
          label: t('development.github.tags.no_tags_hint'),
          disabled: true,
        }]}
        align="start"
        width={220}
        label={t('development.github.tags.assign_title')}
        searchable
      />
    </>
  )
}

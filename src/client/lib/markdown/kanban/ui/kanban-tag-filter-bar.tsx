import { useId, useMemo, useState } from 'react'
import { Tag } from 'lucide-react'
import { t } from '../../../i18n'
import { getKanbanTagStyle } from '../colors'
import { formatKanbanOptionLabel } from '../i18n-helpers'
import type { KanbanColorName, KanbanItem, KanbanProperty } from '../types'

interface KanbanTagFilterBarProps {
  tagsColumn?: KanbanProperty
  items: KanbanItem[]
  selectedTags?: string[]
  onToggleTag?: (tag: string) => void
  onClearTags?: () => void
}

function countTags(items: KanbanItem[], tagsColumn?: KanbanProperty): Map<string, number> {
  // Count under the column the resolver picked; the conventional key is only the fallback for a
  // board that has no tag column at all, where nothing can match anyway.
  const key = tagsColumn?.id ?? 'tags'
  const counts = new Map<string, number>()
  for (const item of items) {
    const tags = Array.isArray(item.properties[key]) ? (item.properties[key] as string[]) : []
    const subtaskTags = item.subtasks?.flatMap((st) => st.tags || []) || []
    const combined = new Set([...tags, ...subtaskTags])
    for (const tag of combined) {
      counts.set(tag, (counts.get(tag) || 0) + 1)
    }
  }
  return counts
}

function buildTagList(tagsColumn?: KanbanProperty, counts = new Map<string, number>()) {
  const options = tagsColumn?.options || []
  const list: { id: string; label: string; color?: KanbanColorName; count: number }[] = []
  for (const opt of options) {
    list.push({
      id: opt.id,
      label: opt.label,
      color: opt.color,
      count: counts.get(opt.id) || counts.get(opt.label) || 0,
    })
  }
  for (const [tag, count] of counts.entries()) {
    if (!list.some((x) => x.id === tag || x.label === tag)) {
      list.push({ id: tag, label: tag, count })
    }
  }
  return list
}

/**
 * The bar's own chip for a bar that has no room to be a row: with eight tags on a board the strip is
 * several lines, and every one of them came off the canvas (user report 2026-09-23). It is a
 * disclosure rather than a menu — the strip is in this same component, so pressing it shows what is
 * already here, and it keeps the count of what is in force while it is folded away.
 */
function TagBarChip({ selected, total, expanded, controls, onToggle }: {
  selected: number
  total: number
  expanded: boolean
  controls: string
  onToggle: () => void
}) {
  return (
    <button
      type='button'
      data-kanban-tags-chip
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={controls}
      className='@4xl:hidden inline-flex w-fit items-center gap-[var(--sp-1)] rounded-[var(--r-xs)] px-[var(--sp-1-5)] py-[var(--sp-0-5)] text-[length:var(--text-11)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
    >
      <Tag size={12} aria-hidden />
      <span>{t('preview.kanban_tags_chip', { selected, total })}</span>
    </button>
  )
}

/** One tag of the strip, with the count of the live cards that wear it. */
function TagChip({
  tag,
  isSelected,
  onToggle,
}: {
  tag: { id: string; label: string; color?: KanbanColorName; count: number }
  isSelected: boolean
  onToggle: (tag: string) => void
}) {
  return (
    <button
      type='button'
      onClick={() => onToggle(tag.id)}
      style={getKanbanTagStyle(tag.color || 'blue')}
      className={`inline-flex items-center gap-[var(--sp-1)] rounded-[var(--r-xs)] px-[var(--sp-2)] py-[var(--sp-0-5)] font-medium transition-all ${
        isSelected ? 'ring-2 ring-[var(--accent)] shadow-2xs font-semibold' : 'hover:ring-1 hover:ring-[var(--border-strong)]'
      }`}
    >
      <span>{formatKanbanOptionLabel(tag.label, 'tags')}</span>
      <span className='text-[length:var(--text-10)]'>({tag.count})</span>
    </button>
  )
}

/** The strip itself: its label, one chip per tag, and the way to drop the whole selection. */
function TagStrip({
  id,
  expanded,
  tagList,
  selectedTags,
  onToggleTag,
  onClearTags,
}: {
  id: string
  expanded: boolean
  tagList: { id: string; label: string; color?: KanbanColorName; count: number }[]
  selectedTags: string[]
  onToggleTag: (tag: string) => void
  onClearTags?: () => void
}) {
  return (
    <div
      id={id}
      className={`${expanded ? 'flex' : 'hidden'} @4xl:flex flex-wrap items-center gap-[var(--sp-1-5)] pt-[var(--sp-1)] text-[length:var(--text-11)]`}
    >
      <span className='flex items-center gap-[var(--sp-1)] text-[var(--text-tertiary)]'>
        <Tag size={12} aria-hidden />
        <span>{t('preview.kanban_prop_tags')}:</span>
      </span>
      {tagList.map((tag) => (
        <TagChip
          key={tag.id}
          tag={tag}
          isSelected={selectedTags.includes(tag.id) || selectedTags.includes(tag.label)}
          onToggle={onToggleTag}
        />
      ))}
      {selectedTags.length > 0 && onClearTags && (
        <button
          type='button'
          onClick={onClearTags}
          className='rounded-[var(--r-xs)] px-[var(--sp-1-5)] py-[var(--sp-0-5)] text-[length:var(--text-11)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
        >
          {t('common.clear')}
        </button>
      )}
    </div>
  )
}

export function KanbanTagFilterBar({
  tagsColumn,
  items,
  selectedTags = [],
  onToggleTag,
  onClearTags,
}: KanbanTagFilterBarProps) {
  const [expanded, setExpanded] = useState(false)
  const stripId = useId()
  const tagList = useMemo(() => {
    const counts = countTags(items, tagsColumn)
    return buildTagList(tagsColumn, counts)
  }, [tagsColumn, items])

  if (tagList.length === 0 || !onToggleTag) return null

  return (
    <div className='flex flex-col gap-[var(--sp-1)]'>
      <TagBarChip
        selected={selectedTags.length}
        total={tagList.length}
        expanded={expanded}
        controls={stripId}
        onToggle={() => setExpanded((open) => !open)}
      />
      <TagStrip
        id={stripId}
        expanded={expanded}
        tagList={tagList}
        selectedTags={selectedTags}
        onToggleTag={onToggleTag}
        onClearTags={onClearTags}
      />
    </div>
  )
}

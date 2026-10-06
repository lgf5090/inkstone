import { useId, useRef, useState } from 'react'
import { MoreHorizontal, Plus, X } from 'lucide-react'
import { t } from '../../../i18n'
import { getKanbanTagStyle, resolveKanbanTagColor } from '../colors'
import { formatKanbanOptionLabel } from '../i18n-helpers'
import type { KanbanColorName, KanbanOption, KanbanProperty } from '../types'
import { computeTagAddition, TagCreatePopover } from './kanban-tag-picker'

function CardTagItem({
  tag,
  options,
  isSelected,
  onSelect,
  onRemove,
}: {
  tag: string
  options?: KanbanOption[]
  isSelected?: boolean
  onSelect?: (tag: string) => void
  onRemove?: (tag: string) => void
}) {
  const color = resolveKanbanTagColor(tag, options)
  const opt = options?.find((o) => o.id === tag || o.label === tag)
  const label = opt?.label ?? tag
  const name = formatKanbanOptionLabel(label, 'tags')

  return (
    <span
      style={getKanbanTagStyle(color)}
      className={`group/tag inline-flex items-center gap-[var(--sp-0-5)] rounded-[var(--r-xs)] px-[var(--sp-1-5)] py-[var(--sp-0-5)] text-[length:var(--text-11)] font-semibold transition-all ${
        isSelected ? 'ring-2 ring-[var(--accent)]' : ''
      }`}
    >
      <button
        type='button'
        onClick={(e) => {
          e.stopPropagation()
          onSelect?.(tag)
        }}
        className='hover:underline'
        title={t('preview.kanban_filter')}
      >
        {name}
      </button>
      {onRemove && (
        <button
          type='button'
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
            onRemove(tag)
          }}
          // `!important` twice, scoped to this one utility: the tag chip and the card behind it both
          // reveal at once, and both variants carry the same specificity as `group-hover/card` —
          // Tailwind emits them in its own order, so without the flag which one wins is whichever rule
          // it happened to write last. Neither class reaches past this element.
          className='ml-[var(--sp-0-5)] rounded-[var(--r-xs)] p-[var(--sp-0-5)] opacity-0 transition-opacity group-hover/card:opacity-60 group-hover/tag:!opacity-100 focus-visible:!opacity-100 pointer-coarse:!opacity-100 hover:text-[var(--text-primary)]'
          aria-label={t('preview.kanban_remove_tag_named', { name })}
        >
          <X size={10} />
        </button>
      )}
    </span>
  )
}

interface CardAddTagButtonProps {
  itemId: string
  tagVals: string[]
  tagsCol?: KanbanProperty
  onUpdateTags?: (itemId: string, nextTags: string[], newOption?: KanbanOption) => void
  onAddColumnOption?: (columnId: string, option: KanbanOption) => void
}

function CardAddTagButton({ itemId, tagVals, tagsCol, onUpdateTags, onAddColumnOption }: CardAddTagButtonProps) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  if (!onUpdateTags) return null

  const handleAdd = (name: string, color: KanbanColorName) => {
    const { nextTags, newOption } = computeTagAddition(name, color, tagVals, tagsCol?.options)
    onUpdateTags(itemId, nextTags, newOption)
    if (newOption && onAddColumnOption) onAddColumnOption('tags', newOption)
  }

  return (
    <div className='relative inline-flex items-center'>
      <button
        ref={btnRef}
        type='button'
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          setOpen((prev) => !prev)
        }}
        className='inline-flex items-center gap-[var(--sp-0-5)] rounded-[var(--r-xs)] border border-dashed border-[var(--border-default)] px-[var(--sp-1)] py-[var(--sp-0-5)] text-[length:var(--text-10)] text-[var(--text-tertiary)] opacity-0 transition-opacity group-hover/card:opacity-100 focus-visible:opacity-100 pointer-coarse:!opacity-100 hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]'
        aria-label={t('preview.kanban_new_tag')}
        title={t('preview.kanban_new_tag')}
        aria-haspopup='dialog'
        aria-expanded={open}
        {...(open ? { 'aria-controls': panelId } : {})}
      >
        <Plus size={10} />
        <span>{t('preview.kanban_new_tag')}</span>
      </button>
      {open && (
        /* These events are the popover's while it is open: keys typed into its name field —
        arrows and Escape included — must not reach the board's key handler at the container. */
        <div onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <TagCreatePopover
            panelId={panelId}
            options={tagsCol?.options}
            existingTags={tagVals}
            anchorRef={btnRef}
            onClose={() => setOpen(false)}
            onAddTag={handleAdd}
          />
        </div>
      )}
    </div>
  )
}

export interface CardHeaderProps {
  isSelected: boolean
  itemId: string
  tagVals: string[]
  tagsCol?: KanbanProperty
  selectedTags?: string[]
  onToggleSelect: () => void
  onOpenDetail: () => void
  onToggleTag?: (tag: string) => void
  onUpdateTags?: (itemId: string, nextTags: string[], newOption?: KanbanOption) => void
  onAddColumnOption?: (columnId: string, option: KanbanOption) => void
}

export function CardHeader({
  isSelected,
  itemId,
  tagVals,
  tagsCol,
  selectedTags,
  onToggleSelect,
  onOpenDetail,
  onToggleTag,
  onUpdateTags,
  onAddColumnOption,
}: CardHeaderProps) {
  const handleRemove = onUpdateTags
    ? (tag: string) => onUpdateTags(itemId, tagVals.filter((t) => t !== tag))
    : undefined

  return (
    <div className='flex items-center justify-between gap-[var(--sp-1-5)]'>
      <div className='flex min-w-0 flex-wrap items-center gap-[var(--sp-1-5)]'>
        <input
          type='checkbox'
          checked={isSelected}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggleSelect}
          className='size-3.5 shrink-0 rounded-[var(--r-xs)] border-[var(--border-default)] accent-[var(--accent)] opacity-0 transition-opacity group-hover/card:opacity-100 focus-visible:opacity-100 checked:opacity-100 pointer-coarse:!opacity-100'
          aria-label={t('preview.kanban_select_card')}
        />
        {tagVals.slice(0, 5).map((tag) => (
          <CardTagItem
            key={tag}
            tag={tag}
            options={tagsCol?.options}
            isSelected={selectedTags?.includes(tag)}
            onSelect={onToggleTag}
            onRemove={handleRemove}
          />
        ))}
        <CardAddTagButton
          itemId={itemId}
          tagVals={tagVals}
          tagsCol={tagsCol}
          onUpdateTags={onUpdateTags}
          onAddColumnOption={onAddColumnOption}
        />
      </div>
      <button
        type='button'
        onClick={(e) => {
          e.stopPropagation()
          onOpenDetail()
        }}
        className='opacity-0 transition-opacity group-hover/card:opacity-100 focus-visible:opacity-100 pointer-coarse:!opacity-100 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
        aria-label={t('preview.kanban_card_details')}
      >
        <MoreHorizontal size={14} />
      </button>
    </div>
  )
}

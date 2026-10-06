import { useId, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { useClickOutside, useEscape } from '../../../../components/overlay'
import { t } from '../../../i18n'
import { getKanbanTagStyle, KANBAN_COLOR_NAMES, resolveKanbanTagColor } from '../colors'
import { formatKanbanColorName, formatKanbanOptionLabel } from '../i18n-helpers'
import type { KanbanColorName, KanbanOption } from '../types'

interface KanbanTagPickerProps {
  tags: string[]
  options?: KanbanOption[]
  onChangeTags: (tags: string[], newOption?: KanbanOption) => void
}

export function computeTagAddition(
  name: string,
  color: KanbanColorName,
  tagVals: string[],
  options?: KanbanOption[],
) {
  const existing = options?.find((o) => o.id === name || o.label === name)
  const tagId = existing ? existing.id : name.toLowerCase().replace(/\s+/g, '_')
  const nextTags = !tagVals.includes(tagId) && !tagVals.includes(name) ? [...tagVals, tagId] : tagVals
  const newOption = !existing || existing.color !== color ? { id: tagId, label: name, color } : undefined
  return { nextTags, newOption }
}

function TagChip({
  tag,
  options,
  onRemove,
}: {
  tag: string
  options?: KanbanOption[]
  onRemove: (tag: string) => void
}) {
  const opt = options?.find((o) => o.id === tag || o.label === tag)
  const color = resolveKanbanTagColor(tag, options)
  const name = formatKanbanOptionLabel(opt?.label ?? tag, 'tags')

  return (
    <span
      style={getKanbanTagStyle(color)}
      className='inline-flex items-center gap-1 rounded-[var(--r-xs)] px-2 py-0.5 text-[length:var(--text-11)] font-semibold'
    >
      <span>{name}</span>
      <button
        type='button'
        onClick={(e) => {
          e.stopPropagation()
          onRemove(tag)
        }}
        className='opacity-60 transition-opacity hover:opacity-100'
        aria-label={t('preview.kanban_remove_tag_named', { name })}
      >
        <X size={10} />
      </button>
    </span>
  )
}

function ColorDotPicker({
  selected,
  onSelect,
}: {
  selected: KanbanColorName
  onSelect: (c: KanbanColorName) => void
}) {
  return (
    <div className='flex flex-wrap gap-1'>
      {KANBAN_COLOR_NAMES.slice(0, 8).map((c) => {
        const label = formatKanbanColorName(c)
        return (
          <button
            key={c}
            type='button'
            onClick={() => onSelect(c)}
            title={label}
            aria-label={label}
            className={`size-4 rounded-full transition-transform hover:scale-125 ${
              selected === c ? 'ring-2 ring-[var(--accent)]' : ''
            }`}
            style={{ backgroundColor: `var(--kanban-tag-${c}-fg)` }}
          />
        )
      })}
    </div>
  )
}

function ExistingOptionsList({
  unselectedOptions,
  onSelectOption,
}: {
  unselectedOptions: KanbanOption[]
  onSelectOption: (opt: KanbanOption) => void
}) {
  if (unselectedOptions.length === 0) return null

  return (
    <div className='flex flex-wrap gap-1 border-b border-[var(--border-subtle)] pb-2'>
      {unselectedOptions.map((opt) => (
        <button
          key={opt.id}
          type='button'
          onClick={() => onSelectOption(opt)}
          style={getKanbanTagStyle(opt.color)}
          className='rounded-[var(--r-xs)] px-1.5 py-0.5 text-[length:var(--text-11)] font-medium transition-opacity hover:opacity-80'
        >
          + {formatKanbanOptionLabel(opt, 'tags')}
        </button>
      ))}
    </div>
  )
}

function TagInputField({
  tagName,
  tagColor,
  onChangeName,
  onAddTag,
  onClose,
}: {
  tagName: string
  tagColor: KanbanColorName
  onChangeName: (name: string) => void
  onAddTag: (name: string, color: KanbanColorName) => void
  onClose: () => void
}) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && tagName.trim()) {
      e.preventDefault()
      onAddTag(tagName.trim(), tagColor)
      onClose()
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  return (
    <div className='flex items-center gap-1'>
      <input
        type='text'
        autoFocus
        value={tagName}
        onChange={(e) => onChangeName(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('preview.kanban_tag_name')}
        className='min-w-0 flex-1 rounded-[var(--r-xs)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-[length:var(--text-12)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]'
      />
      <button
        type='button'
        disabled={!tagName.trim()}
        onClick={() => {
          if (tagName.trim()) {
            onAddTag(tagName.trim(), tagColor)
            onClose()
          }
        }}
        className='inline-flex shrink-0 items-center justify-center rounded-[var(--r-xs)] bg-[var(--accent)] px-2 py-1 text-[length:var(--text-11)] font-medium text-[var(--accent-fg)] opacity-90 transition-opacity hover:opacity-100 disabled:opacity-40'
        aria-label={t('preview.kanban_add_tag')}
      >
        <Plus size={11} />
      </button>
    </div>
  )
}

export function TagCreatePopover({
  panelId,
  options,
  existingTags,
  anchorRef,
  onClose,
  onAddTag,
}: {
  panelId: string
  options?: KanbanOption[]
  existingTags: string[]
  anchorRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
  onAddTag: (name: string, color: KanbanColorName) => void
}) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [tagName, setTagName] = useState('')
  const [tagColor, setTagColor] = useState<KanbanColorName>('blue')

  // The autoFocused input takes focus when the panel opens, so closing has to hand it
  // back — but only while it is still inside, since a click outside moved it already.
  const dismiss = () => {
    const hadFocus = popoverRef.current?.contains(document.activeElement) ?? false
    onClose()
    if (hadFocus) anchorRef.current?.focus()
  }
  useClickOutside([popoverRef, anchorRef], true, dismiss)
  useEscape(true, dismiss)

  const unselectedOptions = (options ?? []).filter(
    (o) => !existingTags.includes(o.id) && !existingTags.includes(o.label),
  )

  return (
    <div
      id={panelId}
      ref={popoverRef}
      role='dialog'
      aria-label={t('preview.kanban_add_tag')}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className='absolute left-0 top-full z-[var(--z-popover)] mt-1 w-56 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2.5 shadow-[var(--shadow-pop)]'
    >
      <div className='flex flex-col gap-2'>
        <ExistingOptionsList
          unselectedOptions={unselectedOptions}
          onSelectOption={(opt) => {
            onAddTag(opt.label || opt.id, opt.color)
            dismiss()
          }}
        />
        <TagInputField
          tagName={tagName}
          tagColor={tagColor}
          onChangeName={setTagName}
          onAddTag={onAddTag}
          onClose={dismiss}
        />
        <ColorDotPicker selected={tagColor} onSelect={setTagColor} />
      </div>
    </div>
  )
}

export function KanbanTagPicker({
  tags = [],
  options = [],
  onChangeTags,
}: KanbanTagPickerProps) {
  const [open, setOpen] = useState(false)
  const addBtnRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  const handleRemove = (tagToRemove: string) => {
    onChangeTags(tags.filter((t) => t !== tagToRemove))
  }

  const handleAdd = (name: string, color: KanbanColorName) => {
    const { nextTags, newOption } = computeTagAddition(name, color, tags, options)
    onChangeTags(nextTags, newOption)
  }

  return (
    <div className='relative flex flex-wrap items-center gap-1.5'>
      {tags.map((tag) => (
        <TagChip key={tag} tag={tag} options={options} onRemove={handleRemove} />
      ))}
      <button
        ref={addBtnRef}
        type='button'
        onClick={() => setOpen((o) => !o)}
        className='inline-flex items-center gap-1 rounded-[var(--r-xs)] border border-dashed border-[var(--border-default)] px-2 py-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]'
        aria-label={t('preview.kanban_new_tag')}
        aria-haspopup='dialog'
        aria-expanded={open}
        {...(open ? { 'aria-controls': panelId } : {})}
      >
        <Plus size={11} />
        <span>{t('preview.kanban_new_tag')}</span>
      </button>
      {open && (
        <TagCreatePopover
          panelId={panelId}
          options={options}
          existingTags={tags}
          anchorRef={addBtnRef}
          onClose={() => setOpen(false)}
          onAddTag={handleAdd}
        />
      )}
    </div>
  )
}

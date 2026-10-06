import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, MouseEvent, ReactNode, RefObject } from 'react'
import { Check, Copy, FilePlus2, FolderPlus, MoreHorizontal, Pencil, Pin, PinOff, Send, Star, Trash2 } from 'lucide-react'
import type { NoteTemplate } from '@shared/types'
import { cn } from '../../lib/cn'
import { IconButton } from '../../components/primitives'
import { Menu, Tooltip, useContextMenu, type MenuItem } from '../../components/overlay'
import { t } from '../../lib/i18n'

const MENU_WIDTH = 200

interface TemplateCardProps {
  template: NoteTemplate
  categoryName: string
  selectMode: boolean
  selected: boolean
  focused: boolean
  dragging?: boolean
  dropHint?: boolean | null
  onToggleSelect: () => void
  onDragStart?: (id: string) => void
  onDragOver?: (id: string, after: boolean) => void
  onDrop?: (template: NoteTemplate, after: boolean) => void
  onDragEnd?: () => void
  onUse: () => void
  onEdit: () => void
  onRename: () => void
  onDuplicate: () => void
  onMove: () => void
  onDelete: () => void
  onPublish: () => void
  onTogglePin: () => void
  onToggleStar: () => void
}

function templateMenuItems(
  template: NoteTemplate,
  handlers: {
    onEdit: () => void
    onRename: () => void
    onDuplicate: () => void
    onMove: () => void
    onPublish: () => void
    onDelete: () => void
  },
): MenuItem[] {
  const items: MenuItem[] = [
    { id: 'edit', label: t('templates.edit_template'), icon: <Pencil size={13}/>, onSelect: handlers.onEdit },
    { id: 'rename', label: t('templates.rename_template'), icon: <FilePlus2 size={13}/>, onSelect: handlers.onRename },
    { id: 'duplicate', label: t('templates.duplicate_template'), icon: <Copy size={13}/>, onSelect: handlers.onDuplicate },
    { id: 'move', label: t('templates.move_to_category'), icon: <FolderPlus size={13}/>, separatorBefore: true, onSelect: handlers.onMove },
    { id: 'publish', label: t('templates.publish_to_community'), icon: <Send size={13}/>, onSelect: handlers.onPublish },
  ]
  if (!template.builtin) {
    items.push({
      id: 'delete',
      label: t('templates.delete_template'),
      icon: <Trash2 size={13}/>,
      tone: 'danger',
      separatorBefore: true,
      onSelect: handlers.onDelete,
    })
  }
  return items
}

/**
 * The whole card is one button, so a click anywhere on it uses the template.
 * The title row, description, tags and footer are painted above that button on
 * the z-axis to stay readable, which would otherwise let them swallow the
 * click exactly where the "use this template" hint is drawn — so every one of
 * them is transparent to the pointer, and only the tool buttons opt back in.
 */
function CardUseButton({
  template,
  selectMode,
  selected,
  useButtonRef,
  onToggleSelect,
  onToggleStar,
  onUse,
}: {
  template: NoteTemplate
  selectMode: boolean
  selected: boolean
  useButtonRef: RefObject<HTMLButtonElement | null>
  onToggleSelect: () => void
  onToggleStar: () => void
  onUse: () => void
}) {
  return (
    <button
      ref={useButtonRef}
      type='button'
      onClick={(event: MouseEvent) => {
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault()
          onToggleStar()
          return
        }
        if (selectMode) {
          onToggleSelect()
          return
        }
        onUse()
      }}
      aria-pressed={selectMode ? selected : undefined}
      aria-label={selectMode
        ? `${t('templates.select_template')}: ${template.name}`
        : `${t('templates.use_template')}: ${template.name}`}
      className='absolute inset-0 z-0 rounded-[var(--r-lg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]'
    />
  )
}

function CardToolAction({ tooltip, icon, active, onClick }: {
  tooltip: string
  icon: ReactNode
  active?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip label={tooltip} side='top'>
      <IconButton
        label={tooltip}
        size='sm'
        active={active}
        onClick={(event) => {
          event.stopPropagation()
          onClick()
        }}
        className='size-6! text-[var(--text-tertiary)]'
      >
        {icon}
      </IconButton>
    </Tooltip>
  )
}

function CardTitleRow({
  template,
  selectMode,
  menuButtonRef,
  onToggleStar,
  onTogglePin,
  onOpenMenu,
}: {
  template: NoteTemplate
  selectMode: boolean
  menuButtonRef: RefObject<HTMLButtonElement | null>
  onToggleStar: () => void
  onTogglePin: () => void
  onOpenMenu: () => void
}) {
  return (
    <div className='pointer-events-none relative z-10 flex items-start justify-between gap-2'>
      <div className={cn('flex min-w-0 items-center gap-1.5', selectMode && 'pl-6')}>
        {template.isPinned && <Pin size={11} className='shrink-0 text-[var(--accent)]'/>}
        <h3 className='min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]'>
          {template.name}
        </h3>
        {template.isStarred && <Star size={11} className='shrink-0 fill-current text-[var(--warning)]'/>}
        {template.builtin && (
          <span className='shrink-0 rounded-full bg-[var(--bg-raised)] px-1.5 py-px text-[10px] font-medium text-[var(--text-quaternary)]'>
            {t('templates.builtin')}
          </span>
        )}
      </div>
      <div className='pointer-events-auto flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100'>
        <CardToolAction
          tooltip={template.isStarred ? t('common.remove_from_favorites') : t('navigation.favorites')}
          icon={template.isStarred ? <Star size={12} className='fill-current'/> : <Star size={12}/>}
          active={template.isStarred}
          onClick={onToggleStar}
        />
        <CardToolAction
          tooltip={template.isPinned ? t('notes.unpin') : t('notes.pin')}
          icon={template.isPinned ? <PinOff size={12}/> : <Pin size={12}/>}
          active={template.isPinned}
          onClick={onTogglePin}
        />
        <Tooltip label={t('common.more_actions')} side='top'>
          <IconButton
            ref={menuButtonRef}
            label={t('common.more_actions')}
            size='sm'
            onClick={(event) => {
              event.stopPropagation()
              onOpenMenu()
            }}
            className='size-6! text-[var(--text-tertiary)]'
          >
            <MoreHorizontal size={13}/>
          </IconButton>
        </Tooltip>
      </div>
    </div>
  )
}

function CardMetaFooter({ categoryName, lineCount }: { categoryName: string; lineCount: number }) {
  return (
    <div className='pointer-events-none relative z-10 mt-auto flex items-center gap-2 pt-2.5'>
      <span className='text-[10.5px] text-[var(--text-quaternary)]'>{categoryName}</span>
      <span className='text-[10.5px] text-[var(--text-quaternary)]'>·</span>
      <span className='text-[10.5px] text-[var(--text-quaternary)]'>{t('templates.lines_count', { value0: lineCount })}</span>
      <span className='ml-auto text-[10.5px] font-medium text-[var(--accent)] opacity-0 transition-opacity group-hover:opacity-100'>{t('templates.use_template')} →</span>
    </div>
  )
}

function SelectionBadge({ selected }: { selected: boolean }) {
  return (
    <span aria-hidden='true' className='pointer-events-none absolute top-3 left-3 z-20 flex size-4 items-center justify-center rounded border bg-[var(--bg-overlay)]'>
      {selected && <Check size={12} className='text-[var(--accent)]'/>}
    </span>
  )
}

function CardTagList({ tags }: { tags: string[] }) {
  return (
    <div className='pointer-events-none relative z-10 mt-1.5 flex min-w-0 flex-wrap items-center gap-1'>
      {tags.map((tag) => (
        <span key={tag} className='rounded-full bg-[var(--bg-raised)] px-1.5 py-px text-[10px] text-[var(--text-tertiary)]'>
          #{tag}
        </span>
      ))}
    </div>
  )
}

function templateCardClass(state: {
  selectMode: boolean
  dragging?: boolean
  selected: boolean
  focused: boolean
  dropHint?: boolean | null
}): string {
  return cn(
    'group relative flex min-h-33 flex-col rounded-[var(--r-lg)] border bg-[var(--bg-surface)] p-3.5 transition-[border-color,box-shadow,transform] duration-[var(--dur-fast)]',
    state.selectMode ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing',
    state.dragging && 'opacity-50',
    state.selected
      ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-[var(--shadow-sm)]'
      : 'border-[var(--border-subtle)] hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-sm)]',
    state.focused && 'ring-1 ring-[var(--accent)]',
    state.dropHint === true && 'shadow-[0_3px_0_0_var(--accent)]',
    state.dropHint === false && 'shadow-[0_-3px_0_0_var(--accent)]',
  )
}

export function TemplateCard(props: TemplateCardProps) {
  const {
    template, categoryName, selectMode, selected, focused, dragging, dropHint,
    onToggleSelect, onDragStart, onDragOver, onDrop, onDragEnd, onUse, onEdit, onRename,
    onDuplicate, onMove, onDelete, onPublish, onTogglePin, onToggleStar,
  } = props
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const useButtonRef = useRef<HTMLButtonElement>(null)
  const contextMenu = useContextMenu()
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  useEffect(() => {
    if (focused) useButtonRef.current?.focus({ preventScroll: true })
  }, [focused])
  const lineCount = useMemo(
    () => template.content.split('\n').filter((line) => line.trim()).length,
    [template.content],
  )
  const items = templateMenuItems(template, { onEdit, onRename, onDuplicate, onMove, onPublish, onDelete })
  const handleContextMenu = (event: MouseEvent) => {
    setIsMenuOpen(false)
    contextMenu.onContextMenu(event)
  }
  const handleDragStart = (event: DragEvent) => {
    if (selectMode) return event.preventDefault()
    event.dataTransfer.setData('application/x-inkstone-template', template.id)
    event.dataTransfer.effectAllowed = 'move'
    onDragStart?.(template.id)
  }
  const handleDragOver = (event: DragEvent) => {
    if (dragging || selectMode) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    onDragOver?.(template.id, event.clientY > rect.top + rect.height / 2)
  }
  const handleDrop = (event: DragEvent) => {
    if (selectMode) return
    event.preventDefault()
    onDrop?.(template, dropHint === true)
  }
  return (
    <div onContextMenu={handleContextMenu} data-template-id={template.id} draggable={!selectMode} onDragStart={handleDragStart} onDragOver={handleDragOver} onDrop={handleDrop} onDragEnd={onDragEnd} className={templateCardClass({ selectMode, dragging, selected, focused, dropHint })}>
      <CardUseButton template={template} selectMode={selectMode} selected={selected} useButtonRef={useButtonRef} onToggleSelect={onToggleSelect} onToggleStar={onToggleStar} onUse={onUse}/>
      {selectMode && <SelectionBadge selected={selected}/>}
      <CardTitleRow template={template} selectMode={selectMode} menuButtonRef={menuButtonRef} onToggleStar={onToggleStar} onTogglePin={onTogglePin} onOpenMenu={() => setIsMenuOpen(true)}/>
      {template.description && (
        <p className='pointer-events-none relative z-10 mt-1.5 line-clamp-2 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]'>{template.description}</p>
      )}
      {template.tags.length > 0 && <CardTagList tags={template.tags}/>}
      <CardMetaFooter categoryName={categoryName} lineCount={lineCount}/>
      <Menu anchor={menuButtonRef} open={isMenuOpen} onClose={() => setIsMenuOpen(false)} items={items} align='end' width={MENU_WIDTH}/>
      {contextMenu.point && <Menu anchor={contextMenu.point} open onClose={contextMenu.close} items={items} width={MENU_WIDTH}/>}
    </div>
  )
}

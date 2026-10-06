import { memo } from 'react'
import { Flag, Paperclip, Plus } from 'lucide-react'
import { t, useLocaleRepaint } from '../../../i18n'
import { kanbanCardCover } from '../card-fields'
import { getKanbanTagStyle, resolveKanbanTagColor } from '../colors'
import { formatKanbanOptionLabel } from '../i18n-helpers'
import { kanbanPersonName } from '../person'
import { kanbanPriorityColumn, kanbanStatusColumn, kanbanTagsColumn } from '../view-ops'
import type { KanbanData, KanbanItem, KanbanOption, KanbanProperty, KanbanSubtask } from '../types'
import { KanbanCardSubtasks } from './kanban-card-subtasks'
import { KanbanDateBadge } from './kanban-date-badge'
import { KanbanIconBadge } from './kanban-icon-badge'
import { KanbanPersonAvatar } from './kanban-person-picker'
import { KanbanRenderTail, useKanbanRenderWindow } from './kanban-render-window'

interface KanbanGalleryViewProps {
  data: KanbanData
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  onOpenDetail: (item: KanbanItem) => void
  onAddItem: () => void
  onUpdateSubtasks?: (itemId: string, nextSubtasks: KanbanSubtask[]) => void
}

interface GalleryCardProps {
  item: KanbanItem
  statusCol?: KanbanProperty
  priorityCol?: KanbanProperty
  tagsCol?: KanbanProperty
  isSelected: boolean
  onToggleSelect: (id: string) => void
  onOpenDetail: (item: KanbanItem) => void
  onUpdateSubtasks?: (itemId: string, nextSubtasks: KanbanSubtask[]) => void
}

function GalleryCover({ item }: { item: KanbanItem }) {
  const coverUrl = kanbanCardCover(item)

  if (coverUrl) {
    return (
      <div className='h-32 w-full overflow-hidden bg-[var(--bg-inset)]'>
        <img
          src={coverUrl}
          alt={item.title}
          loading='lazy'
          decoding='async'
          referrerPolicy='no-referrer'
          className='kanban-cover w-full object-cover transition-transform duration-300 hover:scale-105'
        />
      </div>
    )
  }

  return (
    <div className='h-2.5 w-full bg-gradient-to-r from-[var(--accent-soft)] via-[var(--bg-raised)] to-[var(--bg-inset)]' />
  )
}

function GalleryTagsHeader({
  isSelected,
  tagVals,
  tagsCol,
  floatsOverCover,
  onToggleSelect,
}: {
  isSelected: boolean
  tagVals: string[]
  tagsCol?: KanbanProperty
  floatsOverCover: boolean
  onToggleSelect: () => void
}) {
  return (
    <div
      className={`flex items-center justify-between gap-1.5 ${
        tagVals.length === 0 && floatsOverCover ? 'absolute left-3 top-3' : ''
      }`}
    >
      <div className='flex min-w-0 flex-wrap items-center gap-1.5'>
        <input
          type='checkbox'
          checked={isSelected}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggleSelect}
          className='size-3.5 rounded-[var(--r-xs)] border-[var(--border-default)] accent-[var(--accent)] opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 checked:opacity-100 pointer-coarse:!opacity-100'
          aria-label={t('preview.kanban_select_card')}
        />
        {tagVals.slice(0, 3).map((tag) => {
          const opt = tagsCol?.options?.find((o) => o.id === tag || o.label === tag)
          const color = resolveKanbanTagColor(tag, tagsCol?.options)
          const label = opt?.label ?? tag
          return (
            <span
              key={tag}
              style={getKanbanTagStyle(color)}
              className='inline-flex items-center rounded-[var(--r-xs)] px-1.5 py-0.5 text-[length:var(--text-11)] font-semibold'
            >
              {formatKanbanOptionLabel(label, 'tags')}
            </span>
          )
        })}
      </div>
    </div>
  )
}

function GalleryFooterMeta({
  item,
  statusOpt,
  priorityOpt,
  filesCount,
  assignee,
}: {
  item: KanbanItem
  statusOpt?: KanbanOption
  priorityOpt?: KanbanOption
  filesCount: number
  assignee?: string
}) {
  return (
    <div className='flex flex-wrap items-center justify-between gap-1.5 border-t border-[var(--border-subtle)] pt-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]'>
      <div className='flex flex-wrap items-center gap-1.5'>
        {statusOpt && (
          <span
            style={getKanbanTagStyle(statusOpt.color)}
            className='inline-flex items-center rounded-[var(--r-xs)] px-1.5 py-0.5 text-[length:var(--text-11)] font-medium'
          >
            {formatKanbanOptionLabel(statusOpt, 'status')}
          </span>
        )}
        {priorityOpt && (
          <span
            style={getKanbanTagStyle(priorityOpt.color)}
            className='inline-flex items-center gap-1 rounded-[var(--r-xs)] px-1.5 py-0.5 text-[length:var(--text-11)] font-medium'
          >
            <Flag size={11} />
            <span>{formatKanbanOptionLabel(priorityOpt, 'priority')}</span>
          </span>
        )}
        <KanbanDateBadge item={item} />
        {filesCount > 0 && (
          <span className='inline-flex items-center gap-0.5 text-[var(--text-tertiary)]'>
            <Paperclip size={11} />
            <span>{filesCount}</span>
          </span>
        )}
      </div>
      {assignee && <KanbanPersonAvatar name={assignee} />}
    </div>
  )
}

function GalleryCardTitleDesc({
  title,
  icon,
  desc,
  onOpenDetail,
}: {
  title: string
  icon?: string
  desc?: string
  onOpenDetail: () => void
}) {
  // The tile's type sits on this wrapper, not on the heading: prose owns a note's `h3` and wins any
  // utility written on it (see the hand-back block in `styles/kanban.css`).
  return (
    <div className='flex min-w-0 flex-1 flex-col gap-1 text-[length:var(--text-14)] font-semibold leading-snug'>
      <h3 className='flex items-start gap-1.5 text-[var(--text-primary)]'>
        {icon && (
          <span className='mt-0.5 shrink-0'>
            <KanbanIconBadge icon={icon} size={15} />
          </span>
        )}
        <button
          type='button'
          onClick={onOpenDetail}
          className='line-clamp-2 cursor-pointer text-left hover:text-[var(--accent)]'
        >
          {title || t('preview.kanban_untitled')}
        </button>
      </h3>
      {desc && (
        <p className='line-clamp-2 text-[length:var(--text-12)] font-normal text-[var(--text-tertiary)] leading-normal'>
          {desc}
        </p>
      )}
    </div>
  )
}

function GalleryCard({
  item,
  statusCol,
  priorityCol,
  tagsCol,
  isSelected,
  onToggleSelect,
  onOpenDetail,
  onUpdateSubtasks,
}: GalleryCardProps) {
  const statusVal = statusCol ? item.properties[statusCol.id] : undefined
  const statusOpt = statusCol?.options?.find((o) => o.id === statusVal || o.label === statusVal)
  const priorityVal = priorityCol ? item.properties[priorityCol.id] : undefined
  const priorityOpt = priorityCol?.options?.find((o) => o.id === priorityVal || o.label === priorityVal)
  const tagVals = tagsCol && Array.isArray(item.properties[tagsCol.id]) ? (item.properties[tagsCol.id] as string[]) : []
  const desc = item.content || item.description || (typeof item.properties.description === 'string' ? item.properties.description : undefined)
  const assignee = kanbanPersonName(item.properties.assignee)
  const filesCount = item.files?.length ?? 0

  return (
    <div
      data-item-id={item.id}
      className={`group/card relative flex flex-col overflow-hidden rounded-[var(--r-lg)] border bg-[var(--bg-raised)] shadow-[var(--shadow-xs)] transition-[box-shadow,border-color] hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-sm)] ${
        isSelected ? 'border-[var(--accent)] ring-2 ring-[var(--accent-soft)]' : 'border-[var(--border-subtle)]'
      }`}
    >
      <GalleryCover item={item} />
      <div className='flex flex-1 flex-col gap-2 p-3'>
        <GalleryTagsHeader
          isSelected={isSelected}
          tagVals={tagVals}
          tagsCol={tagsCol}
          floatsOverCover={Boolean(kanbanCardCover(item))}
          onToggleSelect={() => onToggleSelect(item.id)}
        />
        <GalleryCardTitleDesc title={item.title} icon={item.icon} desc={desc} onOpenDetail={() => onOpenDetail(item)} />
        <KanbanCardSubtasks
          itemId={item.id}
          subtasks={item.subtasks || []}
          onUpdateSubtasks={onUpdateSubtasks}
        />
        <GalleryFooterMeta
          item={item}
          statusOpt={statusOpt}
          priorityOpt={priorityOpt}
          filesCount={filesCount}
          assignee={assignee || undefined}
        />
      </div>
    </div>
  )
}

export const KanbanGalleryView = memo(function KanbanGalleryView({
  data,
  selectedIds,
  onToggleSelect,
  onOpenDetail,
  onAddItem,
  onUpdateSubtasks,
}: KanbanGalleryViewProps) {
  useLocaleRepaint()
  const { visible, hiddenCount, setTailElement, revealMore } = useKanbanRenderWindow(data.items)
  const statusCol = kanbanStatusColumn(data.columns)
  const priorityCol = kanbanPriorityColumn(data.columns)
  const tagsCol = kanbanTagsColumn(data.columns)

  return (
    <div className='h-full w-full overflow-y-auto p-4'>
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4'>
        {visible.map((item) => (
          <GalleryCard
            key={item.id}
            item={item}
            statusCol={statusCol}
            priorityCol={priorityCol}
            tagsCol={tagsCol}
            isSelected={selectedIds.has(item.id)}
            onToggleSelect={onToggleSelect}
            onOpenDetail={onOpenDetail}
            onUpdateSubtasks={onUpdateSubtasks}
          />
        ))}

        <button
          type='button'
          onClick={onAddItem}
          className='flex min-h-44 flex-col items-center justify-center gap-2 rounded-[var(--r-lg)] border border-dashed border-[var(--border-default)] p-4 text-[var(--text-tertiary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
        >
          <Plus size={20} />
          <span className='text-[length:var(--text-13)] font-medium'>{t('preview.kanban_new_card')}</span>
        </button>
      </div>

      <KanbanRenderTail hiddenCount={hiddenCount} setTailElement={setTailElement} onReveal={revealMore} />
    </div>
  )
})

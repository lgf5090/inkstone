import { Check, MoreVertical, Pin, Plus, Star } from 'lucide-react'
import type { HubAttachmentWithUsage } from '@shared/attachment-hub'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { formatBytes } from '../../lib/time'
import type { MenuItem } from '../../components/overlay'
import {
  AttachmentMenus,
  buildAttachmentMenuItems,
  cardDragStart,
  fileBadgeOf,
  type AttachmentViewProps,
  UploadEmptyState,
  useCardMenu,
  useFileFolder,
} from './attachment-item-common'
import { HUB_BADGE_CLASS, groupAttachmentsByDate } from './attachment-helpers'

type Zoom = 'sm' | 'md' | 'lg'

function zoomCols(zoom: Zoom): string {
  if (zoom === 'sm') return 'grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8'
  if (zoom === 'lg') return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
  return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5'
}

export interface AttachmentGridViewProps extends AttachmentViewProps {
  zoom: Zoom
}

export function AttachmentGridView(props: AttachmentGridViewProps) {
  const { files, zoom, onUploadClick } = props
  const groups = groupAttachmentsByDate(files)
  const gridColsClass = zoomCols(zoom)

  return (
    <div className='flex min-h-full flex-col gap-[var(--sp-6)] p-[var(--sp-4)]'>
      {groups.map((group, groupIdx) => (
        <div key={group.label} className='space-y-[var(--sp-2-5)]'>
          <div className='sticky top-0 z-[var(--z-sticky)] bg-[var(--bg-surface)] py-[var(--sp-1)]'>
            <h3 className='text-[length:var(--text-12)] font-semibold tracking-wider text-[var(--text-tertiary)] uppercase'>
              {group.label}
            </h3>
          </div>

          <div className={cn('grid gap-[var(--sp-3)]', gridColsClass)}>
            {group.files.map((file) => (
              <GridCard
                key={file.id}
                file={file}
                selected={props.selectedIds.has(file.id)}
                active={props.activeFile?.id === file.id}
                onToggleSelect={(e) => props.onToggleSelect(file.id, e)}
                onSelectActive={() => props.onSelectActive(file)}
                onPreview={() => props.onPreview(file)}
                onRename={() => props.onRename(file)}
                onShowQr={() => props.onShowQr(file)}
                onInsertHere={props.onInsertHere ? () => props.onInsertHere?.(file) : undefined}
                onToggleStar={() => props.onToggleStar(file)}
                onTogglePin={() => props.onTogglePin(file)}
                onMoveToFolder={() => props.onMoveToFolder(file)}
                onDelete={() => props.onDelete(file)}
              />
            ))}
            {groupIdx === 0 && onUploadClick && <UploadTile onClick={onUploadClick} />}
          </div>
        </div>
      ))}

      {onUploadClick && files.length < 8 && <UploadEmptyState onUploadClick={onUploadClick} />}
    </div>
  )
}

function UploadTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      type='button'
      onClick={onClick}
      className='group relative flex aspect-[4/3] cursor-pointer flex-col items-center justify-center rounded-[var(--r-lg)] border-2 border-dashed border-[var(--border-subtle)] bg-[var(--bg-sunken)]/20 p-[var(--sp-3)] text-center transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]/20'
    >
      <span className='flex size-[var(--sp-10)] items-center justify-center rounded-[var(--r-xl)] bg-[var(--bg-surface)] text-[var(--text-tertiary)] shadow-[var(--shadow-xs)] transition-transform group-hover:scale-110 group-hover:text-[var(--accent)]'>
        <Plus size={20} />
      </span>
      <span className='mt-[var(--sp-2)] text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] group-hover:text-[var(--accent)]'>
        {t('attachments.upload_file')}
      </span>
    </button>
  )
}

interface GridCardProps {
  file: HubAttachmentWithUsage
  selected: boolean
  active: boolean
  onToggleSelect: (e: React.MouseEvent) => void
  onSelectActive: () => void
  onPreview: () => void
  onRename: () => void
  onShowQr: () => void
  onInsertHere?: () => void
  onToggleStar: () => void
  onTogglePin: () => void
  onMoveToFolder: () => void
  onDelete: () => void
}

function GridCard(props: GridCardProps) {
  const { file, selected, active } = props
  const folder = useFileFolder(file)
  const menu = useCardMenu()
  const { isImage, label } = fileBadgeOf(file)
  const menuItems: MenuItem[] = buildAttachmentMenuItems({
    file,
    onPreview: props.onPreview,
    onRename: props.onRename,
    onShowQr: props.onShowQr,
    onInsertHere: props.onInsertHere,
    onToggleStar: props.onToggleStar,
    onTogglePin: props.onTogglePin,
    onMoveToFolder: props.onMoveToFolder,
    onDelete: props.onDelete,
  })

  return (
    <div
      draggable
      onDragStart={(e) => cardDragStart(e, file.id)}
      onContextMenu={menu.handleContextMenu}
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-[var(--r-lg)] border bg-[var(--bg-base)] text-left transition-all duration-[var(--dur-fast)] select-none',
        selected
          ? 'border-[var(--accent)] ring-2 ring-[var(--accent-ring)]'
          : active
            ? 'border-[var(--accent)] shadow-[var(--shadow-sm)]'
            : 'border-[var(--border-subtle)] hover:border-[var(--border-default)] hover:shadow-[var(--shadow-xs)]',
      )}
    >
      <div className='relative aspect-[4/3] w-full overflow-hidden bg-[var(--bg-sunken)]'>
        {/* The card is a container, so the two gestures it used to carry belong to the thumbnail:
            a click inspects, a double click opens. Both stay reachable from the row menu. */}
        <button
          type='button'
          aria-label={file.filename}
          onClick={props.onSelectActive}
          onDoubleClick={props.onPreview}
          className='block h-full w-full cursor-pointer'
        >
          {isImage
            ? <img src={file.url} alt={file.filename} loading='lazy' className='h-full w-full object-cover transition-transform duration-[var(--dur-base)] group-hover:scale-105' />
            : (
              <span className='flex h-full w-full items-center justify-center p-[var(--sp-4)]'>
                <span className={cn('rounded-[var(--r-lg)] px-[var(--sp-3)] py-[var(--sp-2)] text-[length:var(--text-12)] font-bold tracking-wider', HUB_BADGE_CLASS)}>
                  {label}
                </span>
              </span>
            )}
        </button>

        <SelectBox selected={selected} filename={file.filename} onToggleSelect={props.onToggleSelect} />
        <ThumbActions file={file} menu={menu} onToggleStar={props.onToggleStar} onTogglePin={props.onTogglePin} />

        {file.references === 0 && (
          <span className='absolute bottom-[var(--sp-1-5)] left-[var(--sp-1-5)] rounded-[var(--r-xs)] bg-[var(--warning)] px-[var(--sp-1)] py-[var(--sp-0-5)] text-[length:var(--text-9)] font-medium text-[var(--bg-base)]'>
            {t('attachments.unreferenced')}
          </span>
        )}
      </div>

      <CardMeta file={file} folderName={folder?.name} onSelectActive={props.onSelectActive} onPreview={props.onPreview} />
      <AttachmentMenus menu={menu} items={menuItems} />
    </div>
  )
}

function SelectBox({ selected, filename, onToggleSelect }: {
  selected: boolean
  filename: string
  onToggleSelect: (e: React.MouseEvent) => void
}) {
  return (
    <button
      type='button'
      aria-label={t('attachments.select_file', { value0: filename })}
      aria-pressed={selected}
      onClick={(e) => {
        e.stopPropagation()
        onToggleSelect(e)
      }}
      className={cn(
        'absolute top-[var(--sp-2)] left-[var(--sp-2)] z-[var(--z-sticky)] flex size-5 cursor-pointer items-center justify-center rounded border transition-colors',
        selected
          ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
          : 'border-white/80 bg-black/40 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-black/60',
      )}
    >
      {selected && <Check size={11} strokeWidth={3} />}
    </button>
  )
}

function ThumbActions({ file, menu, onToggleStar, onTogglePin }: {
  file: HubAttachmentWithUsage
  menu: ReturnType<typeof useCardMenu>
  onToggleStar: () => void
  onTogglePin: () => void
}) {
  return (
    <div className='absolute top-[var(--sp-2)] right-[var(--sp-2)] z-[var(--z-sticky)] flex items-center gap-[var(--sp-1)]'>
      {file.isPinned && (
        <button
          type='button'
          aria-label={t('attachments.unpin')}
          onClick={(e) => {
            e.stopPropagation()
            onTogglePin()
          }}
          className='flex size-5 cursor-pointer items-center justify-center rounded-full bg-[var(--scrim)] text-[var(--text-inverse)]'
        >
          <Pin size={10} className='fill-current' />
        </button>
      )}
      <button
        type='button'
        aria-label={t(file.isStarred ? 'attachments.unstar' : 'attachments.star')}
        aria-pressed={file.isStarred}
        onClick={(e) => {
          e.stopPropagation()
          onToggleStar()
        }}
        className={cn(
          'flex size-5 cursor-pointer items-center justify-center rounded-full transition-opacity',
          file.isStarred ? 'bg-[var(--warning)] text-[var(--bg-base)]' : 'bg-black/50 text-white/70 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-white',
        )}
      >
        <Star size={10} className={file.isStarred ? 'fill-current' : undefined} />
      </button>
      <button
        ref={menu.buttonRef}
        type='button'
        aria-label={t('common.more_actions')}
        onClick={(e) => {
          e.stopPropagation()
          menu.toggle()
        }}
        className='flex size-5 cursor-pointer items-center justify-center rounded-full bg-black/50 text-white/80 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-white'
      >
        <MoreVertical size={11} />
      </button>
    </div>
  )
}

function CardMeta({ file, folderName, onSelectActive, onPreview }: {
  file: HubAttachmentWithUsage
  folderName?: string
  onSelectActive: () => void
  onPreview: () => void
}) {
  return (
    <div className='space-y-[var(--sp-1)] p-[var(--sp-2)]'>
      <button
        type='button'
        title={file.filename}
        onClick={onSelectActive}
        onDoubleClick={onPreview}
        className='block w-full cursor-pointer truncate text-left text-[length:var(--text-12)] font-medium text-[var(--text-primary)]'
      >
        {file.filename}
      </button>

      <div className='flex items-center justify-between text-[length:var(--text-11)] text-[var(--text-tertiary)]'>
        <span className='tabular'>{formatBytes(file.size)}</span>
        {folderName && (
          <span className='max-w-20 truncate' title={folderName}>
            {folderName}
          </span>
        )}
      </div>

      {file.tags.length > 0 && (
        <div className='flex flex-wrap gap-[var(--sp-1)] pt-[var(--sp-0-5)]'>
          {file.tags.slice(0, 2).map((tag) => (
            <span key={tag} className='rounded-[var(--r-xs)] bg-[var(--bg-sunken)] px-[var(--sp-1)] py-[var(--sp-0-5)] text-[length:var(--text-10)] text-[var(--text-tertiary)]'>
              #{tag}
            </span>
          ))}
          {file.tags.length > 2 && (
            <span className='text-[length:var(--text-10)] text-[var(--text-quaternary)]'>
              +{file.tags.length - 2}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

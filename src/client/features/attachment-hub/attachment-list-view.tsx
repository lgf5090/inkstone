import { Check, MoreHorizontal, Pin, Star } from 'lucide-react'
import type { HubAttachmentWithUsage } from '@shared/attachment-hub'
import { cn } from '../../lib/cn'
import { t, localeTag } from '../../lib/i18n'
import { formatBytes } from '../../lib/time'
import type { MenuItem } from '../../components/overlay'
import { Badge } from '../../components/primitives'
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
import { HUB_BADGE_CLASS } from './attachment-helpers'

export interface AttachmentListViewProps extends AttachmentViewProps {
  onToggleSelectAll: () => void
  allSelected: boolean
}

export function AttachmentListView(props: AttachmentListViewProps) {
  const { files, selectedIds, activeFile, onUploadClick, allSelected } = props

  return (
    <div className='flex min-h-full w-full flex-col'>
      <div className='overflow-x-auto'>
        <table className='w-full border-collapse text-left text-[length:var(--text-12)]'>
          <TableHead onToggleSelectAll={props.onToggleSelectAll} allSelected={allSelected} />
          <tbody className='divide-y divide-[var(--border-subtle)]'>
            {files.map((file) => (
              <ListRow
                key={file.id}
                file={file}
                selected={selectedIds.has(file.id)}
                active={activeFile?.id === file.id}
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
          </tbody>
        </table>
      </div>

      {onUploadClick && files.length < 8 && (
        <div className='flex flex-1 p-[var(--sp-4)]'>
          <UploadEmptyState onUploadClick={onUploadClick} />
        </div>
      )}
    </div>
  )
}

function TableHead({ onToggleSelectAll, allSelected }: { onToggleSelectAll: () => void; allSelected: boolean }) {
  const columns = [
    t('attachments.filename'),
    t('navigation.folder'),
    t('navigation.tag'),
    t('attachments.size_column'),
    t('attachments.reference_column'),
    t('common.created'),
    t('common.more_actions'),
  ]
  return (
    <thead className='sticky top-0 z-[var(--z-sticky)] border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] text-[length:var(--text-11)] font-semibold text-[var(--text-tertiary)] uppercase select-none'>
      <tr>
        <th className='w-10 px-[var(--sp-3)] py-[var(--sp-2-5)]'>
          <button
            type='button'
            aria-label={t('attachments.select_all')}
            aria-pressed={allSelected}
            onClick={onToggleSelectAll}
            className={cn(
              'flex size-4 cursor-pointer items-center justify-center rounded border transition-colors',
              allSelected ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--border-default)] bg-[var(--bg-base)]',
            )}
          >
            {allSelected && <Check size={11} strokeWidth={3} />}
          </button>
        </th>
        {columns.map((label, index) => (
          <th key={label} className={cn('px-[var(--sp-3)] py-[var(--sp-2-5)]', index === columns.length - 1 && 'text-right')}>
            {label}
          </th>
        ))}
      </tr>
    </thead>
  )
}

interface ListRowProps {
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

function ListRow(props: ListRowProps) {
  const { file, selected, active } = props
  const folder = useFileFolder(file)
  const menu = useCardMenu()
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
    <tr
      draggable
      onDragStart={(e) => cardDragStart(e, file.id)}
      onContextMenu={menu.handleContextMenu}
      className={cn(
        'group transition-colors select-none',
        selected ? 'bg-[var(--accent-soft)]' : active ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]',
      )}
    >
      <td className='w-10 px-[var(--sp-3)] py-[var(--sp-2)]'>
        <button
          type='button'
          aria-label={t('attachments.select_file', { value0: file.filename })}
          aria-pressed={selected}
          onClick={(e) => {
            e.stopPropagation()
            props.onToggleSelect(e)
          }}
          className={cn(
            'flex size-4 cursor-pointer items-center justify-center rounded border transition-colors',
            selected
              ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
              : 'border-[var(--border-default)] bg-[var(--bg-base)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          )}
        >
          {selected && <Check size={11} strokeWidth={3} />}
        </button>
      </td>
      <NameCell
        file={file}
        onSelectActive={props.onSelectActive}
        onPreview={props.onPreview}
      />
      <td className='px-[var(--sp-3)] py-[var(--sp-2)] text-[var(--text-tertiary)]'>
        {folder ? <span className='block max-w-30 truncate'>{folder.name}</span> : <span>-</span>}
      </td>
      <td className='px-[var(--sp-3)] py-[var(--sp-2)] text-[var(--text-tertiary)]'>
        {file.tags.length > 0 ? (
          <span className='flex flex-wrap gap-[var(--sp-1)]'>
            {file.tags.slice(0, 2).map((tag) => (
              <span key={tag} className='rounded-[var(--r-xs)] bg-[var(--bg-sunken)] px-[var(--sp-1)] text-[length:var(--text-10)]'>
                #{tag}
              </span>
            ))}
          </span>
        ) : <span>-</span>}
      </td>
      <td className='px-[var(--sp-3)] py-[var(--sp-2)] tabular text-[var(--text-tertiary)]'>{formatBytes(file.size)}</td>
      <td className='px-[var(--sp-3)] py-[var(--sp-2)]'>
        {file.references === 0
          ? <Badge tone='warning'>{t('attachments.unreferenced')}</Badge>
          : <span className='tabular text-[var(--text-tertiary)]'>{t('attachments.referenced_value0', { value0: file.references })}</span>}
      </td>
      <td className='px-[var(--sp-3)] py-[var(--sp-2)] text-[var(--text-tertiary)]'>
        {new Date(file.createdAt).toLocaleDateString(localeTag())}
      </td>
      <td className='px-[var(--sp-3)] py-[var(--sp-2)] text-right'>
        <button
          ref={menu.buttonRef}
          type='button'
          aria-label={t('common.more_actions')}
          onClick={(e) => {
            e.stopPropagation()
            menu.toggle()
          }}
          className='cursor-pointer rounded p-1 text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-sunken)] hover:text-[var(--text-primary)]'
        >
          <MoreHorizontal size={14} />
        </button>
        <AttachmentMenus menu={menu} items={menuItems} />
      </td>
    </tr>
  )
}

function NameCell({ file, onSelectActive, onPreview }: {
  file: HubAttachmentWithUsage
  onSelectActive: () => void
  onPreview: () => void
}) {
  const { isImage, label } = fileBadgeOf(file)
  return (
    <td className='px-[var(--sp-3)] py-[var(--sp-2)]'>
      <span className='flex items-center gap-[var(--sp-2-5)]'>
        <span className='flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)]'>
          {isImage
            ? <img src={file.url} alt='' className='h-full w-full object-cover' />
            : <span className={cn('text-[length:var(--text-9)] font-bold', HUB_BADGE_CLASS)}>{label}</span>}
        </span>
        <button
          type='button'
          title={file.filename}
          onClick={onSelectActive}
          onDoubleClick={onPreview}
          className='max-w-xs cursor-pointer truncate font-medium text-[var(--text-primary)] md:max-w-md'
        >
          {file.filename}
        </button>
        {file.isPinned && <Pin size={11} className='shrink-0 text-[var(--accent)]' />}
        {file.isStarred && <Star size={11} className='shrink-0 fill-current text-[var(--warning)]' />}
      </span>
    </td>
  )
}

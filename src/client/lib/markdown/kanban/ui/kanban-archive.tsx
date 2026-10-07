import { useCallback, useId, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Archive, Trash2, Undo2 } from 'lucide-react'
import { Button } from '../../../../components/primitives'
import { confirm } from '../../../../components/overlay'
import { useUi } from '../../../../store/ui'
import { t, useLocaleRepaint } from '../../../i18n'
import {
  kanbanArchivedItems,
  kanbanDeletedItems,
  kanbanPurgeDeleted,
  kanbanSetArchived,
  kanbanSetDeleted,
} from '../archive'
import type { KanbanData, KanbanItem } from '../types'
import type { CommitKanbanData } from './kanban-history'
import { KanbanPanel } from './kanban-panel'

export interface KanbanArchiveEntry {
  /** The cards filed away, oldest flag first: out of every view, one restore away. */
  items: KanbanItem[]
  /** The cards the reader deleted: still in the document, listed for restore or purge. */
  deletedItems: KanbanItem[]
  onRestore: (ids: Iterable<string>) => void
  /** Filing an archived card further away: the flag that puts it in the deleted list. */
  onDelete: (id: string) => void
  onRestoreDeleted: (ids: Iterable<string>) => void
  onPurge: (ids: Iterable<string>) => void
}

/**
 * The one writer of the archive flag. A batch that changes nothing hands the history back the very
 * same document, so filing away a card that was already filed away costs no step of undo.
 */
function useKanbanArchiveWriter(commitData: CommitKanbanData) {
  return useCallback(
    (ids: Iterable<string>, archived: boolean) => {
      const wanted = new Set(ids)
      if (wanted.size === 0) return
      commitData((prev) => {
        const items = kanbanSetArchived(prev.items, wanted, archived)
        return items === prev.items ? prev : { ...prev, items }
      })
    },
    [commitData],
  )
}

export function useKanbanArchive(
  data: KanbanData,
  commitData: CommitKanbanData,
  detailItem: KanbanItem | null,
  setDetailItem: (item: KanbanItem | null) => void,
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>,
  onDelete: (id: string) => void,
) {
  const write = useKanbanArchiveWriter(commitData)
  const items = useMemo(() => kanbanArchivedItems(data.items), [data.items])
  const deletedItems = useMemo(() => kanbanDeletedItems(data.items), [data.items])
  const onRestore = useCallback((ids: Iterable<string>) => write(ids, false), [write])

  const handleArchiveItems = useCallback(
    (ids: Iterable<string>) => {
      const wanted = [...new Set(ids)]
      if (wanted.length === 0) return
      write(wanted, true)
      if (detailItem && wanted.includes(detailItem.id)) setDetailItem(null)
      setSelectedIds((prev) => {
        const next = new Set([...prev].filter((id) => !wanted.includes(id)))
        return next.size === prev.size ? prev : next
      })
      useUi.getState().toast({ title: t('preview.kanban_archive_toast', { count: wanted.length }) })
    },
    [write, detailItem, setDetailItem, setSelectedIds],
  )

  // The deleted list's own doors. Restoring is the same shape as restoring from the archive; the
  // purge is the one irreversible write the panel offers, so the panel asks before it runs it.
  const onRestoreDeleted = useCallback(
    (ids: Iterable<string>) => {
      const wanted = new Set(ids)
      if (wanted.size === 0) return
      commitData((prev) => {
        const items = kanbanSetDeleted(prev.items, wanted, false)
        return items === prev.items ? prev : { ...prev, items }
      })
    },
    [commitData],
  )
  const onPurge = useCallback(
    (ids: Iterable<string>) => {
      const wanted = new Set(ids)
      if (wanted.size === 0) return
      commitData((prev) => {
        const items = kanbanPurgeDeleted(prev.items, wanted)
        return items === prev.items ? prev : { ...prev, items }
      })
    },
    [commitData],
  )

  const archive = useMemo<KanbanArchiveEntry>(
    () => ({ items, deletedItems, onRestore, onDelete, onRestoreDeleted, onPurge }),
    [items, deletedItems, onRestore, onDelete, onRestoreDeleted, onPurge],
  )

  return { archive, handleArchiveItems, handleRestoreItems: onRestore }
}

function ArchiveRow({
  item,
  onRestore,
  onDelete,
}: {
  item: KanbanItem
  onRestore: () => void
  onDelete: () => void
}) {
  return (
    <li className='flex items-center gap-1'>
      <span className='min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]'>
        {item.title}
      </span>
      <button
        type='button'
        data-kanban-archive-restore
        onClick={onRestore}
        aria-label={t('preview.kanban_archive_restore_named', { title: item.title })}
        className='inline-flex items-center gap-1 rounded-[var(--r-xs)] px-1.5 py-1 text-[length:var(--text-11)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
      >
        <Undo2 size={12} aria-hidden />
        <span>{t('preview.kanban_archive_restore')}</span>
      </button>
      <button
        type='button'
        data-kanban-archive-delete
        onClick={onDelete}
        aria-label={t('preview.kanban_archive_delete_named', { title: item.title })}
        className='rounded-[var(--r-xs)] p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--danger)]'
      >
        <Trash2 size={12} aria-hidden />
      </button>
    </li>
  )
}

/** The deleted row's second control: what it says is what it does, so it carries its own label. */
function DeletedRow({
  item,
  onRestore,
  onPurge,
}: {
  item: KanbanItem
  onRestore: () => void
  onPurge: () => void
}) {
  return (
    <li className='flex items-center gap-1'>
      <span className='min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-tertiary)]'>
        {item.title}
      </span>
      <button
        type='button'
        data-kanban-archive-restore
        onClick={onRestore}
        aria-label={t('preview.kanban_archive_restore_named', { title: item.title })}
        className='inline-flex items-center gap-1 rounded-[var(--r-xs)] px-1.5 py-1 text-[length:var(--text-11)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
      >
        <Undo2 size={12} aria-hidden />
        <span>{t('preview.kanban_archive_restore')}</span>
      </button>
      <button
        type='button'
        data-kanban-archive-purge
        onClick={onPurge}
        aria-label={t('preview.kanban_purge_named', { title: item.title })}
        className='rounded-[var(--r-xs)] p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--danger)]'
      >
        <Trash2 size={12} aria-hidden />
      </button>
    </li>
  )
}

interface KanbanArchivePanelProps extends KanbanArchiveEntry {
  open: boolean
  panelId: string
  anchorRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
}

/** The ask the purge owes the reader, once per press rather than once per row. */
async function confirmPurge(count: number): Promise<boolean> {
  return confirm({
    title: t('preview.kanban_purge_confirm_title', { count }),
    description: t('preview.kanban_purge_confirm_body'),
    confirmLabel: t('preview.kanban_purge'),
    cancelLabel: t('common.cancel'),
    tone: 'danger',
  })
}

/**
 * The shelf itself, in two sections: the cards filed away and the cards deleted, each with its own
 * way back. Exported for the compact header's own menu, which reaches the archive through a row
 * rather than a button of its own: the one way back to a filed-away card has to survive the layout
 * that has no room for the trigger.
 */
export function KanbanArchivePanel({
  items,
  deletedItems,
  open,
  panelId,
  anchorRef,
  onClose,
  onRestore,
  onDelete,
  onRestoreDeleted,
  onPurge,
}: KanbanArchivePanelProps) {
  const purgeRows = async (ids: string[]) => {
    if (!(await confirmPurge(ids.length))) return
    onPurge(ids)
  }
  return (
    <KanbanPanel
      open={open}
      panelId={panelId}
      label={t('preview.kanban_archive_panel')}
      anchorRef={anchorRef}
      onClose={onClose}
      // The board reads a press anywhere as "stop what you were doing"; a press that meant one of
      // these rows is the panel's, not the board's.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className='z-[var(--z-popover)] flex w-64 flex-col gap-1.5 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2 shadow-[var(--shadow-pop)]'
    >
      {items.length > 0 && (
        <>
          <div className='flex items-center justify-between'>
            <span className='text-[length:var(--text-11)] font-semibold text-[var(--text-tertiary)]'>
              {t('preview.kanban_archived_section', { count: items.length })}
            </span>
            <button
              type='button'
              data-kanban-archive-restore-all
              onClick={() => onRestore(items.map((item) => item.id))}
              className='rounded-[var(--r-xs)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--accent)] hover:bg-[var(--bg-hover)]'
            >
              {t('preview.kanban_archive_restore_all')}
            </button>
          </div>
          <ul className='flex max-h-40 flex-col gap-0.5 overflow-y-auto' data-kanban-archive-list>
            {items.map((item) => (
              <ArchiveRow
                key={item.id}
                item={item}
                onRestore={() => onRestore([item.id])}
                onDelete={() => onDelete(item.id)}
              />
            ))}
          </ul>
        </>
      )}
      {deletedItems.length > 0 && (
        <>
          <div className='flex items-center justify-between'>
            <span className='text-[length:var(--text-11)] font-semibold text-[var(--text-tertiary)]'>
              {t('preview.kanban_deleted_section', { count: deletedItems.length })}
            </span>
            <button
              type='button'
              data-kanban-archive-purge-all
              onClick={() => void purgeRows(deletedItems.map((item) => item.id))}
              className='rounded-[var(--r-xs)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--danger)] hover:bg-[var(--bg-hover)]'
            >
              {t('preview.kanban_purge_all')}
            </button>
          </div>
          <ul className='flex max-h-40 flex-col gap-0.5 overflow-y-auto' data-kanban-deleted-list>
            {deletedItems.map((item) => (
              <DeletedRow
                key={item.id}
                item={item}
                onRestore={() => onRestoreDeleted([item.id])}
                onPurge={() => void purgeRows([item.id])}
              />
            ))}
          </ul>
        </>
      )}
    </KanbanPanel>
  )
}

/**
 * The only way back to a card that is not on the board. With nothing filed away or deleted the
 * control is absent rather than a button that opens an empty list — and because it is absent,
 * restoring or purging the last entry closes the shelf by itself: no second path has to remember to
 * shut the panel.
 */
export function KanbanArchiveAction(entry: KanbanArchiveEntry) {
  useLocaleRepaint()
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const count = entry.items.length
  const deletedCount = entry.deletedItems.length

  if (count + deletedCount === 0) return null

  return (
    <>
      <Button
        ref={btnRef}
        size='sm'
        variant='ghost'
        data-kanban-archive
        icon={<Archive size={13} aria-hidden />}
        onClick={() => setOpen((o) => !o)}
        className={open ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : undefined}
        aria-label={
          count > 0
            ? t('preview.kanban_archived_count', { count })
            : t('preview.kanban_deleted_count', { count: deletedCount })
        }
        aria-haspopup='dialog'
        aria-expanded={open}
        {...(open ? { 'aria-controls': panelId } : {})}
      >
        {count > 0 ? count : deletedCount}
      </Button>
      <KanbanArchivePanel
        {...entry}
        open={open}
        panelId={panelId}
        anchorRef={btnRef}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

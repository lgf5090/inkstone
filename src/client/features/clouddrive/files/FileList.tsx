import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import type { CloudDriveEntry, CloudDriveSortDirection, CloudDriveSortKey } from '@shared/clouddrive/model'
import { parentPathOf } from '@shared/clouddrive/model'
import type { MessageKey } from '@shared/locales/en-US'
import { t } from '../../../lib/i18n'
import { FileIcon } from './FileIcon'
import { TagList } from './ColorTagMenus'
import { entryKindLabel, formatEntryDate, formatEntrySize } from './format'
import { selectModeFor, type FileViewProps } from './types'

export interface FileListProps extends FileViewProps {
  /** The column the server sorted by; `null` when the order is not a column's (a ranked search). */
  sortKey: CloudDriveSortKey | null
  sortDir: CloudDriveSortDirection
  /** Absent when the list cannot be re-sorted: the headers then stay plain text. */
  onSort?: (key: CloudDriveSortKey) => void
  /** Drive-wide search results live in different folders, so the folder has to be visible. */
  showPath?: boolean
}

export function FileList({
  entries,
  selected,
  focusedId,
  showCheckboxes,
  readOnly,
  onFocusEntry,
  onSelect,
  onOpen,
  onPreview,
  onSelectAll,
  onClearSelection,
  onContextMenu,
  onKeyCommand,
  onDragStartEntry,
  onDragOverTarget,
  onDropTarget,
  sortKey,
  sortDir,
  onSort,
  showPath = false,
}: FileListProps) {
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>())
  const [dropId, setDropId] = useState<string | null>(null)
  const selectAllRef = useRef<HTMLInputElement>(null)
  const selectedCount = entries.reduce((count, entry) => count + (selected.has(entry.id) ? 1 : 0), 0)
  const allSelected = entries.length > 0 && selectedCount === entries.length

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectedCount > 0 && !allSelected
  }, [selectedCount, allSelected])

  const focusAt = (index: number, event: ReactKeyboardEvent<HTMLElement>) => {
    const next = entries[index]
    if (!next) return false
    event.preventDefault()
    rowRefs.current.get(next.id)?.focus()
    onFocusEntry(next.id)
    return true
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTableRowElement>, entry: CloudDriveEntry, index: number) => {
    const target = event.target as HTMLElement
    if (event.key === ' ' && !(target instanceof HTMLInputElement)) {
      event.preventDefault()
      onPreview(entry)
      return
    }
    if (onKeyCommand(event, entry)) return
    if (event.key === 'ArrowDown') focusAt(index + 1, event)
    else if (event.key === 'ArrowUp') focusAt(index - 1, event)
    else if (event.key === 'Home') focusAt(0, event)
    else if (event.key === 'End') focusAt(entries.length - 1, event)
  }

  const handleClick = (event: ReactMouseEvent<HTMLTableRowElement>, entry: CloudDriveEntry) => {
    const target = event.target as HTMLElement
    if (target.closest('input[type="checkbox"]')) return
    event.currentTarget.focus({ preventScroll: true })
    onSelect(entry, selectModeFor(event))
  }

  const header = (key: CloudDriveSortKey, className?: string) => {
    const label = t(`clouddrive.sort.${key}` as MessageKey)
    return (
      <th scope="col" aria-sort={sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} className={className}>
        {onSort ? (
          <button type="button" className="cd-list-sort" onClick={() => onSort(key)}>
            <span>{label}</span>
            {sortKey === key && (sortDir === 'asc' ? <ArrowUp size={11} aria-hidden /> : <ArrowDown size={11} aria-hidden />)}
          </button>
        ) : (
          label
        )}
      </th>
    )
  }

  return (
    <table className="cd-list" aria-label={t('clouddrive.nav.files')}>
      <thead>
        <tr>
          <th scope="col" className="w-9">
            {showCheckboxes && (
              <input
                ref={selectAllRef}
                type="checkbox"
                className="cd-checkbox"
                checked={allSelected}
                aria-label={t('clouddrive.action.select_all')}
                onChange={() => (allSelected ? onClearSelection() : onSelectAll())}
              />
            )}
          </th>
          {header('name')}
          {header('size', 'w-[88px]')}
          {header('modified', 'cd-col-modified w-[148px]')}
          {showPath && <th scope="col" className="cd-col-location w-[200px]">{t('clouddrive.search.location')}</th>}
          {header('type', 'cd-col-kind w-[110px]')}
          <th scope="col" className="cd-col-tags w-[160px]">{t('clouddrive.action.tags')}</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry, index) => {
          const isSelected = selected.has(entry.id)
          const tabIndex = focusedId ? (focusedId === entry.id ? 0 : -1) : index === 0 ? 0 : -1
          return (
            <tr
              key={entry.id}
              ref={(node) => {
                if (node) rowRefs.current.set(entry.id, node)
                else rowRefs.current.delete(entry.id)
              }}
              tabIndex={tabIndex}
              aria-selected={isSelected}
              data-cd-entry={entry.id}
              draggable={!readOnly && Boolean(onDragStartEntry)}
              className={`cd-list-row${dropId === entry.id ? ' cd-drop-target' : ''}`}
              onClick={(event) => handleClick(event, entry)}
              onDoubleClick={(event) => {
                if ((event.target as HTMLElement).closest('input')) return
                onOpen(entry)
              }}
              onContextMenu={(event) => onContextMenu(entry, event)}
              onKeyDown={(event) => handleKeyDown(event, entry, index)}
              onDragStart={(event) => onDragStartEntry?.(entry, event)}
              onDragEnd={() => setDropId(null)}
              onDragOver={entry.kind === 'folder' && onDragOverTarget
                ? (event) => setDropId(onDragOverTarget(entry, event) ? entry.id : null)
                : undefined}
              onDragLeave={entry.kind === 'folder' && onDragOverTarget
                ? () => setDropId((current) => (current === entry.id ? null : current))
                : undefined}
              onDrop={entry.kind === 'folder' && onDropTarget
                ? (event) => {
                  setDropId(null)
                  onDropTarget(entry, event)
                }
                : undefined}
              onFocus={(event) => {
                if (event.target === event.currentTarget) onFocusEntry(entry.id)
              }}
            >
              <td>
                {showCheckboxes && (
                  <input
                    type="checkbox"
                    className="cd-checkbox"
                    checked={isSelected}
                    aria-label={entry.name}
                    onClick={(event) => event.stopPropagation()}
                    onChange={() => onSelect(entry, 'toggle')}
                  />
                )}
              </td>
              <td>
                <span className="flex min-w-0 items-center gap-2">
                  <FileIcon entry={entry} size={18} />
                  <span className="truncate text-[var(--text-primary)]">{entry.name}</span>
                </span>
              </td>
              <td className="tabular-nums">{formatEntrySize(entry)}</td>
              <td className="cd-col-modified tabular-nums">{formatEntryDate(entry.modifiedAt)}</td>
              {showPath && (
                <td className="cd-col-location" title={parentPathOf(entry.path)}>{parentPathOf(entry.path)}</td>
              )}
              <td className="cd-col-kind">{entryKindLabel(entry)}</td>
              <td className="cd-col-tags">
                <TagList tags={entry.tags} max={2} />
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

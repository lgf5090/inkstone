import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import { t } from '../../../lib/i18n'
import { FileIcon } from './FileIcon'
import { TagList } from './ColorTagMenus'
import { entryKindLabel, formatEntryDate, formatEntrySize } from './format'
import { selectModeFor, type FileViewProps } from './types'

export function FileList({
  entries,
  selected,
  focusedId,
  showCheckboxes,
  onFocusEntry,
  onSelect,
  onOpen,
  onPreview,
  onSelectAll,
  onClearSelection,
  onContextMenu,
  onKeyCommand,
}: FileViewProps) {
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>())
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
          <th scope="col">{t('clouddrive.sort.name')}</th>
          <th scope="col" className="w-[88px]">{t('clouddrive.sort.size')}</th>
          <th scope="col" className="cd-col-modified w-[148px]">{t('clouddrive.sort.modified')}</th>
          <th scope="col" className="cd-col-kind w-[110px]">{t('clouddrive.sort.type')}</th>
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
              className="cd-list-row"
              onClick={(event) => handleClick(event, entry)}
              onDoubleClick={(event) => {
                if ((event.target as HTMLElement).closest('input')) return
                onOpen(entry)
              }}
              onContextMenu={(event) => onContextMenu(entry, event)}
              onKeyDown={(event) => handleKeyDown(event, entry, index)}
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

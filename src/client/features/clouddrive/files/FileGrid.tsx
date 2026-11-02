import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import { FileIcon } from './FileIcon'
import { TagDots } from './ColorTagMenus'
import { splitExtension } from './format'
import { selectModeFor, type FileViewProps } from './types'

export function FileGrid({
  entries,
  selected,
  focusedId,
  showCheckboxes,
  readOnly,
  onFocusEntry,
  onSelect,
  onOpen,
  onPreview,
  onContextMenu,
  onKeyCommand,
  onDragStartEntry,
  onDragOverTarget,
  onDropTarget,
}: FileViewProps) {
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())
  const [dropId, setDropId] = useState<string | null>(null)

  const focusAt = (index: number, event: ReactKeyboardEvent<HTMLElement>) => {
    const next = entries[index]
    if (!next) return
    event.preventDefault()
    itemRefs.current.get(next.id)?.focus()
    onFocusEntry(next.id)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, entry: CloudDriveEntry, index: number) => {
    if (event.key === ' ') {
      event.preventDefault()
      onPreview(entry)
      return
    }
    if (onKeyCommand(event, entry)) return
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') focusAt(index + 1, event)
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') focusAt(index - 1, event)
    else if (event.key === 'Home') focusAt(0, event)
    else if (event.key === 'End') focusAt(entries.length - 1, event)
  }

  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>, entry: CloudDriveEntry) => {
    event.currentTarget.focus({ preventScroll: true })
    onSelect(entry, selectModeFor(event))
  }

  return (
    <ul role="list" className="cd-grid m-0 list-none p-2">
      {entries.map((entry, index) => {
        const isSelected = selected.has(entry.id)
        const tabIndex = focusedId ? (focusedId === entry.id ? 0 : -1) : index === 0 ? 0 : -1
        const [nameBase, nameExtension] = splitExtension(entry.name)
        return (
          <li key={entry.id} className="relative min-w-0">
            {showCheckboxes && (
              <input
                type="checkbox"
                className="cd-checkbox cd-grid-check"
                checked={isSelected}
                aria-label={entry.name}
                onClick={(event) => event.stopPropagation()}
                onChange={() => onSelect(entry, 'toggle')}
              />
            )}
            <button
              ref={(node) => {
                if (node) itemRefs.current.set(entry.id, node)
                else itemRefs.current.delete(entry.id)
              }}
              type="button"
              tabIndex={tabIndex}
              aria-pressed={isSelected}
              data-cd-entry={entry.id}
              draggable={!readOnly && Boolean(onDragStartEntry)}
              className={`cd-grid-item w-full${dropId === entry.id ? ' cd-drop-target' : ''}`}
              onClick={(event) => handleClick(event, entry)}
              onDoubleClick={() => onOpen(entry)}
              onContextMenu={(event) => onContextMenu(entry, event)}
              onKeyDown={(event) => handleKeyDown(event, entry, index)}
              onFocus={() => onFocusEntry(entry.id)}
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
            >
              <FileIcon entry={entry} fluid />
              <span className="cd-grid-name">{nameBase}{nameExtension && <span className="cd-name-ext">{nameExtension}</span>}</span>
              {entry.tags.length > 0 && <TagDots tags={entry.tags} max={4} />}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

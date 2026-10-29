import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import { clouddriveApi } from '../api'
import { FileIcon } from './FileIcon'
import { selectModeFor, type FileViewProps } from './types'

function canShowThumbnail(entry: CloudDriveEntry): boolean {
  return entry.kind === 'file' && entry.hasThumbnail
}

export function FileGallery({
  entries,
  selected,
  focusedId,
  showCheckboxes,
  onFocusEntry,
  onSelect,
  onOpen,
  onPreview,
  onContextMenu,
  onKeyCommand,
}: FileViewProps) {
  const thumbRefs = useRef(new Map<string, HTMLButtonElement>())
  const active = entries.find((entry) => entry.id === focusedId) ?? entries[0]
  if (!active) return null
  const activeIndex = entries.findIndex((entry) => entry.id === active.id)

  const focusThumb = (index: number, event: ReactKeyboardEvent<HTMLElement>) => {
    const next = entries[index]
    if (!next) return
    event.preventDefault()
    onFocusEntry(next.id)
    thumbRefs.current.get(next.id)?.focus()
  }

  const stageKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === ' ') {
      event.preventDefault()
      onPreview(active)
      return
    }
    if (onKeyCommand(event, active)) return
    if (event.key === 'ArrowRight') focusThumb(activeIndex + 1, event)
    else if (event.key === 'ArrowLeft') focusThumb(activeIndex - 1, event)
    else if (event.key === 'Home') focusThumb(0, event)
    else if (event.key === 'End') focusThumb(entries.length - 1, event)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="cd-gallery-stage">
        <button
          type="button"
          aria-pressed={selected.has(active.id)}
          className="cd-gallery-open"
          onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true })
            onSelect(active, selectModeFor(event))
          }}
          onDoubleClick={() => onOpen(active)}
          onContextMenu={(event) => onContextMenu(active, event)}
          onKeyDown={stageKeyDown}
          onFocus={() => onFocusEntry(active.id)}
        >
          {canShowThumbnail(active)
            ? <img className="cd-gallery-image" src={clouddriveApi.thumbnailUrl(active.id, 1280)} alt={active.name} />
            : <FileIcon entry={active} size={96} />}
          <span className="max-w-full truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{active.name}</span>
        </button>
      </div>
      <ul role="list" className="cd-gallery-strip m-0 list-none">
        {entries.map((entry, index) => {
          const isSelected = selected.has(entry.id)
          const tabIndex = focusedId === entry.id ? 0 : focusedId ? -1 : index === 0 ? 0 : -1
          return (
            <li key={entry.id} className="relative shrink-0">
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
                  if (node) thumbRefs.current.set(entry.id, node)
                  else thumbRefs.current.delete(entry.id)
                }}
                type="button"
                tabIndex={tabIndex}
                aria-pressed={isSelected}
                className="cd-gallery-thumb"
                onClick={(event) => {
                  event.currentTarget.focus({ preventScroll: true })
                  onSelect(entry, selectModeFor(event))
                }}
                onDoubleClick={() => onOpen(entry)}
                onContextMenu={(event) => onContextMenu(entry, event)}
                onKeyDown={(event) => {
                  if (event.key === ' ') {
                    event.preventDefault()
                    onPreview(entry)
                    return
                  }
                  if (onKeyCommand(event, entry)) return
                  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') focusThumb(index + 1, event)
                  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') focusThumb(index - 1, event)
                }}
                onFocus={() => onFocusEntry(entry.id)}
              >
                {canShowThumbnail(entry)
                  ? <img src={clouddriveApi.thumbnailUrl(entry.id, 160)} alt="" loading="lazy" />
                  : <FileIcon entry={entry} size={24} />}
                <span className="w-full truncate text-[length:var(--text-10)] text-[var(--text-tertiary)]">{entry.name}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

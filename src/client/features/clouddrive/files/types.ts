import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { CloudDriveEntry } from '@shared/clouddrive/model'

/** How a click changes the selection: plain click, Ctrl/Cmd toggle, Shift range. */
export type SelectMode = 'single' | 'toggle' | 'range'

export interface FileClipboard {
  mode: 'copy' | 'cut'
  mountId: string
  sourcePath: string
  ids: string[]
}

export function selectModeFor(event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): SelectMode {
  if (event.shiftKey) return 'range'
  if (event.metaKey || event.ctrlKey) return 'toggle'
  return 'single'
}

/**
 * The contract every file layout shares. The page owns selection, dialogs and the context
 * menu; a layout owns only the markup and the arrow-key movement inside its own list.
 */
export interface FileViewProps {
  entries: CloudDriveEntry[]
  selected: ReadonlySet<string>
  focusedId: string | null
  showCheckboxes: boolean
  readOnly: boolean
  onFocusEntry: (id: string) => void
  onSelect: (entry: CloudDriveEntry, mode: SelectMode) => void
  onOpen: (entry: CloudDriveEntry) => void
  onPreview: (entry: CloudDriveEntry) => void
  onSelectAll: () => void
  onClearSelection: () => void
  onContextMenu: (entry: CloudDriveEntry, event: ReactMouseEvent<HTMLElement>) => void
  /**
   * Pointer drag. A row is always a source and a folder is always a target, but the page decides:
   * it holds the payload in flight, refuses a folder that is the row itself or one of its descendants
   * and runs the same move the context menu runs. Absent means the surface cannot move anything.
   */
  onDragStartEntry?: (entry: CloudDriveEntry, event: ReactDragEvent<HTMLElement>) => void
  /** True when this folder accepts what is in flight; the layout lights the row on that answer. */
  onDragOverTarget?: (entry: CloudDriveEntry, event: ReactDragEvent<HTMLElement>) => boolean
  onDropTarget?: (entry: CloudDriveEntry, event: ReactDragEvent<HTMLElement>) => void
  /**
   * Enter/Space/F2/Delete/Ctrl+A/Esc/Shift+F10, answered by the page because each one opens
   * a surface the layout does not own. Returns true when the key was consumed.
   */
  onKeyCommand: (event: ReactKeyboardEvent<HTMLElement>, entry: CloudDriveEntry) => boolean
}

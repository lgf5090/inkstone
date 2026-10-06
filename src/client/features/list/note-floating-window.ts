import { getVisibleViewport } from '../../lib/viewport'
import { pinnedWindowSize } from '../../lib/pinned-window-size'
import { usePinnedWindows } from '../../store/pinned-windows'
import type { NoteSummary } from '@shared/types'

const FLOAT_WINDOW_MARGIN = 8

export function openNoteFloatingWindow(note: NoteSummary, rowRect?: DOMRect | null): void {
  const pinned = usePinnedWindows.getState()
  if (pinned.focusPinnedByNote(note.id)) return
  const viewport = getVisibleViewport()
  const { width, height } = pinnedWindowSize()
  const maxX = Math.max(viewport.left, viewport.right - width - FLOAT_WINDOW_MARGIN)
  const maxY = Math.max(viewport.top, viewport.bottom - height - FLOAT_WINDOW_MARGIN)
  const x = Math.max(viewport.left, Math.min(rowRect?.left ?? maxX, maxX))
  const y = Math.min(rowRect?.top ?? viewport.top + FLOAT_WINDOW_MARGIN, maxY)
  pinned.pin(
    {
      anchor: document.createElement('span'),
      title: note.title,
      noteId: note.id,
      missing: false,
      headline: note.title,
    },
    new DOMRect(x, y, width, height),
  )
}

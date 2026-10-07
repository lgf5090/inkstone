import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import {
  destroyKanbans,
  flushKanbans,
  mountKanbans,
  openKanbanSession,
  subscribeKanbans,
  type KanbanSession,
} from '../../lib/markdown/kanban'
import { registerFenceBodies, type FenceBodies } from '../../lib/markdown/fence-bodies'
import { createKanbanWriter } from './kanban-sync'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { renderMarkdown } from '../../lib/markdown/renderer'

export interface KanbanFullscreenState {
  session: KanbanSession
}

interface UseKanbanBlocksOptions {
  scope: string
  noteId: string | null
  hostRef: RefObject<HTMLDivElement | null>
  committedHtml: string
  /**
   * The fence bodies this markup was rendered from (P-01), registered on the host before mount. Also a
   * mount trigger: a body-only edit leaves the markup string identical.
   *
   * Null until the pane has committed markup for the first time. Mounting before that reads an empty
   * fence set, and the root takes its data into `useState` — a later pass carrying the real body cannot
   * reach that state, so the board would go on showing the empty one it parsed first.
   */
  fences: FenceBodies | null
}

/**
 * Runs a card description through the very renderer the note body uses, so the preview is the note's
 * own surface rather than a second markdown implementation. Module-level and therefore stable: the
 * board root is memoized, and a fresh closure per render would repaint every mounted board.
 *
 * That render gets none of the document's fence bodies: the preview lives in a modal, portaled out of
 * the host, so a block nested in a description has no registered element above it to read either way.
 */
function renderKanbanDescription(source: string): string {
  return renderMarkdown(source, { hideFrontMatter: true }).html
}

export function useKanbanBlocks(options: UseKanbanBlocksOptions) {
  const { scope, noteId, hostRef, committedHtml, fences } = options
  const writer = useMemo(() => createKanbanWriter(noteId), [noteId])
  const [fullscreen, setFullscreen] = useState<KanbanFullscreenState | null>(null)
  const fullscreenRef = useRef(fullscreen)
  fullscreenRef.current = fullscreen

  const openFullscreen = useCallback((node: HTMLElement) => {
    const session = openKanbanSession(node)
    if (session) setFullscreen({ session })
  }, [])

  const closeFullscreen = useCallback(() => {
    // The overlay's own cleanup moves the canvas back and flushes the session;
    // this only takes the modal out of the tree.
    setFullscreen(null)
  }, [])

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host || !fences) return
    // The host carries the markup it was just given, so the bodies go on the same element.
    registerFenceBodies(host, fences)
    void mountKanbans(host, {
      scope,
      noteId,
      editable: true,
      writeBack: writer,
      onOpenFullscreen: openFullscreen,
      onCloseFullscreen: closeFullscreen,
      renderDescription: renderKanbanDescription,
    }).catch((err: unknown) => {
      console.warn('[inkstone] kanban mount failed', err)
    })
  }, [committedHtml, fences, noteId, scope, writer, hostRef, openFullscreen, closeFullscreen])

  useKanbanTeardown(scope, setFullscreen, fullscreenRef)

  return { fullscreen, openFullscreen, closeFullscreen }
}

/**
 * The pane's two jobs around a board that went away.
 *
 * The registry disposes a block's React root when the document stops holding it — the fence deleted in
 * the editor, or the preview re-rendered without it — and announces that on the prune path. The overlay
 * used to survive it as an empty stage: a blank dialog the reader could only escape, with nothing saying
 * the board was gone (review K-04). So a notification closes the overlay and says why, reading the open
 * session off a ref so the listener needs no dependency on it and keeps one identity for the pane's life.
 *
 * A pane being torn down disposes its boards too, and that is not a removal the reader needs to hear
 * about — hence the order below: unsubscribe first, then flush and destroy.
 */
function useKanbanTeardown(
  scope: string,
  setFullscreen: Dispatch<SetStateAction<KanbanFullscreenState | null>>,
  fullscreenRef: RefObject<KanbanFullscreenState | null>,
): void {
  useEffect(() => {
    const unsubscribe = subscribeKanbans(() => {
      const open = fullscreenRef.current
      if (!open || open.session.isAlive()) return
      setFullscreen(null)
      useUi.getState().toast({ title: t('preview.kanban_board_removed'), tone: 'danger' })
    })
    return () => {
      unsubscribe()
      flushKanbans(scope)
      destroyKanbans(scope)
      setFullscreen(null)
    }
  }, [scope, setFullscreen, fullscreenRef])
}

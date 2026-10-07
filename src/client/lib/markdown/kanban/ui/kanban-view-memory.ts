import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type RefObject, type UIEvent } from 'react'
import type { TimelineZoom } from '../timeline-helpers'

/**
 * What the reader last left each view looking like: the columns or groups they folded away, the scale
 * they read a time view at, and how far the board was scrolled sideways.
 *
 * None of it is the board's own shape, so none of it goes into the fence. A write to a view rewrites
 * the whole note (`write.ts`), and folding a column is a reading gesture rather than an edit to the
 * document — which is the reason the time views have never asked the fence for their scale either. What
 * was actually wrong was narrower: the folds and the scale lived in the views' own `useState`, so
 * looking at another view and coming back threw them away, and because React reuses the component
 * instance when two views of the same type follow each other, one board's folds were carried over onto
 * the next board. They live here instead, for as long as this board is mounted: switching views and
 * going full screen keep them (the overlay borrows the same canvas), reopening the note starts clean,
 * and no reader's folds are imposed on anybody else reading the same fence.
 */
export interface KanbanViewMemoryStore {
  foldsOf: (viewId: string) => ReadonlySet<string>
  toggleFold: (viewId: string, groupKey: string) => void
  zoomOf: (viewId: string) => TimelineZoom
  setZoom: (viewId: string, zoom: TimelineZoom) => void
  /** Where the board was scrolled to. Read on mount only, so it is a plain number rather than state. */
  scrollOf: (viewId: string) => number
  rememberScroll: (viewId: string, offset: number) => void
}

/**
 * One view's half of the store: what a view is handed instead of the whole board's memory, so it takes
 * the three answers it needs rather than six it does not.
 */
export interface KanbanViewMemory {
  folds: ReadonlySet<string>
  toggleFold: (groupKey: string) => void
  zoom: TimelineZoom
  setZoom: (zoom: TimelineZoom) => void
  scrollOf: () => number
  rememberScroll: (offset: number) => void
}

/** The scale a view opens at until the reader picks another one. */
export const DEFAULT_TIMELINE_ZOOM: TimelineZoom = 'day'

// One shared empty set: a view with no folds hands the same identity to every column it draws, so a
// fold made in another view cannot repaint this one.
const NO_FOLDS: ReadonlySet<string> = new Set<string>()

export const KanbanViewMemoryScope = createContext<KanbanViewMemoryStore | null>(null)

export function useKanbanViewMemoryStore(): KanbanViewMemoryStore {
  const [folds, setFolds] = useState<Record<string, ReadonlySet<string>>>({})
  const [zooms, setZooms] = useState<Record<string, TimelineZoom>>({})
  const scrolls = useRef(new Map<string, number>())

  const toggleFold = useCallback((viewId: string, groupKey: string) => {
    setFolds((prev) => {
      const next = new Set(prev[viewId] ?? [])
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
      return { ...prev, [viewId]: next }
    })
  }, [])

  const setZoom = useCallback((viewId: string, zoom: TimelineZoom) => {
    setZooms((prev) => (prev[viewId] === zoom ? prev : { ...prev, [viewId]: zoom }))
  }, [])

  // The store's identity changes when a fold or a scale does, which is what repaints the view that
  // made it; scrolling writes to a ref and repaints nothing.
  return useMemo(
    () => ({
      foldsOf: (viewId: string) => folds[viewId] ?? NO_FOLDS,
      toggleFold,
      zoomOf: (viewId: string) => zooms[viewId] ?? DEFAULT_TIMELINE_ZOOM,
      setZoom,
      scrollOf: (viewId: string) => scrolls.current.get(viewId) ?? 0,
      rememberScroll: (viewId: string, offset: number) => {
        scrolls.current.set(viewId, offset)
      },
    }),
    [folds, zooms, toggleFold, setZoom],
  )
}

/**
 * A view's own memory, out of the store the board provided. A view rendered outside a board — a test
 * mounting one view on its own — keeps its own store instead of crashing, which is the behaviour those
 * callers had before the board remembered anything.
 */
export function useKanbanViewMemory(viewId: string | undefined): KanbanViewMemory {
  const provided = useContext(KanbanViewMemoryScope)
  const own = useKanbanViewMemoryStore()
  const store = provided ?? own
  const id = viewId ?? ''
  return useMemo(
    () => ({
      folds: store.foldsOf(id),
      toggleFold: (groupKey: string) => store.toggleFold(id, groupKey),
      zoom: store.zoomOf(id),
      setZoom: (zoom: TimelineZoom) => store.setZoom(id, zoom),
      scrollOf: () => store.scrollOf(id),
      rememberScroll: (offset: number) => store.rememberScroll(id, offset),
    }),
    [store, id],
  )
}

/**
 * Puts the reader back where they were scrolled to, once, when a view mounts — and hands back the
 * handler that records where they are. The offset is read through a ref so the restore runs on mount
 * alone: keyed on the memory it would run again for every fold, jerking the board back sideways while
 * the reader is working in it. Horizontal only, because the board's own height is its shortest column's.
 */
export function useKanbanScrollMemory(
  ref: RefObject<HTMLElement | null>,
  memory: KanbanViewMemory,
): (event: UIEvent<HTMLElement>) => void {
  const { scrollOf, rememberScroll } = memory
  const read = useRef(scrollOf)
  read.current = scrollOf
  useEffect(() => {
    const node = ref.current
    if (node) node.scrollLeft = read.current()
  }, [ref])
  return useCallback((event: UIEvent<HTMLElement>) => rememberScroll(event.currentTarget.scrollLeft), [rememberScroll])
}

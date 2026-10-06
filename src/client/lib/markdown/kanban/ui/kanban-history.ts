import { useCallback, useEffect, useReducer, useRef, type RefObject } from 'react'
import type { KanbanData } from '../types'

/**
 * What a commit means for the way back — the rule the board's undo is built on, stated in two halves.
 *
 * `view` is a *lookup*: how an existing view shows the board, and which view is open. The search, the
 * filters, the tags, the sort, the size of a card, which columns a table hides, which columns a card
 * prints, what the board groups or swimlanes by, how a chart is drawn, and `activeViewId`. A lookup is
 * written into the document exactly like an edit — that is what keeps it across a reload and lets a
 * second reader open the same view — but it does not take a step: a reader who narrows a board ten times
 * and then presses Ctrl+Z means the last *edit* they made, not a walk back through ten lookups. Before
 * this, a handful of filters could push a session's real edits off the end of the thirty-step history.
 *
 * `edit` is everything else, and takes a step: a card, a subtask, a comment, a column or one of its
 * options, the board's title, and which views exist (the tab strip's create, rename, duplicate, delete
 * and move — the delete toast's undo is built on the delete being a step at all).
 *
 * The halves split by *who is changing*, not by which field is under the cursor, so a field added to a
 * view later needs no decision made about it: dropping its write through `useKanbanViewState` (or
 * beside it, as the grouping picker does) is the whole answer.
 *
 * The price is stated rather than hidden: undo restores a whole document state, so a lookup made after
 * the last edit does not survive the undo either. Keeping it would mean storing the view half of every
 * snapshot apart from the rest and re-applying it on the way back — a second history model to keep in
 * step with the first, for a case a reader can already redo by touching the chip again.
 */
export type KanbanCommitKind = 'edit' | 'view'

export type CommitKanbanData = (
  next: KanbanData | ((prev: KanbanData) => KanbanData),
  kind?: KanbanCommitKind,
) => void

const MAX_HISTORY_STEPS = 30

interface HistoryState {
  data: KanbanData
  past: KanbanData[]
  future: KanbanData[]
}

type HistoryAction =
  | { type: 'commit'; next: KanbanData; kind: KanbanCommitKind }
  | { type: 'undo' }
  | { type: 'redo' }

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  if (action.type === 'commit') {
    if (action.next === state.data) return state
    // A view commit replaces the newest state in place: the step lists are the record of what the board
    // *holds*, and which tab was open when a card was edited is not part of that record.
    if (action.kind === 'view') return { ...state, data: action.next }
    return {
      data: action.next,
      past: [...state.past.slice(-(MAX_HISTORY_STEPS - 1)), state.data],
      future: [],
    }
  }
  if (action.type === 'undo') {
    if (state.past.length === 0) return state
    const previous = state.past[state.past.length - 1]
    return {
      data: previous,
      past: state.past.slice(0, -1),
      future: [state.data, ...state.future.slice(0, MAX_HISTORY_STEPS - 1)],
    }
  }
  if (action.type === 'redo') {
    if (state.future.length === 0) return state
    const next = state.future[0]
    return {
      data: next,
      past: [...state.past.slice(-(MAX_HISTORY_STEPS - 1)), state.data],
      future: state.future.slice(1),
    }
  }
  return state
}

// Listening on the instance container (not window) keeps Ctrl+Z with the board
// that actually owns the focused element: focus on the surrounding note or on a
// second board must not undo this instance's history.
function useHistoryKeyboardShortcuts(
  undo: () => void,
  redo: () => void,
  containerRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return

      const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)
      const modKey = isMac ? e.metaKey : e.ctrlKey
      if (!modKey) return

      if (e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (e.key.toLowerCase() === 'y' && !isMac) {
        e.preventDefault()
        redo()
      }
    }

    container.addEventListener('keydown', handleKeyDown)
    return () => container.removeEventListener('keydown', handleKeyDown)
  }, [undo, redo, containerRef])
}

/**
 * The history's own refs: the newest state, the newest callback — the things a commit resolved at
 * write time needs to read rather than the render it happened to be called from.
 */
function useKanbanHistoryRefs(state: HistoryState, onUpdateData: (next: KanbanData) => void) {
  const dataRef = useRef(state.data)
  dataRef.current = state.data
  const historyRef = useRef(state)
  historyRef.current = state
  const onUpdateRef = useRef(onUpdateData)
  onUpdateRef.current = onUpdateData
  return { dataRef, historyRef, onUpdateRef }
}

export function useKanbanHistory(
  initialData: KanbanData,
  onUpdateData: (next: KanbanData) => void,
  containerRef: RefObject<HTMLElement | null>,
) {
  const [state, dispatch] = useReducer(historyReducer, {
    data: initialData,
    past: [],
    future: [],
  })

  const { dataRef, historyRef, onUpdateRef } = useKanbanHistoryRefs(state, onUpdateData)

  const commitData = useCallback<CommitKanbanData>(
    (nextOrUpdater, kind = 'edit') => {
      const next = typeof nextOrUpdater === 'function' ? nextOrUpdater(dataRef.current) : nextOrUpdater
      // The same reference the state already holds is the reducer's no-op (KU-21c's edge steps and
      // refusals ride on it), and a no-op must not reach the note either — the write pipeline would
      // refuse it at serialization, but the callback would still fire and dirty the block.
      if (next !== dataRef.current) onUpdateRef.current(next)
      dispatch({ type: 'commit', next, kind })
    },
    [],
  )

  const undo = useCallback(() => {
    const previous = historyRef.current.past.at(-1)
    if (!previous) return
    dispatch({ type: 'undo' })
    onUpdateRef.current(previous)
  }, [])

  const redo = useCallback(() => {
    const next = historyRef.current.future[0]
    if (!next) return
    dispatch({ type: 'redo' })
    onUpdateRef.current(next)
  }, [])

  useHistoryKeyboardShortcuts(undo, redo, containerRef)

  return {
    data: state.data,
    commitData,
    undo,
    redo,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  }
}

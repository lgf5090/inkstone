/**
 * The state behind the shelf of kept answers.
 *
 * The press that keeps a turn lives in `assistant-store.ts` (`toggleMessageSaved`), because it paints the
 * bubble the reader just pressed. This is the other half: a paged list the sidebar opens on demand, whose
 * rows point into threads the reader is not in. It is kept apart for that reason and because a transcript
 * store should not carry a second list's paging state — the rows here go nowhere near `messages`.
 *
 * Paging follows the store's own habit: the cursor is whatever the last page handed back, one request is in
 * flight at a time, and a page that arrives after the reader re-read the shelf is dropped rather than
 * appended to a list they have already left.
 */
import { create } from 'zustand'
import type { SavedMessage } from '@shared/assistant'
import { ApiError, api } from '../../lib/api'

/**
 * Why the shelf is showing its failure block.
 *
 * `detail` is the route's own sentence about what it refused — the same half `describeFailure` splits out
 * for the settings forms — and it is the only thing a reader can act on when the app's own headline says
 * nothing they did not already know.
 */
export interface ShelfFailure {
  detail: string | null
}

export interface SavedShelfState {
  /** The rows read so far, newest kept first. Null until a page has been answered, which is what tells a
   * spinner apart from an empty shelf. */
  items: SavedMessage[] | null
  failure: ShelfFailure | null
  cursor: string | null
  hasMore: boolean
  loadingMore: boolean
  /** Reads the first page again. Safe to press from a failure block: it clears the reason first. */
  load: () => Promise<void>
  /** Asks for the page after the one already on screen, and does nothing without a cursor to resume from. */
  loadMore: () => Promise<void>
}

/** Bumped by every fresh read, so a page still in flight can see it no longer belongs to the shelf. */
let readSequence = 0

function failureFor(error: unknown): ShelfFailure {
  // A refused read is not an empty shelf: the keeps are still stored, and what the route said is the only
  // part of this the reader could not work out alone.
  return { detail: error instanceof ApiError ? error.serverMessage ?? null : null }
}

export const useSavedShelf = create<SavedShelfState>((set, get) => ({
  items: null,
  failure: null,
  cursor: null,
  hasMore: false,
  loadingMore: false,

  load: async () => {
    const token = ++readSequence
    set({ failure: null })
    try {
      const page = await api.assistant.savedMessages()
      if (token !== readSequence) return
      set({
        items: page.items,
        cursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
        loadingMore: false,
      })
    } catch (error) {
      if (token !== readSequence) return
      set({ items: null, failure: failureFor(error), loadingMore: false })
    }
  },

  loadMore: async () => {
    const state = get()
    // The scroll handler and a repeated press both get here; a second request would ask for the same page.
    if (!state.hasMore || state.loadingMore || !state.cursor) return
    const token = readSequence
    set({ loadingMore: true })
    try {
      const page = await api.assistant.savedMessages({ cursor: state.cursor })
      if (token !== readSequence) return
      const rows = get().items ?? []
      const seen = new Set(rows.map((row) => row.id))
      set({
        items: [...rows, ...page.items.filter((row) => !seen.has(row.id))],
        cursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
        loadingMore: false,
      })
    } catch (error) {
      // The rows already on screen are real, so they stay; what failed is the next page, and the reason is
      // said rather than swallowed.
      if (token !== readSequence) return
      set({ failure: failureFor(error), loadingMore: false })
    }
  },
}))

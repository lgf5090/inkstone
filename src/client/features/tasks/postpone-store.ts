import { create } from 'zustand'
import type { MenuItem } from '../../components/overlay'

/**
 * The postpone menu a task row asked for.
 *
 * The rows arrive already built, because the row that was clicked is the only place the parsed task
 * exists: a `tasks` block is imperative DOM, and re-reading the note to redraw a menu the caller could
 * have handed over would be a network round trip for information already in hand. The host owns the
 * overlay — focus, escape, click-away — and nothing else.
 */
export interface PostponeMenuRequest {
  x: number
  y: number
  items: MenuItem[]
}

interface PostponeMenuState {
  request: PostponeMenuRequest | null
  open: (request: PostponeMenuRequest) => void
  close: () => void
}

export const usePostponeMenu = create<PostponeMenuState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}))

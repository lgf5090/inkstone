/**
 * The prompt's open/close state. It is a store rather than a `PanelName` because the reference plugin
 * stacks the in-file search over the vault search, and because a note can be opened from a keyboard
 * chord while another panel is already up.
 */
import { create } from 'zustand'

export type OmnisearchMode = 'vault' | 'file'

export interface OmnisearchOpenInit {
  mode?: OmnisearchMode
  seed?: string
  /** The note an in-file search runs against; the active note when it is missing. */
  noteId?: string | null
}

interface OmnisearchState {
  open: boolean
  mode: OmnisearchMode
  seed: string
  noteId: string | null
  show: (init?: OmnisearchOpenInit) => void
  hide: () => void
}

export const useOmnisearch = create<OmnisearchState>((set) => ({
  open: false,
  mode: 'vault',
  seed: '',
  noteId: null,
  show: (init) => set({
    open: true,
    mode: init?.mode ?? 'vault',
    seed: init?.seed ?? '',
    noteId: init?.noteId ?? null,
  }),
  hide: () => set({ open: false, seed: '', noteId: null }),
}))

export function openOmnisearch(init: OmnisearchOpenInit = {}): void {
  useOmnisearch.getState().show(init)
}

export function closeOmnisearch(): void {
  useOmnisearch.getState().hide()
}

export function isOmnisearchOpen(): boolean {
  return useOmnisearch.getState().open
}

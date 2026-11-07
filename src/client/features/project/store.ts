/** The project tab's board list: what this account can open, and whether the last read succeeded. */
import { create } from 'zustand'
import type { ProjectBoardSummary } from '@shared/project/model'
import { fetchProjectBoards } from './api'

export type ProjectBoardsStatus = 'idle' | 'loading' | 'ready' | 'error'

interface ProjectState {
  boards: ProjectBoardSummary[]
  boardsStatus: ProjectBoardsStatus
  boardsError: string | null
  loadBoards: () => Promise<void>
  ensureBoards: () => void
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  boards: [],
  boardsStatus: 'idle',
  boardsError: null,

  async loadBoards() {
    set({ boardsStatus: 'loading', boardsError: null })
    try {
      set({ boards: await fetchProjectBoards(), boardsStatus: 'ready' })
    } catch (error) {
      set({
        boardsStatus: 'error',
        boardsError: error instanceof Error && error.message ? error.message : String(error),
      })
    }
  },

  ensureBoards() {
    const status = get().boardsStatus
    if (status === 'idle' || status === 'error') void get().loadBoards()
  },
}))

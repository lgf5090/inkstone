/** The project tab's board list: what this account can open, and whether the last read succeeded. */
import { create } from 'zustand'
import type { ProjectBoardSummary } from '@shared/project/model'
import {
  createBoardFromTemplate,
  createProjectBoard,
  deleteProjectBoard,
  duplicateProjectBoard,
  fetchProjectBoards,
  importProjectArchive,
  patchProjectBoard,
  renameProjectBoard,
} from './api'
import { readRandomIconPref, randomProjectIcon } from './project-icon'

export type ProjectBoardsStatus = 'idle' | 'loading' | 'ready' | 'error'

interface ProjectState {
  boards: ProjectBoardSummary[]
  boardsStatus: ProjectBoardsStatus
  boardsError: string | null
  loadBoards: () => Promise<void>
  ensureBoards: () => void
  addBoard: (title: string) => Promise<ProjectBoardSummary>
  /** Every way a board comes into existence goes through the store, or the sidebar misses it. */
  addBoardFromTemplate: (templateId: string, locale: string) => Promise<ProjectBoardSummary>
  addBoardFromArchive: (bytes: Uint8Array) => Promise<ProjectBoardSummary>
  removeBoard: (id: string) => Promise<void>
  copyBoard: (id: string) => Promise<ProjectBoardSummary>
  renameBoard: (id: string, title: string) => Promise<void>
  setBoardIcon: (id: string, icon: string) => Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
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
      set({ boardsStatus: 'error', boardsError: errorMessage(error) })
    }
  },

  ensureBoards() {
    const status = get().boardsStatus
    if (status === 'idle' || status === 'error') void get().loadBoards()
  },

  async addBoard(title) {
    const board = await createProjectBoard(readRandomIconPref() ? { title, icon: await randomProjectIcon() } : { title })
    set((state) => ({ boards: [board, ...state.boards] }))
    return board
  },

  async addBoardFromTemplate(templateId, locale) {
    const board = await createBoardFromTemplate(templateId, locale)
    set((state) => ({ boards: [board, ...state.boards] }))
    return board
  },

  async addBoardFromArchive(bytes) {
    const board = await importProjectArchive(bytes)
    set((state) => ({ boards: [board, ...state.boards] }))
    return board
  },

  async removeBoard(id) {
    await deleteProjectBoard(id)
    set((state) => ({ boards: state.boards.filter((board) => board.id !== id) }))
  },

  async copyBoard(id) {
    const board = await duplicateProjectBoard(id)
    set((state) => ({ boards: [board, ...state.boards] }))
    return board
  },

  async setBoardIcon(id, icon) {
    const result = await patchProjectBoard(id, { icon })
    set((state) => ({
      boards: state.boards.map((entry) => (entry.id === id ? { ...entry, icon: result.board.icon } : entry)),
    }))
  },

  async renameBoard(id, title) {
    const board = await renameProjectBoard(id, title)
    set((state) => ({
      boards: state.boards.map((entry) => (entry.id === id ? { ...entry, title: board.title } : entry)),
    }))
  },
}))
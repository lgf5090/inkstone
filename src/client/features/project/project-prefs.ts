import { useSession } from '../../store/session'

const PINNED_BOARDS_KEY = 'inkstone.project.pinnedBoards'
const STARRED_BOARDS_KEY = 'inkstone.project.starredBoards'

/**
 * The reader's board marks, kept in the account settings so they follow the reader across devices.
 * The toggle reads the live store rather than a captured list, so two quick clicks cannot lose one.
 */
export function useProjectBoardMarks(): {
  pinned: string[]
  starred: string[]
  togglePin: (boardId: string) => void
  toggleStar: (boardId: string) => void
} {
  const pinned = useSession((state) => state.settings.project.pinnedBoards)
  const starred = useSession((state) => state.settings.project.starredBoards)
  const togglePin = (boardId: string): void => {
    const current = useSession.getState().settings.project.pinnedBoards
    const next = current.includes(boardId) ? current.filter((id) => id !== boardId) : [...current, boardId]
    useSession.getState().updateSettings({ project: { pinnedBoards: next } })
  }
  const toggleStar = (boardId: string): void => {
    const current = useSession.getState().settings.project.starredBoards
    const next = current.includes(boardId) ? current.filter((id) => id !== boardId) : [...current, boardId]
    useSession.getState().updateSettings({ project: { starredBoards: next } })
  }
  return { pinned, starred, togglePin, toggleStar }
}

/**
 * Move marks a reader kept in this browser's storage into the account, once. Only an empty account
 * slot is filled, so a mark already synced from another device is never overwritten by a stale local
 * one; the local keys are cleared either way so the move is not attempted again.
 */
export function migrateProjectBoardMarks(): void {
  const state = useSession.getState()
  if (state.status !== 'authed') return
  const pinned = readPinnedBoardsPref()
  const starred = readStarredBoardsPref()
  if (pinned.length === 0 && starred.length === 0) return
  const current = state.settings.project
  const patch: { pinnedBoards?: string[], starredBoards?: string[] } = {}
  if (pinned.length > 0 && current.pinnedBoards.length === 0) patch.pinnedBoards = pinned
  if (starred.length > 0 && current.starredBoards.length === 0) patch.starredBoards = starred
  try {
    localStorage.removeItem(PINNED_BOARDS_KEY)
    localStorage.removeItem(STARRED_BOARDS_KEY)
  } catch { /* best-effort: a blocked storage leaves the keys for the next mount to move */ }
  if (Object.keys(patch).length > 0) state.updateSettings({ project: patch })
}

function readArrayPref(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function writeArrayPref(key: string, items: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(items))
  } catch { /* best-effort: a full or blocked storage loses the pin, not the board */ }
}

export function readPinnedBoardsPref(): string[] {
  return readArrayPref(PINNED_BOARDS_KEY)
}

export function writePinnedBoardsPref(boardIds: string[]): void {
  writeArrayPref(PINNED_BOARDS_KEY, boardIds)
}

export function readStarredBoardsPref(): string[] {
  return readArrayPref(STARRED_BOARDS_KEY)
}

export function writeStarredBoardsPref(boardIds: string[]): void {
  writeArrayPref(STARRED_BOARDS_KEY, boardIds)
}

const SIDEBAR_WIDTH_KEY = 'inkstone.project.sidebarWidth'
const SIDEBAR_OPEN_KEY = 'inkstone.project.sidebarOpen'

export const PROJECT_SIDEBAR_MIN_WIDTH = 200
export const PROJECT_SIDEBAR_MAX_WIDTH = 420
export const PROJECT_SIDEBAR_DEFAULT_WIDTH = 240

/** The width the reader last dragged to, clamped so a stored value cannot collapse the tree. */
export function readSidebarWidthPref(): number {
  try {
    const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    if (!Number.isFinite(raw) || raw <= 0) return PROJECT_SIDEBAR_DEFAULT_WIDTH
    return Math.min(PROJECT_SIDEBAR_MAX_WIDTH, Math.max(PROJECT_SIDEBAR_MIN_WIDTH, Math.round(raw)))
  } catch { /* storage unavailable: the default width is a usable sidebar */
    return PROJECT_SIDEBAR_DEFAULT_WIDTH
  }
}

export function writeSidebarWidthPref(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.min(PROJECT_SIDEBAR_MAX_WIDTH, Math.max(PROJECT_SIDEBAR_MIN_WIDTH, Math.round(width)))))
  } catch { /* best-effort: a blocked storage loses the width, not the boards */ }
}

/** Open unless the reader explicitly closed it: a board page without its tree is the rarer choice. */
export function readSidebarOpenPref(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_OPEN_KEY) !== '0'
  } catch { /* storage unavailable: fall back to the open default */
    return true
  }
}

export function writeSidebarOpenPref(open: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_OPEN_KEY, open ? '1' : '0')
  } catch { /* best-effort: remembering the toggle is optional */ }
}

const STARRED_CARDS_KEY = 'inkstone.project.starredCards.'
const PINNED_CARDS_KEY = 'inkstone.project.pinnedCards.'

/** Card pins and stars are per board: a card id means nothing on another one. */
export function readStarredCardsPref(boardId: string): string[] {
  return readArrayPref(STARRED_CARDS_KEY + boardId)
}

export function writeStarredCardsPref(boardId: string, cardIds: string[]): void {
  writeArrayPref(STARRED_CARDS_KEY + boardId, cardIds)
}

export function readPinnedCardsPref(boardId: string): string[] {
  return readArrayPref(PINNED_CARDS_KEY + boardId)
}

export function writePinnedCardsPref(boardId: string, cardIds: string[]): void {
  writeArrayPref(PINNED_CARDS_KEY + boardId, cardIds)
}

const BOARD_LIST_LAYOUT_KEY = 'inkstone.project.boardListLayout'

/** The board list remembers whether the reader left it as rows or as cards. */
export function readBoardListLayoutPref(): 'list' | 'cards' {
  try {
    return localStorage.getItem(BOARD_LIST_LAYOUT_KEY) === 'cards' ? 'cards' : 'list'
  } catch { /* storage unavailable: rows are the default */
    return 'list'
  }
}

export function writeBoardListLayoutPref(layout: 'list' | 'cards'): void {
  try {
    localStorage.setItem(BOARD_LIST_LAYOUT_KEY, layout)
  } catch { /* best-effort: a blocked storage loses the preference, not the boards */ }
}

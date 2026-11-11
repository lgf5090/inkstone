const PINNED_BOARDS_KEY = 'inkstone.project.pinnedBoards'
const STARRED_BOARDS_KEY = 'inkstone.project.starredBoards'

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
